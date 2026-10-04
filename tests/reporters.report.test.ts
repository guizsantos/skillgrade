import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { errored, harmonize, loadRuns, summary, wilson } from '../src/reporters/report';

const apiError = { trial_id: -1, reward: 0, grader_results: [], duration_ms: 0, n_commands: 0, input_tokens: 0, output_tokens: 0,
    session_log: [{ type: 'agent_result', timestamp: '', output: 'API Error: 400 Model not found' }] };

/** One report per run: `rewards` as valid trials, plus one errored trial that must not count. */
async function summ(...runs: [string, string, number[], string?][]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-report-'));
    for (const [runId, skillCommit, rewards, model = 'm'] of runs) {
        const trials = [...rewards.map((reward, i) => ({ trial_id: i, reward, grader_results: [] })), apiError];
        await fs.writeJSON(path.join(dir, `t_${runId}.json`), {
            task: 't', trials,
            provenance: { run_id: runId, commit: 'c'.repeat(40), model, skill_commit: skillCommit, eval_commit: 'e1', dirty: [] },
        });
    }
    return summary('s', await loadRuns(dir));
}

describe('summary', () => {
    it('reports the delta between skill versions and whether it is beyond noise', async () => {
        const s = await summ(['1-a', 'old', [0, 0.5, 0, 0.5, 0]], ['2-a', 'new', [1, 1, 1, 0.5, 1]], ['3-a', 'new', [1]]);
        expect(s.delta).toBeCloseTo(0.72, 2);  // 0.92 over 6 vs 0.20 over 5
        expect(s.verdict).toMatch(/^better \(beyond/);
        expect(s.trials_needed).toBe(0);
        expect(s.runs[0].errored).toBe(1);
        expect(s.versions.at(-1).unbalanced).toBe(false);
        expect(s.versions.at(-1).tasks).toEqual({ t: 6 });
    });

    it('calls a small delta noise, and too few trials too few', async () => {
        expect((await summ(['1', 'old', [1, 0, 1, 0, 1]], ['2', 'new', [0, 1, 1, 0, 1]])).verdict).toContain('within noise');
        expect((await summ(['1', 'old', [0]], ['2', 'new', [1]])).verdict).toContain('too few trials');
    });

    it('does not compare runs on another model', async () => {
        const s = await summ(['1', 'new', [1]], ['2', 'old', [0], 'other-model']);
        expect(s.versions).toHaveLength(1);
        expect(s.delta).toBeNull();
        expect(s.runs[0].comparable).toBe(false);
    });

    it('does not compare runs made on uncommitted changes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-report-'));
        for (const [id, dirty] of [['1', []], ['2', [' M SKILL.md']]] as const) {
            await fs.writeJSON(path.join(dir, `t_${id}.json`), { task: 't', trials: [{ trial_id: 1, reward: 1, grader_results: [] }],
                provenance: { run_id: id, skill_commit: 'a', eval_commit: 'e', model: 'm', dirty } });
        }
        const s = summary('s', await loadRuns(dir));
        expect(s.runs.map((r: any) => r.comparable)).toEqual([true, false]);
        expect(s.versions[0].n).toBe(1);
    });

    it('groups reports by run id, and treats a report without provenance as its own run', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-report-'));
        const prov = { run_id: '20260101T000000Z-abc', skill_commit: 'a', eval_commit: 'e', model: 'm', dirty: [] };
        await fs.writeJSON(path.join(dir, 'a_2026-01-01T00-00-01-000Z.json'), { task: 'a', trials: [], provenance: prov });
        await fs.writeJSON(path.join(dir, 'b_2026-01-01T00-00-02-000Z.json'), { task: 'b', trials: [], provenance: prov });
        await fs.writeJSON(path.join(dir, 'a_2025-12-31T10-20-30-000Z.json'), { task: 'a', trials: [] });
        const runs = await loadRuns(dir);
        expect(runs.map(r => [r.id, r.tasks.length])).toEqual([['20251231T102030Z', 1], ['20260101T000000Z-abc', 2]]);
    });
});

describe('errored', () => {
    const log = (type: string, output: string) => ({ session_log: [{ type, output }], grader_results: [{}] }) as any;
    it('flags infrastructure failures, not the agent mentioning errors', () => {
        expect(errored(log('agent_result', 'Failed to authenticate. API Error: 403 Restricted\n'))).toBe(true);
        expect(errored(log('reward', 'Agent timed out after 900s'))).toBe(true);
        expect(errored(log('agent_result', 'Filed 3 captures; no API errors'))).toBe(false);
        expect(errored({ reward: 1 } as any)).toBe(false);
    });
    it('flags a trial that threw before any grader ran', () => {
        expect(errored({ grader_results: [], session_log: [{ type: 'reward', output: 'boom' }] } as any)).toBe(true);
    });
});

describe('wilson', () => {
    it('spans everything with no trials and stays inside [0, 1]', () => {
        expect(wilson(0, 0)).toEqual([0, 1]);
        expect(wilson(5, 5)[1]).toBe(1);
        expect(wilson(5, 5)[0]).toBeGreaterThan(0.5);
    });
});

describe('harmonize', () => {
    const h = (mode: 'pessimistic' | 'optimistic') => harmonize({ a: [1, 0, 1], b: [1, 0.5], c: [] }, mode)!;
    it('scores the same k trials from every task: the worst k or the best k', () => {
        expect(h('pessimistic').per_task).toBe(2);
        expect(h('pessimistic').mean).toBe((0 + 1 + 0.5 + 1) / 4);
        expect(h('optimistic').mean).toBe((1 + 1 + 0.5 + 1) / 4);
        expect(h('optimistic').left_out).toEqual(['c']);
        expect(harmonize({ a: [] })).toBeNull();
    });
});
