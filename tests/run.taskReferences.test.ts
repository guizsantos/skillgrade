import { describe, it, expect } from 'vitest';
import { evalProject, evalYml, fakeAgent, greeterProject, skillMd, task } from './helpers/evalProject';

const SKILL_PATHS = ['.agents/skills/greeter/SKILL.md', '.claude/skills/greeter/SKILL.md'];
const FAREWELL_PATHS = ['.agents/skills/farewell/SKILL.md', '.claude/skills/farewell/SKILL.md'];

/** `greeter` has a task `setup` with files; `farewell` has a task `wave` that borrows `workspace` entries. */
const twoSkills = (record: string, workspace: unknown) => ({
    ...greeterProject(fakeAgent({ record }), [task('setup'), task('say')]),
    'evals/skills/greeter/workspace/setup/base.txt': 'from setup',
    'evals/skills/greeter/workspace/setup/src/deep.txt': 'deep',
    'evals/skills/greeter/graders/secret.sh': 'GRADER-SECRET',
    'skills/farewell/SKILL.md': skillMd('farewell'),
    'evals/skills/farewell/eval.yml': evalYml([task('wave', { workspace })]),
});

describe('task references', () => {
    describe('a bare name: a task of the same eval', () => {
        it('lets a task borrow the workspace of another task of its eval', async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [task('setup'), task('say', { workspace: [{ task: 'setup' }] })]),
                'evals/skills/greeter/workspace/setup/base.txt': 'from setup',
                'evals/skills/greeter/workspace/setup/src/deep.txt': 'deep',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['base.txt']).toBe('from setup');
            expect(files['src/deep.txt']).toBe('deep');
        });

        it("adds the task's own workspace folder on top of what it borrowed", async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [task('setup'), task('say', { workspace: [{ task: 'setup' }] })]),
                'evals/skills/greeter/workspace/setup/base.txt': 'borrowed',
                'evals/skills/greeter/workspace/setup/shared.txt': 'borrowed',
                'evals/skills/greeter/workspace/say/shared.txt': 'own',
                'evals/skills/greeter/workspace/say/mine.txt': 'own',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['base.txt']).toBe('borrowed');
            expect(files['shared.txt']).toBe('own');
            expect(files['mine.txt']).toBe('own');
        });

        it('borrows from several tasks, the later one winning', async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [task('a'), task('b'), task('say', { workspace: [{ task: 'a' }, { task: 'b' }] })]),
                'evals/skills/greeter/workspace/a/a.txt': 'a',
                'evals/skills/greeter/workspace/a/both.txt': 'from a',
                'evals/skills/greeter/workspace/b/both.txt': 'from b',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['a.txt']).toBe('a');
            expect(files['both.txt']).toBe('from b');
        });

        it('a task with no workspace folder lends an empty workspace', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [task('empty'), task('say', { workspace: [{ task: 'empty' }] })]));
            await fx.run({ eval: 'say' });
            expect(Object.keys((await fx.seen()).files).sort()).toEqual(SKILL_PATHS);
        });

        it('never reaches into another resource: an unknown name errors with the project-wide hint', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'setup' }]));
            await expect(fx.run()).rejects.toThrow(/"setup" not defined in "farewell".*did you mean one of setup@skills:greeter\?/s);
            expect(await fx.ran()).toBe(false);
        });

        it('an unknown name that exists nowhere errors without a hint', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'nothing' }]));
            const error = await fx.run().then(() => new Error('did not throw'), (e: Error) => e);
            expect(error.message).toMatch(/"nothing" not defined in "farewell"/);
            expect(error.message).not.toMatch(/did you mean/);
        });
    });

    describe('name@resource: a task of another resource', () => {
        it('borrows its workspace when the resource name is unique, and only that workspace', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'setup@greeter' }]));
            await fx.run({ eval: 'wave' });
            const { files } = await fx.seen();
            expect(Object.keys(files).sort()).toEqual([...FAREWELL_PATHS, 'base.txt', 'src/deep.txt']);
            expect(JSON.stringify(files)).not.toContain('GRADER-SECRET');
        });

        it('errors when the resource has no such task', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'wave@greeter' }]));
            await expect(fx.run()).rejects.toThrow(/"wave" not defined in "greeter"/);
            expect(await fx.ran()).toBe(false);
        });

        it('errors when no resource has that name', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'setup@ghost' }]));
            await expect(fx.run()).rejects.toThrow(/no resource "ghost"/);
            expect(await fx.ran()).toBe(false);
        });

        it('errors on a resource that exists but has no eval: its tasks are unknown', async () => {
            const fx = await evalProject(ctx => ({
                ...twoSkills(ctx.record, [{ task: 'setup@untested' }]),
                'skills/untested/SKILL.md': skillMd('untested'),
            }));
            await expect(fx.run()).rejects.toThrow(/no resource "untested"/);
        });
    });

    describe('name@kind:resource: the full form', () => {
        it('resolves to the resource of that kind', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'setup@skills:greeter' }]));
            await fx.run({ eval: 'wave' });
            expect((await fx.seen()).files['base.txt']).toBe('from setup');
        });

        it('errors on a kind with no such resource', async () => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'setup@prompts:greeter' }]));
            await expect(fx.run()).rejects.toThrow(/no resource "greeter" in prompts/);
        });
    });

    describe('malformed references and entries', () => {
        it.each([
            ['an empty ref', [{ task: '' }]],
            ['too many @', [{ task: 'a@b@c' }]],
            ['a bare string entry', ['setup']],
            ['an entry with another key', [{ src: 'fixtures/app.js' }]],
            ['a non-list', { task: 'setup' }],
        ])('rejects %s before any trial', async (_label, workspace) => {
            const fx = await evalProject(ctx => twoSkills(ctx.record, workspace));
            await expect(fx.run()).rejects.toThrow(/workspace|reference/i);
            expect(await fx.ran()).toBe(false);
        });
    });

    describe('borrowing is recursive: a borrowed task brings what it borrows', () => {
        it('a chain a <- b <- say: say sees a, then b on top, then its own folder on top', async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [
                    task('a'),
                    task('b', { workspace: [{ task: 'a' }] }),
                    task('say', { workspace: [{ task: 'b' }] }),
                ]),
                'evals/skills/greeter/workspace/a/a.txt': 'a',
                'evals/skills/greeter/workspace/a/ab.txt': 'from a',
                'evals/skills/greeter/workspace/a/all.txt': 'from a',
                'evals/skills/greeter/workspace/b/ab.txt': 'from b',
                'evals/skills/greeter/workspace/b/all.txt': 'from b',
                'evals/skills/greeter/workspace/say/all.txt': 'from say',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['a.txt']).toBe('a');
            expect(files['ab.txt']).toBe('from b');
            expect(files['all.txt']).toBe('from say');
        });

        it('resolves each reference from the eval that declares it, across resources', async () => {
            // farewell/wave borrows setup@greeter; greeter/setup borrows its own eval's `base` by bare name
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [task('base'), task('setup', { workspace: [{ task: 'base' }] })]),
                'evals/skills/greeter/workspace/base/base.txt': 'from greeter base',
                'evals/skills/greeter/workspace/base/over.txt': 'from greeter base',
                'evals/skills/greeter/workspace/setup/over.txt': 'from setup',
                'skills/farewell/SKILL.md': skillMd('farewell'),
                // a same-named task in farewell must not be picked up by greeter's bare `base`
                'evals/skills/farewell/eval.yml': evalYml([task('base'), task('wave', { workspace: [{ task: 'setup@greeter' }] })]),
                'evals/skills/farewell/workspace/base/base.txt': 'from farewell base',
            }));
            await fx.run({ eval: 'wave' });
            const { files } = await fx.seen();
            expect(files['base.txt']).toBe('from greeter base');
            expect(files['over.txt']).toBe('from setup');
        });

        it('rejects a cycle before any trial, naming its path', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [
                task('a', { workspace: [{ task: 'b' }] }),
                task('b', { workspace: [{ task: 'a' }] }),
                task('say'),
            ]));
            await expect(fx.run({ eval: 'say' })).rejects.toThrow(/cycle: a@skills:greeter -> b@skills:greeter -> a@skills:greeter/);
            expect(await fx.ran()).toBe(false);
        });

        it('rejects a task that borrows itself', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [task('say', { workspace: [{ task: 'say' }] })]));
            await expect(fx.run()).rejects.toThrow(/cycle: say@skills:greeter -> say@skills:greeter/);
            expect(await fx.ran()).toBe(false);
        });

        it('a diamond copies the shared base once, before both branches', async () => {
            // say borrows b and c; both borrow d. Expected layers: d, b, c, say.
            // If d were copied again after b, it would overwrite b's version of shared.txt.
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [
                    task('d'),
                    task('b', { workspace: [{ task: 'd' }] }),
                    task('c', { workspace: [{ task: 'd' }] }),
                    task('say', { workspace: [{ task: 'b' }, { task: 'c' }] }),
                ]),
                'evals/skills/greeter/workspace/d/d.txt': 'd',
                'evals/skills/greeter/workspace/d/b-wins.txt': 'from d',
                'evals/skills/greeter/workspace/d/c-wins.txt': 'from d',
                'evals/skills/greeter/workspace/b/b-wins.txt': 'from b',
                'evals/skills/greeter/workspace/b/c-wins.txt': 'from b',
                'evals/skills/greeter/workspace/c/c-wins.txt': 'from c',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['d.txt']).toBe('d');
            expect(files['b-wins.txt']).toBe('from b');
            expect(files['c-wins.txt']).toBe('from c');
        });
    });

    it('checks references of tasks the selection leaves out too: a typo is not hidden by --eval', async () => {
        const fx = await evalProject(ctx => twoSkills(ctx.record, [{ task: 'typo' }]));
        await expect(fx.run({ eval: 'say' })).rejects.toThrow(/"typo" not defined/);
    });
});
