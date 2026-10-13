import { describe, it, expect } from 'vitest';
import { evalProject, evalYml, fakeAgent, projectYml, task } from './helpers/evalProject';

/** A Prompt task: it has no instruction of its own, the Prompt is what the agent is asked. */
function ptask(name: string, variables?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { instruction: _omit, ...rest } = task(name, { variables, ...extra });
    return rest;
}

const promptMd = (name: string, body = 'Hello {{who}}, welcome to {{place}}.') =>
    `---\nname: ${name}\ndescription: ${name} prompt\n---\n${body}\n`;

/** A project with only a `greet` Prompt (and its eval); `tasks` are the eval's tasks. */
function greetProject(record: string, tasks: unknown[], project: Record<string, unknown> = {}, body?: string) {
    const command = fakeAgent({ record });
    return {
        'prompts/greet.md': promptMd('greet', body),
        'evals/eval-project.yml': projectYml(command, { search_paths: { prompts: ['../prompts'] }, ...project }),
        'evals/prompts/greet/eval.yml': evalYml(tasks),
    };
}

describe('running a Prompt eval from an Eval Project', () => {
    it('treats a resource under search_paths.prompts as a Prompt: the agent gets the rendered prompt and no skill', async () => {
        const fx = await evalProject(ctx => greetProject(ctx.record, [
            ptask('say', { who: 'Ada', place: 'Paris' }),
        ]));
        await fx.run();

        const seen = await fx.seen();
        expect(seen.prompt.trim()).toBe('Hello Ada, welcome to Paris.');
        expect(seen.files).toEqual({});

        const [report] = await fx.reports('greet');
        expect(report).toMatchObject({ task: 'say', pass_rate: 1, skills_used: [] });
        expect(report.provenance).toMatchObject({ commit: fx.git('rev-parse', 'HEAD') });
    });

    it('renders each task with its own values: one Prompt, different inputs', async () => {
        const fx = await evalProject(ctx => greetProject(ctx.record, [
            ptask('first', { who: 'Ada', place: 'Paris' }),
            ptask('second', { who: 'Bob', place: 'Rome' }),
        ]));
        await fx.run({ eval: 'second' });
        expect((await fx.seen()).prompt.trim()).toBe('Hello Bob, welcome to Rome.');
        await fx.run({ eval: 'first' });
        expect((await fx.seen()).prompt.trim()).toBe('Hello Ada, welcome to Paris.');
    });

    it('never shows the agent the frontmatter', async () => {
        const fx = await evalProject(ctx => greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]));
        await fx.run();
        expect((await fx.seen()).prompt).not.toMatch(/---|description:/);
    });

    describe('variables', () => {
        it('come from the project file, and a task value overrides them', async () => {
            const fx = await evalProject(ctx => greetProject(
                ctx.record,
                [ptask('say', { who: 'Ada' })],
                { variables: { who: 'Nobody', place: 'Paris' } },
            ));
            await fx.run();
            expect((await fx.seen()).prompt.trim()).toBe('Hello Ada, welcome to Paris.');
        });

        it('tolerate whitespace in the placeholder and non-string values', async () => {
            const fx = await evalProject(ctx => greetProject(
                ctx.record,
                [ptask('say', { n: 3, ok: true })],
                {},
                '{{ n }} items, ok={{  ok}}',
            ));
            await fx.run();
            expect((await fx.seen()).prompt.trim()).toBe('3 items, ok=true');
        });

        it('are not re-expanded: a value that looks like a placeholder stays literal', async () => {
            const fx = await evalProject(ctx => greetProject(
                ctx.record,
                [ptask('say', { who: '{{place}}', place: 'Paris' })],
            ));
            await fx.run();
            expect((await fx.seen()).prompt.trim()).toBe('Hello {{place}}, welcome to Paris.');
        });

        it('a placeholder with no value fails loudly before any trial, naming it and the task', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [
                ptask('complete', { who: 'Ada', place: 'Paris' }),
                ptask('incomplete', { who: 'Bob' }),
            ]));
            await expect(fx.run()).rejects.toThrow(/\{\{place\}\}.*incomplete|incomplete.*\{\{place\}\}/s);
            expect(await fx.ran()).toBe(false);
            expect(await fx.reports('greet')).toEqual([]);
        });

        it('a null value counts as no value', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [
                ptask('say', { who: 'Ada', place: null }),
            ]));
            await expect(fx.run()).rejects.toThrow(/\{\{place\}\}/);
            expect(await fx.ran()).toBe(false);
        });

        it('must be an object', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [ptask('say', ['who'] as any)]));
            await expect(fx.run()).rejects.toThrow(/variables/);
            expect(await fx.ran()).toBe(false);
        });

        it('a task not selected is not rendered, so its missing value does not stop the run', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [
                ptask('complete', { who: 'Ada', place: 'Paris' }),
                ptask('incomplete', {}),
            ]));
            await fx.run({ eval: 'complete' });
            expect(await fx.ran()).toBe(true);
        });
    });

    describe('the task instruction', () => {
        it('is optional for a Prompt: the Prompt is what the agent is asked', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]));
            await fx.run();
            expect((await fx.seen()).prompt.trim()).toBe('Hello a, welcome to b.');
        });

        it('follows the rendered Prompt when given', async () => {
            const fx = await evalProject(ctx => greetProject(ctx.record, [
                task('say', { instruction: 'Reply in French.', variables: { who: 'a', place: 'b' } }),
            ]));
            await fx.run();
            expect((await fx.seen()).prompt.trim()).toBe('Hello a, welcome to b.\n\nReply in French.');
        });
    });

    describe('Resource Name', () => {
        it.each([
            ['a different frontmatter name', promptMd('other')],
            ['no frontmatter name', '---\ndescription: d\n---\nbody\n'],
            ['no frontmatter at all', 'just a body\n'],
        ])('fails loudly before any trial: %s', async (_label, content) => {
            const fx = await evalProject(ctx => ({
                ...greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]),
                'prompts/greet.md': content,
            }));
            await expect(fx.run()).rejects.toThrow(/greet.*name/s);
            expect(await fx.ran()).toBe(false);
        });

        it('is the file name without .md; other files in the search path are not Prompts', async () => {
            const fx = await evalProject(ctx => ({
                ...greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]),
                'prompts/README.txt': 'not a prompt',
                'prompts/notes/greet.md': 'not a prompt either',
            }));
            await fx.run();
            expect(await fx.ran()).toBe(true);
        });

        it('an eval with no Prompt of that name stops the run', async () => {
            const fx = await evalProject(ctx => ({
                ...greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]),
                'evals/prompts/ghost/eval.yml': evalYml([task()]),
            }));
            await expect(fx.run()).rejects.toThrow(/ghost.*search_paths/s);
            expect(await fx.ran()).toBe(false);
        });
    });

    it('a Prompt, with its task workspace, is graded on what the agent did', async () => {
        const fx = await evalProject(ctx => ({
            ...greetProject(ctx.record, [ptask('say', { who: 'a', place: 'b' })]),
            'evals/prompts/greet/workspace/say/input.txt': 'visible',
        }));
        await fx.run();
        expect(Object.keys((await fx.seen()).files)).toEqual(['input.txt']);
    });

    it('evaluates a Prompt next to a Skill, each with its own results', async () => {
        const fx = await evalProject(ctx => {
            const command = fakeAgent({ record: ctx.record });
            return {
                'prompts/greet.md': promptMd('greet'),
                'skills/greeter/SKILL.md': '---\nname: greeter\ndescription: d\n---\nGreet.\n',
                'evals/eval-project.yml': projectYml(command, { search_paths: { prompts: ['../prompts'], skills: ['../skills'] } }),
                'evals/prompts/greet/eval.yml': evalYml([ptask('p', { who: 'a', place: 'b' })]),
                'evals/skills/greeter/eval.yml': evalYml([task('s')]),
            };
        });
        await fx.run();
        expect((await fx.reports('greet')).map(r => r.task)).toEqual(['p']);
        expect((await fx.reports('greeter')).map(r => r.task)).toEqual(['s']);
        const [skillReport] = await fx.reports('greeter');
        expect(skillReport.skills_used).toEqual(['greeter']);
    });
});
