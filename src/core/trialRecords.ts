/**
 * Trial Records: the contract skillgrade publishes (see docs/adr/0002).
 *
 * One self-sufficient record per trial, appended to `<run_id>.trials.jsonl`
 * beside the reports. Consumers compute mean, pass@k and pass^k from them, per
 * Harness, LLM and check, in any order. A record holds facts about the trial,
 * never session logs or agent output (large, and possibly sensitive).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import type { Provenance } from './provenance';
import type { EvalReport } from '../types';
import type { Resource } from './project';

/** Bump when a record's shape changes incompatibly. */
export const TRIAL_RECORD_SCHEMA_VERSION = 1;

/** The LLM field when the Harness does not report which model answered. */
export const HARNESS_DEFAULT_LLM = 'harness-default';

/** The Harness version field when it cannot be read. */
export const UNKNOWN_HARNESS_VERSION = 'unknown';

export interface CheckScore {
    /** Stable within an eval: grader type and its position among graders of that type. */
    check: string;
    score: number;
    weight: number;
}

/** How the Static Resource reached the Harness, and whether the Harness supports all of it. */
export interface Delivery {
    /** `subagent` | `project_instruction`; null when it does not apply (a Skill is not an Agent Definition). */
    agent_invocation: string | null;
    /** `full` | `degraded`. */
    harness_compatibility: string;
    /** Extension point: keys the Harness ignored, set when `degraded`. */
    ignored_keys?: string[];
}

export interface TrialRecord extends Delivery {
    schema_version: number;
    trial_record_id: string;
    run_id: string;
    resource_kind: string;
    resource_name: string;
    /** The resource's version: the last commit that touched it (null outside git). */
    version_hash: string | null;
    /** The eval's version, likewise. */
    eval_commit: string | null;
    eval: string;
    trial: number;
    harness: string;
    harness_version: string;
    llm: string;
    checks: CheckScore[];
    overall_score: number;
    date: string;
}

/** What one task's records are built from, beyond its report. */
export interface TrialRecordContext {
    resource: Pick<Resource, 'kind' | 'name'>;
    provenance: Pick<Provenance, 'run_id' | 'skill_commit' | 'eval_commit'>;
    harness: string;
    harnessVersion: string;
    /** The model the Harness reported, else the one it was told to use. */
    llm?: string | null;
    delivery: Delivery;
    date: Date;
}

/** The delivery values for a resource kind. Extension point for Agent Definitions. */
export function deliveryFor(kind: string): Delivery {
    void kind;  // every kind landed so far is a Skill: nothing to deliver as an agent, nothing unsupported
    return { agent_invocation: null, harness_compatibility: 'full' };
}

/** Deterministic: the same run, eval and trial always get the same id. */
export function trialRecordId(runId: string, kind: string, resource: string, evalName: string, trial: number): string {
    return `${runId}/${kind}/${resource}/${evalName}/${trial}`;
}

export function buildTrialRecords(report: EvalReport, ctx: TrialRecordContext): TrialRecord[] {
    const { resource, provenance } = ctx;
    return report.trials.map((t, i) => {
        const seen: Record<string, number> = {};
        const checks = t.grader_results.map(g => {
            const n = seen[g.grader_type] = (seen[g.grader_type] ?? -1) + 1;
            return { check: `${g.grader_type}-${n}`, score: g.score, weight: g.weight };
        });
        return {
            schema_version: TRIAL_RECORD_SCHEMA_VERSION,
            trial_record_id: trialRecordId(provenance.run_id, resource.kind, resource.name, report.task, i),
            run_id: provenance.run_id,
            resource_kind: resource.kind,
            resource_name: resource.name,
            version_hash: provenance.skill_commit,
            eval_commit: provenance.eval_commit,
            eval: report.task,
            trial: i,
            harness: ctx.harness,
            harness_version: ctx.harnessVersion,
            llm: ctx.llm || HARNESS_DEFAULT_LLM,
            ...ctx.delivery,
            checks,
            overall_score: t.reward,
            date: ctx.date.toISOString(),
        };
    });
}

/** Append records, one JSON object per line, to the run's file in `dir`. Returns the file. */
export async function appendTrialRecords(dir: string, runId: string, records: TrialRecord[]): Promise<string> {
    const file = path.join(dir, `${runId}.trials.jsonl`);
    await fs.ensureDir(dir);
    await fs.appendFile(file, records.map(r => JSON.stringify(r) + '\n').join(''));
    return file;
}

/** The CLI whose `--version` names the version of each Harness. Others have no version to read. */
const HARNESS_BINARIES: Record<string, string> = {
    'claude-code': 'claude',
    'gemini-cli': 'gemini',
    codex: 'codex',
    opencode: 'opencode',
};

/**
 * The version of the Harness CLI on this machine: its `--version` output, reduced
 * to the version number when it has one. `unknown` when it cannot be read (a
 * Harness with no CLI of its own, or one that runs in a Docker image).
 */
export function harnessVersion(harness: string, runtime: string): string {
    const bin = HARNESS_BINARIES[harness];
    if (!bin || runtime !== 'local') return UNKNOWN_HARNESS_VERSION;
    try {
        const out = execFileSync(bin, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
        const line = out.split('\n').map(l => l.trim()).find(Boolean) ?? '';
        return line.match(/\d+(?:\.\d+)+\S*/)?.[0] ?? (line || UNKNOWN_HARNESS_VERSION);
    } catch {
        return UNKNOWN_HARNESS_VERSION;
    }
}
