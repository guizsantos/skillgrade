import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { evalProject, evalYml, fakeAgent, greeterProject, passingGrader, skillMd, task } from './helpers/evalProject';

const score = (n: number) => passingGrader(`echo '{"score":${n},"details":"d"}'`);

describe('Trial Records emitted by a run', () => {
    it('writes <run_id>.trials.jsonl beside the reports, one record per trial, each with a schema_version', async () => {
        const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
        await fx.run({ trials: 3 });

        const [report] = await fx.reports('greeter');
        expect(await fx.trialRecordFiles('greeter')).toEqual([`${report.provenance!.run_id}.trials.jsonl`]);
        const records = await fx.trialRecords('greeter');
        expect(records).toHaveLength(3);
        for (const r of records) expect(r.schema_version).toEqual(expect.any(Number));
        expect(records.map(r => r.trial)).toEqual([0, 1, 2]);
    });

    it('carries the resource, its version, the harness, per-check scores, the overall score and the date', async () => {
        const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [
            task('say', { graders: [{ ...score(1), weight: 1 }, { ...score(0), weight: 3 }] }),
        ]));
        await fx.run();

        const [report] = await fx.reports('greeter');
        const [record] = await fx.trialRecords('greeter');
        expect(record).toMatchObject({
            run_id: report.provenance!.run_id,
            resource_kind: 'skill',
            resource_name: 'greeter',
            eval: 'say',
            version_hash: report.provenance!.skill_commit,
            eval_commit: report.provenance!.eval_commit,
            harness: 'command',
            overall_score: 0.25,
            checks: [
                { check: 'deterministic-0', score: 1, weight: 1 },
                { check: 'deterministic-1', score: 0, weight: 3 },
            ],
        });
        expect(record.version_hash).toBe(fx.git('log', '-1', '--format=%H', '--', 'skills/greeter'));
        expect(Date.parse(record.date)).not.toBeNaN();
        // present as keys, so a later ticket extends their values, not the shape
        expect(record).toHaveProperty('agent_invocation');
        expect(record).toHaveProperty('harness_compatibility');
    });

    it('records the values that apply to a Skill for agent_invocation and harness_compatibility', async () => {
        const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
        await fx.run();
        const [record] = await fx.trialRecords('greeter');
        expect(record.agent_invocation).toBeNull();
        expect(record.harness_compatibility).toBe('full');
    });

    describe('trial_record_id', () => {
        it('is made of the run id, the eval and the trial index, and differs per trial and eval', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [task('say'), task('wave')]));
            await fx.run({ trials: 2 });
            const records = await fx.trialRecords('greeter');
            expect(records).toHaveLength(4);
            for (const r of records) {
                expect(r.trial_record_id).toBe(`${r.run_id}/skill/greeter/${r.eval}/${r.trial}`);
            }
            expect(new Set(records.map(r => r.trial_record_id)).size).toBe(4);
        });

        it('is the same for the same run, eval and trial: it does not depend on scores or time', async () => {
            const make = (n: number) => evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [task('say', { graders: [score(n)] })]));
            const a = await make(1);
            const b = await make(0);
            await a.run();
            await b.run();
            const [ra] = await a.trialRecords('greeter');
            const [rb] = await b.trialRecords('greeter');
            // different repos and runs: only the run id part differs
            expect(ra.trial_record_id.replace(ra.run_id, '')).toBe(rb.trial_record_id.replace(rb.run_id, ''));
            expect(ra.trial_record_id).toBe(`${ra.run_id}/skill/greeter/say/0`);
        });
    });

    it('leaves out session logs and agent output', async () => {
        const OUT = 'AGENT-OUTPUT-MARKER';
        const fx = await evalProject(ctx => greeterProject(
            `${fakeAgent({ record: ctx.record })}; echo ${OUT}`,
            [task('say', { graders: [passingGrader(`echo '{"score":1,"details":"GRADER-DETAIL-${OUT}"}'`)] })],
        ));
        await fx.run();

        // the marker really is in the report's session log, so its absence below means something
        expect(JSON.stringify(await fx.reports('greeter'))).toContain(OUT);
        const records = await fx.trialRecords('greeter');
        expect(JSON.stringify(records)).not.toContain(OUT);
        for (const r of records) {
            expect(r).not.toHaveProperty('session_log');
            expect(r).not.toHaveProperty('output');
            expect(r).not.toHaveProperty('trials');
        }
    });

    describe('Harness version and LLM', () => {
        const savedPath = process.env.PATH;
        afterEach(() => { process.env.PATH = savedPath; });

        it('captures the version of the Harness once per run, on every record', async () => {
            const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-bin-'));
            const stub = path.join(bin, 'opencode');
            await fs.writeFile(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 9.9.9"; else cat >/dev/null; fi\n', { mode: 0o755 });
            process.env.PATH = `${bin}${path.delimiter}${savedPath}`;

            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [task('say'), task('wave')]));
            await fx.run({ harness: 'opencode', trials: 2 });

            const records = await fx.trialRecords('greeter');
            expect(records).toHaveLength(4);
            for (const r of records) expect(r).toMatchObject({ harness: 'opencode', harness_version: '9.9.9' });
        });

        it('records harness_version "unknown" rather than leaving it out when the Harness has no version to report', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
            await fx.run();
            const [record] = await fx.trialRecords('greeter');
            expect(record.harness_version).toBe('unknown');
        });

        it('records the LLM as harness-default when the Harness does not report a model', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
            await fx.run({ model: 'ignored-by-command' });
            const [record] = await fx.trialRecords('greeter');
            expect(record.llm).toBe('harness-default');
        });
    });

    it('records each resource with its own name and version, in its own file', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record })),
            'skills/farewell/SKILL.md': skillMd('farewell'),
            'evals/skills/farewell/eval.yml': evalYml([task('wave')]),
        }));
        await fx.run();
        const [g] = await fx.trialRecords('greeter');
        const [f] = await fx.trialRecords('farewell');
        expect(g).toMatchObject({ resource_name: 'greeter', eval: 'say' });
        expect(f).toMatchObject({ resource_name: 'farewell', eval: 'wave' });
        expect(g.run_id).toBe(f.run_id);
    });

    it('--validate emits no Trial Records: they describe real runs', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [task('say', { solution: 'solutions/solve.sh' })]),
            'evals/skills/greeter/solutions/solve.sh': 'echo hi > out.txt',
        }));
        await fx.run({ validate: true });
        expect(await fx.trialRecordFiles('greeter')).toEqual([]);
    });
});
