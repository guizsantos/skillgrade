import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evalProject, evalYml, fakeAgent, greeterProject, projectYml, skillMd, task } from './helpers/evalProject';
import { fakeLlm, type FakeLlm } from './helpers/fake-llm';

const judged = (judge: string, extra: Record<string, unknown> = {}) => ({ llm_judge: judge, ...extra });
const judgedTask = (name: string, ...graders: unknown[]) => task(name, { graders });

/** A judge file: frontmatter with the LLM settings, then the rubric. */
const FM = '---\nllm_provider: openai\nllm_model: judge-model\n---\n';
const judgeFileOf = (rubric: string, frontmatter = FM) => frontmatter + rubric;
const JUDGE = 'evals/skills/greeter/llm_judges/quality.md';

describe('reusable LLM judges (llm_judge: name)', () => {
    let llm: FakeLlm;
    beforeEach(async () => {
        llm = await fakeLlm(prompt => ({ score: prompt.includes('BE-STRICT') ? 0.25 : 1, reasoning: 'scripted' }));
        llm.use();
    });
    afterEach(() => llm.close());

    it('runs a grader with the judge defined under the eval\'s llm_judges/', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality'))]),
            [JUDGE]: judgeFileOf('Is the greeting BE-STRICT polite?'),
        }));
        await fx.run();

        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain('Is the greeting BE-STRICT polite?');
        const [report] = await fx.reports('greeter');
        expect(report.trials[0].grader_results[0]).toMatchObject({ grader_type: 'llm_rubric', score: 0.25, details: 'scripted' });
    });

    it('fails loudly before any trial on an unknown judge, naming the eval and the judge', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [
                task('first'),
                judgedTask('second', judged('missing-judge')),
            ]),
            'evals/skills/greeter/llm_judges/other.md': 'unrelated',
        }));
        await expect(fx.run()).rejects.toThrow(/greeter.*missing-judge|missing-judge.*greeter/s);
        expect(await fx.ran()).toBe(false);
        expect(await fx.reports('greeter')).toEqual([]);
        expect(llm.prompts).toEqual([]);
    });

    it('looks a judge up in the eval it is referenced from, not in a sibling eval', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality'))]),
            'skills/farewell/SKILL.md': skillMd('farewell'),
            'evals/skills/farewell/eval.yml': evalYml([task('wave')]),
            'evals/skills/farewell/llm_judges/quality.md': judgeFileOf('the farewell judge'),
        }));
        await expect(fx.run()).rejects.toThrow(/greeter.*quality/s);
        expect(await fx.ran()).toBe(false);
    });

    it.each(['../quality', 'a/b', ''])('rejects the judge name %j as not a plain name', async name => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged(name))]),
            'evals/skills/greeter/quality.md': 'outside llm_judges/',
        }));
        await expect(fx.run()).rejects.toThrow(/llm_judge/);
        expect(await fx.ran()).toBe(false);
    });

    it('rejects an empty judge before any trial', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality'))]),
            [JUDGE]: FM + '  \n',
        }));
        await expect(fx.run()).rejects.toThrow(/quality.*empty/s);
        expect(await fx.ran()).toBe(false);
    });

    it('rejects a grader that has both an inline rubric and a judge', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality', { rubric: 'inline' }))]),
            [JUDGE]: judgeFileOf('judge'),
        }));
        await expect(fx.run()).rejects.toThrow(/rubric.*llm_judge|llm_judge.*rubric/s);
        expect(await fx.ran()).toBe(false);
    });

    it('never puts a judge definition in the agent\'s workspace', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality'))]),
            [JUDGE]: judgeFileOf('JUDGE-RUBRIC-TEXT'),
            'evals/skills/greeter/workspace/say/input.txt': 'visible',
        }));
        await fx.run();

        const seen = await fx.seen();
        expect(Object.keys(seen.files).some(f => f.includes('llm_judges') || f.includes('quality'))).toBe(false);
        expect(JSON.stringify(seen)).not.toContain('JUDGE-RUBRIC-TEXT');
        expect(llm.prompts[0]).toContain('JUDGE-RUBRIC-TEXT');
    });

    it('lets the same judge serve several graders and several tasks', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [
                judgedTask('say', judged('quality'), judged('quality', { weight: 2 })),
                judgedTask('other', judged('quality')),
            ]),
            [JUDGE]: judgeFileOf('shared BE-STRICT rubric'),
        }));
        await fx.run();

        expect(llm.prompts).toHaveLength(3);
        for (const prompt of llm.prompts) expect(prompt).toContain('shared BE-STRICT rubric');
        const reports = await fx.reports('greeter');
        const say = reports.find(r => r.task === 'say')!;
        expect(say.trials[0].grader_results.map(g => g.score)).toEqual([0.25, 0.25]);
        expect(reports.find(r => r.task === 'other')!.trials[0].grader_results).toHaveLength(1);
    });

    it('mixes with a deterministic grader in one task', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [
                task('say', { graders: [
                    { type: 'deterministic', run: `echo '{"score":1,"details":"ok"}'` },
                    judged('quality'),
                ] }),
            ]),
            [JUDGE]: judgeFileOf('rubric'),
        }));
        await fx.run();
        const [report] = await fx.reports('greeter');
        expect(report.trials[0].grader_results.map(g => g.grader_type)).toEqual(['deterministic', 'llm_rubric']);
    });

    describe('the LLM settings of a judge', () => {
        const noScore = { type: 'deterministic', run: `echo '{"score":0,"details":"no"}'` };
        /** A project built from its project defaults, eval defaults, tasks and judge file. */
        const project = (o: {
            project?: Record<string, unknown>; evalDefaults?: Record<string, unknown>;
            tasks?: unknown[]; judge?: string;
        } = {}) => evalProject(ctx => {
            const command = fakeAgent({ record: ctx.record });
            const tasks = o.tasks ?? [judgedTask('say', judged('quality'))];
            return {
                ...greeterProject(command, tasks),
                'evals/eval-project.yml': projectYml(command, { defaults: { harness: 'command', runtime: 'local', trials: 1, command, ...o.project } }),
                'evals/skills/greeter/eval.yml': evalYml(tasks, o.evalDefaults ? { defaults: o.evalDefaults } : {}),
                [JUDGE]: o.judge ?? judgeFileOf('rubric'),
            };
        });

        it('are read from the frontmatter, which is not part of the rubric', async () => {
            const fx = await project({ judge: judgeFileOf('THE RUBRIC BODY') });
            await fx.run();
            expect(llm.models).toEqual(['judge-model']);
            expect(llm.prompts[0]).toContain('THE RUBRIC BODY');
            expect(llm.prompts[0]).not.toContain('llm_provider');
            expect(llm.prompts[0]).not.toContain('judge-model');
        });

        it('are layered: the judge beats the eval defaults, which beat the project defaults', async () => {
            const fx = await project({
                project: { llm_provider: 'anthropic', llm_model: 'm-project' },
                evalDefaults: { llm_provider: 'gemini', llm_model: 'm-eval' },
            });
            await fx.run();
            // the openai provider and its model reached the fake server: the judge's, not anthropic's or gemini's
            expect(llm.models).toEqual(['judge-model']);
        });

        it('are layered one field at a time', async () => {
            const fx = await project({
                project: { llm_provider: 'anthropic', llm_model: 'm-project' },
                evalDefaults: { llm_model: 'm-eval' },
                judge: judgeFileOf('rubric', '---\nllm_provider: openai\n---\n'),
            });
            await fx.run();
            expect(llm.models).toEqual(['m-eval']);   // model: eval defaults over project; provider: the judge's
        });

        it('come from the project defaults when nothing more specific sets them', async () => {
            const fx = await project({ project: { llm_provider: 'openai', llm_model: 'm-project' }, judge: 'bare rubric' });
            await fx.run();
            expect(llm.models).toEqual(['m-project']);
            expect(llm.prompts[0]).toContain('bare rubric');
        });

        it('get no implicit provider: an unresolved one fails before any trial, naming eval, task, judge and field', async () => {
            const fx = await project({ judge: judgeFileOf('rubric', '---\nllm_model: m\n---\n') });
            await expect(fx.run()).rejects.toThrow(/greeter[\s\S]*say[\s\S]*quality[\s\S]*llm_provider/);
            expect(await fx.ran()).toBe(false);
            expect(llm.prompts).toEqual([]);
        });

        it('fail before any trial on an unresolved model, naming eval, task, judge and field', async () => {
            const fx = await project({
                tasks: [task('first'), judgedTask('say', judged('quality'))],
                judge: judgeFileOf('rubric', '---\nllm_provider: openai\n---\n'),
            });
            await expect(fx.run()).rejects.toThrow(/greeter[\s\S]*say[\s\S]*quality[\s\S]*llm_model/);
            expect(await fx.ran()).toBe(false);
        });

        it('reject an llm_provider in the frontmatter that is not a provider', async () => {
            const fx = await project({ judge: judgeFileOf('rubric', '---\nllm_provider: nope\nllm_model: m\n---\n') });
            await expect(fx.run()).rejects.toThrow(/quality[\s\S]*llm_provider|llm_provider[\s\S]*quality/);
            expect(await fx.ran()).toBe(false);
        });

        it.each([['llm_model', 'x'], ['llm_provider', 'openai']])('conflict when a judge grader also sets %s in eval.yml', async (field, value) => {
            const fx = await project({ tasks: [judgedTask('say', judged('quality', { [field]: value }))] });
            await expect(fx.run()).rejects.toThrow(new RegExp(`greeter[\\s\\S]*say[\\s\\S]*quality[\\s\\S]*${field}`));
            expect(await fx.ran()).toBe(false);
            expect(llm.prompts).toEqual([]);
        });

        it.each([['llm_model', 'task-model'], ['llm_provider', 'openai']])('conflict when a task sets %s and its judge sets the same field', async (field, value) => {
            const fx = await project({ tasks: [task('say', { graders: [judged('quality')], [field]: value })] });
            await expect(fx.run()).rejects.toThrow(new RegExp(`greeter[\\s\\S]*say[\\s\\S]*quality[\\s\\S]*${field}`));
            expect(await fx.ran()).toBe(false);
            expect(llm.prompts).toEqual([]);
        });

        it('let a task fill the field its judge leaves unset, with no conflict', async () => {
            const fx = await project({
                tasks: [task('say', { graders: [judged('quality')], llm_model: 'task-model' })],
                judge: judgeFileOf('rubric', '---\nllm_provider: openai\n---\n'),
            });
            await fx.run();
            expect(llm.models).toEqual(['task-model']);
        });

        it('leave task-level settings working for inline rubric graders, even in a project with judges', async () => {
            const fx = await project({
                tasks: [
                    task('say', { graders: [{ type: 'llm_rubric', rubric: 'inline' }], llm_provider: 'openai', llm_model: 'task-model' }),
                    judgedTask('other', judged('quality')),
                ],
            });
            await fx.run();
            expect([...llm.models].sort()).toEqual(['judge-model', 'task-model']);
        });

        it('keep the weight on each grader item: one judge, a different weight in each task', async () => {
            const fx = await project({
                tasks: [
                    task('heavy', { graders: [judged('quality', { weight: 1 }), noScore] }),
                    task('light', { graders: [judged('quality', { weight: 0.5 }), noScore] }),
                ],
            });
            await fx.run();
            const reports = await fx.reports('greeter');
            const trial = (name: string) => reports.find(r => r.task === name)!.trials[0];
            const judgeWeight = (name: string) => trial(name).grader_results.find(g => g.grader_type === 'llm_rubric')!.weight;
            expect(judgeWeight('heavy')).toBe(1);
            expect(judgeWeight('light')).toBe(0.5);
            expect(trial('heavy').reward).toBeCloseTo(1 / 2);
            expect(trial('light').reward).toBeCloseTo(0.5 / 1.5);
        });
    });
});
