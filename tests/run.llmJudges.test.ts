import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evalProject, evalYml, fakeAgent, greeterProject, skillMd, task } from './helpers/evalProject';
import { fakeLlm, type FakeLlm } from './helpers/fake-llm';

const judged = (judge: string, extra: Record<string, unknown> = {}) => ({
    llm_judge: judge, llm_provider: 'openai', llm_model: 'judge-model', ...extra,
});
const judgedTask = (name: string, ...graders: unknown[]) => task(name, { graders });

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
            'evals/skills/greeter/llm_judges/quality.md': 'Is the greeting BE-STRICT polite?',
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
            'evals/skills/farewell/llm_judges/quality.md': 'the farewell judge',
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
            'evals/skills/greeter/llm_judges/quality.md': '  \n',
        }));
        await expect(fx.run()).rejects.toThrow(/quality.*empty/s);
        expect(await fx.ran()).toBe(false);
    });

    it('rejects a grader that has both an inline rubric and a judge', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality', { rubric: 'inline' }))]),
            'evals/skills/greeter/llm_judges/quality.md': 'judge',
        }));
        await expect(fx.run()).rejects.toThrow(/rubric.*llm_judge|llm_judge.*rubric/s);
        expect(await fx.ran()).toBe(false);
    });

    it('never puts a judge definition in the agent\'s workspace', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record }), [judgedTask('say', judged('quality'))]),
            'evals/skills/greeter/llm_judges/quality.md': 'JUDGE-RUBRIC-TEXT',
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
            'evals/skills/greeter/llm_judges/quality.md': 'shared BE-STRICT rubric',
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
            'evals/skills/greeter/llm_judges/quality.md': 'rubric',
        }));
        await fx.run();
        const [report] = await fx.reports('greeter');
        expect(report.trials[0].grader_results.map(g => g.grader_type)).toEqual(['deterministic', 'llm_rubric']);
    });
});
