/**
 * Answers "is the skill better than before?" from a skill's result files.
 *
 * A run is every report sharing a `provenance.run_id`; a report from before
 * provenance was recorded is a run of its own. Versions are commits (see
 * core/provenance.ts). summary() compares skill versions on the runs that share
 * the latest run's eval version and model; anything else measures a different
 * test, not a different skill. A run evaluates a commit (`skillgrade` refuses
 * uncommitted inputs); reports from before that may carry `dirty` changes, and
 * are listed but never compared: no commit describes what they evaluated.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { EvalReport, TrialResult } from '../types';

// The agent never got to work, or was cut off by the infrastructure: an API
// error in its output (backend down, auth dropped), or skillgrade's time limit.
// Such a trial says nothing about the skill: excluded from scores, counted as errored.
const ERRORED = /API Error|^Not logged in|^--dangerously-skip-permissions cannot/;
const TIMED_OUT = /timed out after \d+s/;

export interface Run {
    id: string;
    tasks: [string, EvalReport][];   // [file name, report], by file name
    prov: Record<string, any>;
    trials: TrialResult[];           // valid trials only
    errored: number;
}

export interface Stats { mean: number; se: number | null; n: number }

export function agentOutput(trial: TrialResult): string {
    return (trial.session_log || []).find(e => e.type === 'agent_result')?.output || '';
}

export function errored(trial: TrialResult): boolean {
    // skillgrade's own failure path: the trial threw before any grader ran
    if (trial.grader_results && trial.grader_results.length === 0 && trial.session_log?.length) return true;
    const timedOut = (trial.session_log || []).some(e => e.type === 'reward' && TIMED_OUT.test(String(e.output || '')));
    return ERRORED.test(agentOutput(trial).trim()) || timedOut;
}

/** {check: passed} for one trial: a grader's `details.checks` when it emits them, one pseudo-check otherwise. */
export function checks(trial: TrialResult): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const g of trial.grader_results || []) {
        try {
            for (const c of JSON.parse(g.details).checks) out[c.check] = !!c.ok;
        } catch {
            out[g.grader_type || 'grader'] = (g.score || 0) >= 1;
        }
    }
    return out;
}

/** `<task>_2026-10-02T17-50-13-630Z.json` → `20261002T175013Z`, the id of a report without provenance. */
function fileStamp(file: string): string {
    const m = /(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(file);
    return m ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z` : file;
}

export async function loadRuns(resultsDir: string): Promise<Run[]> {
    const files = (await fs.readdir(resultsDir).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort();
    const byId = new Map<string, Run>();
    for (const file of files) {
        let report: EvalReport;
        try {
            report = await fs.readJSON(path.join(resultsDir, file));
        } catch {
            continue;  // malformed or half-written
        }
        const prov: Record<string, any> = report.provenance || {};
        const id = prov.run_id || fileStamp(file);
        let run = byId.get(id);
        if (!run) byId.set(id, run = { id, tasks: [], prov, trials: [], errored: 0 });
        run.tasks.push([file, report]);
        for (const t of report.trials || []) {
            if (errored(t)) run.errored++;
            else run.trials.push(t);
        }
    }
    // oldest first: ids start with the UTC timestamp
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Mean reward, standard error (null for one trial), n. */
export function stats(rewards: number[]): Stats {
    const n = rewards.length;
    const mean = rewards.reduce((a, x) => a + x, 0) / n;
    const se = n > 1 ? Math.sqrt(rewards.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) / n) : null;
    return { mean, se, n };
}

export function verdict(delta: number, seA: number, seB: number, nA: number, nB: number): string {
    if (nA < 2 || nB < 2) return 'too few trials to call — run `--smoke` (5) or more on both versions';
    const se = Math.hypot(seA, seB);
    if (se === 0) return delta > 0 ? 'better' : delta < 0 ? 'worse' : 'no change';
    if (Math.abs(delta) <= 2 * se) return `within noise (±${(2 * se).toFixed(2)} at ~95%)`;
    return `${delta > 0 ? 'better' : 'worse'} (beyond ±${(2 * se).toFixed(2)} noise, ~95%)`;
}

/** ~95% Wilson interval for k passes out of n; [0, 1] when n is 0. */
export function wilson(k: number, n: number, z = 2): [number, number] {
    if (n === 0) return [0, 1];
    const p = k / n;
    const c = (p + z * z / (2 * n)) / (1 + z * z / n);
    const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n);
    const round = (x: number) => Math.round(x * 1e9) / 1e9;
    return [Math.max(0, round(c - h)), Math.min(1, round(c + h))];
}

/**
 * A balanced score from {task: valid trial rewards}: the same number of trials
 * from every task, as many as the smallest task has (k), so no task weighs more.
 * Pessimistic keeps each task's worst k, optimistic its best k. Tasks with no
 * valid trial would make k 0, so they are left out, and named.
 */
export function harmonize(rewards: Record<string, number[]>, mode: 'pessimistic' | 'optimistic' = 'pessimistic') {
    const have = Object.entries(rewards).filter(([, r]) => r.length).map(([, r]) => [...r].sort((a, b) => a - b));
    if (!have.length) return null;
    const k = Math.min(...have.map(r => r.length));
    const picked = have.flatMap(r => mode === 'pessimistic' ? r.slice(0, k) : r.slice(-k));
    return { mode, per_task: k, ...stats(picked), left_out: Object.keys(rewards).filter(t => !rewards[t].length) };
}

/** (skill version, eval version) of a run. Reports without provenance share one of each. */
export function versions(prov: Record<string, any>): [string, string] {
    return [
        prov.skill_commit || prov.skill_md || 'unversioned',
        prov.eval_commit || (prov.eval_files ? JSON.stringify(prov.eval_files) : 'unversioned'),
    ];
}

const isDirty = (r: Run) =>  // legacy reports only
    (r.prov.dirty || []).length > 0;

/** Every run of a skill, and its skill versions compared on the runs comparable with the latest. */
export function summary(skill: string, runs: Run[], evalTasks: string[] = []) {
    const out: any = { skill, versions: [], delta: null, verdict: null, trials_needed: null, checks: [], runs: [], model: null };
    if (!runs.length) return out;
    const key = (r: Run) => JSON.stringify([versions(r.prov)[1], r.prov.model ?? null]);
    const latest = [...runs].reverse().find(r => !isDirty(r)) || runs[runs.length - 1];
    const comparable = (r: Run) => !isDirty(r) && key(r) === key(latest);
    out.model = latest.prov.model ?? null;
    const same = runs.filter(r => comparable(r) && r.trials.length);
    const byVersion = new Map<string, Run[]>();  // in order first seen
    for (const r of same) {
        const v = versions(r.prov)[0];
        byVersion.set(v, [...(byVersion.get(v) || []), r]);
    }
    const names = [...new Set(same.flatMap(r => r.trials.flatMap(t => Object.keys(checks(t)))))];
    out.checks = names;
    let prev: any = null;
    for (const [h, rs] of byVersion) {
        const trials = rs.flatMap(r => r.trials);
        const s = stats(trials.map(t => t.reward));
        const per: Record<string, any> = {};
        for (const c of names) {  // each check over the trials that ran it: a check belongs to one task
            const has = trials.map(checks).filter(x => c in x).map(x => x[c]);
            const k = has.filter(Boolean).length;
            const [lo, hi] = wilson(k, has.length);
            per[c] = { rate: has.length ? k / has.length : null, k, n: has.length, lo, hi };
        }
        // The score is the mean over all trials, so a task with more valid trials weighs more in it.
        const rewards: Record<string, number[]> = Object.fromEntries(evalTasks.map(t => [t, []]));
        for (const r of rs) for (const [, d] of r.tasks) {
            (rewards[d.task] ??= []).push(...(d.trials || []).filter(t => !errored(t)).map(t => t.reward));
        }
        const tasks = Object.fromEntries(Object.entries(rewards).map(([t, x]) => [t, x.length]));
        out.versions.push({
            version: h, commit: rs[0].prov.commit ?? null, runs: rs.map(r => r.id), ...s, checks: per,
            tasks, unbalanced: new Set(Object.values(tasks)).size > 1,
            harmonized: { pessimistic: harmonize(rewards, 'pessimistic'), optimistic: harmonize(rewards, 'optimistic') },
            delta: prev ? s.mean - prev.mean : null,
        });
        prev = out.versions[out.versions.length - 1];
    }
    const vs = out.versions;
    if (vs.length >= 2) {
        const a = vs[vs.length - 2], b = vs[vs.length - 1];
        const d = b.mean - a.mean;
        out.delta = d;
        out.verdict = verdict(d, b.se || 0, a.se || 0, b.n, a.n);
        if (d && a.n > 1 && b.n > 1) {
            // Equal n a side resolves |d| at 2 SE when n ≥ 8σ²/d², σ² the pooled trial variance.
            const v = (a.se ** 2 * a.n + b.se ** 2 * b.n) / 2;
            out.trials_needed = Math.max(0, Math.ceil(8 * v / d ** 2) - Math.min(a.n, b.n));
        }
    }
    for (const r of runs) {
        const [sv, ev] = versions(r.prov);
        out.runs.push({
            id: r.id, prov: r.prov, comparable: comparable(r), skill_version: sv, eval_version: ev,
            trials: r.trials.length, errored: r.errored,
            score: r.trials.length ? stats(r.trials.map(t => t.reward)).mean : null,
            tasks: r.tasks.map(([file, t]) => ({ file, task: t.task, pass_rate: t.pass_rate, pass_at_k: t.pass_at_k, pass_pow_k: t.pass_pow_k })),
        });
    }
    return out;
}
