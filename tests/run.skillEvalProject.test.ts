import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { runPreview } from '../src/commands/preview';
import { evalProject, evalYml, fakeAgent, greeterProject, passingGrader, projectYml, skillMd, task } from './helpers/evalProject';

const SKILL_PATHS = ['.agents/skills/greeter/SKILL.md', '.claude/skills/greeter/SKILL.md'];

describe('running a Skill eval from an Eval Project', () => {
    it('produces results end to end, tied to the resource and eval it evaluated', async () => {
        const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record, write: { 'out.txt': 'hi' } }), [
            task('say', { graders: [passingGrader('grep -q hi out.txt && echo \'{"score":1,"details":"wrote it"}\' || echo \'{"score":0,"details":"no"}\'')] }),
        ]));
        await fx.run();

        const [report] = await fx.reports('greeter');
        expect(report).toMatchObject({ task: 'say', pass_rate: 1, skills_used: ['greeter'] });
        expect(report.trials[0].grader_results[0].details).toBe('wrote it');
        expect(report.provenance).toMatchObject({
            commit: fx.git('rev-parse', 'HEAD'),
            skill_dirs: [path.join(fx.repo, 'skills', 'greeter')],
            eval_dir: path.join(fx.projectDir, 'skills', 'greeter'),
        });
    });

    it('runs every resource that has an eval, each with its own results; an untested resource is left alone', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record })),
            'skills/farewell/SKILL.md': skillMd('farewell'),
            'evals/skills/farewell/eval.yml': evalYml([task('wave')]),
            'skills/untested/SKILL.md': skillMd('untested'),
        }));
        await fx.run();
        expect((await fx.reports('greeter')).map(r => r.task)).toEqual(['say']);
        expect((await fx.reports('farewell')).map(r => r.task)).toEqual(['wave']);
        expect(await fx.reports('untested')).toEqual([]);
    });

    it('--eval selects tasks by name across resources', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record })),
            'skills/farewell/SKILL.md': skillMd('farewell'),
            'evals/skills/farewell/eval.yml': evalYml([task('wave')]),
        }));
        await fx.run({ eval: 'wave' });
        expect(await fx.reports('greeter')).toEqual([]);
        expect(await fx.reports('farewell')).toHaveLength(1);
        await expect(fx.run({ eval: 'nope' })).rejects.toThrow(/not found/);
    });

    it('treats a resource under search_paths.skills as a Skill, wherever that path points', async () => {
        const fx = await evalProject(ctx => {
            const command = fakeAgent({ record: ctx.record });
            const files = greeterProject(command);
            delete files['skills/greeter/SKILL.md'];
            return {
                ...files,
                'catalog/greeter/SKILL.md': skillMd('greeter', 'from the catalog'),
                'evals/eval-project.yml': projectYml(command, { search_paths: { skills: ['../catalog'] } }),
            };
        });
        await fx.run();
        const seen = await fx.seen();
        for (const p of SKILL_PATHS) expect(seen.files[p]).toContain('from the catalog');
    });

    it('does not run an eval whose resource is nowhere in the search paths', async () => {
        const fx = await evalProject(ctx => ({
            ...greeterProject(fakeAgent({ record: ctx.record })),
            'evals/skills/ghost/eval.yml': evalYml([task()]),
        }));
        await expect(fx.run()).rejects.toThrow(/ghost.*search_paths/s);
        expect(await fx.ran()).toBe(false);
    });

    describe('Resource Name', () => {
        it.each([
            ['a different frontmatter name', skillMd('other')],
            ['no frontmatter name', '---\ndescription: d\n---\nbody\n'],
            ['no frontmatter at all', '# Greeter\nbody\n'],
        ])('fails loudly before any trial: %s', async (_label, content) => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record })),
                'skills/greeter/SKILL.md': content,
            }));
            await expect(fx.run()).rejects.toThrow(/greeter.*name/s);
            expect(await fx.ran()).toBe(false);
            expect(await fx.reports('greeter')).toEqual([]);
        });
    });

    describe('task workspace', () => {
        it('injects the folder named after the task, with no workspace: key', async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record }), [task('say'), task('other')]),
                'evals/skills/greeter/workspace/say/app.js': 'console.log(1)',
                'evals/skills/greeter/workspace/say/src/deep.txt': 'deep',
                'evals/skills/greeter/workspace/other/other.txt': 'not mine',
            }));
            await fx.run({ eval: 'say' });
            const { files } = await fx.seen();
            expect(files['app.js']).toBe('console.log(1)');
            expect(files['src/deep.txt']).toBe('deep');
            expect(files).not.toHaveProperty('other.txt');
        });

        it('gives a task with no folder an empty workspace: just the skill', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
            await fx.run();
            expect(Object.keys((await fx.seen()).files).sort()).toEqual(SKILL_PATHS);
        });

        it('rejects the legacy workspace: key', async () => {
            const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record }), [
                task('say', { workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }] }),
            ]));
            await expect(fx.run()).rejects.toThrow(/workspace/);
            expect(await fx.ran()).toBe(false);
        });
    });

    describe('isolation', () => {
        const SECRET_EXPECTED = 'EXPECTED-SECRET-VALUE';
        const SECRET_SOLUTION = 'SOLUTION-SECRET-VALUE';
        const project = (record: string) => ({
            ...greeterProject(fakeAgent({ record, write: { 'out.txt': 'done' } }), [
                task('say', {
                    expected: { answer: SECRET_EXPECTED },
                    solution: 'solutions/solve.sh',
                    metadata: { tier: 'easy' },
                    graders: [passingGrader('bash graders/check.sh')],
                }),
            ]),
            'evals/skills/greeter/graders/check.sh': `grep -q done out.txt && echo "$SKILLGRADE_INPUT" | grep -q ${SECRET_EXPECTED} && echo '{"score":1,"details":"graded"}' || echo '{"score":0,"details":"bad"}'`,
            'evals/skills/greeter/llm_judges/quality.md': 'JUDGE-RUBRIC',
            'evals/skills/greeter/solutions/solve.sh': `echo ${SECRET_SOLUTION} > out.txt`,
            'evals/skills/greeter/workspace/say/input.txt': 'visible',
        });

        it('never shows the agent eval.yml, graders, judges, expected or solution; only the skill and task workspace', async () => {
            const fx = await evalProject(ctx => project(ctx.record));
            await fx.run();

            const seen = await fx.seen();
            expect(Object.keys(seen.files).sort()).toEqual([...SKILL_PATHS, 'input.txt']);
            const everything = JSON.stringify(seen);
            for (const secret of [SECRET_EXPECTED, SECRET_SOLUTION, 'JUDGE-RUBRIC', 'graders/check.sh']) {
                expect(everything).not.toContain(secret);
            }
        });

        it('still grades: the grader script and `expected` arrive after the agent is done', async () => {
            const fx = await evalProject(ctx => project(ctx.record));
            await fx.run();
            const [report] = await fx.reports('greeter');
            expect(report.trials[0].grader_results[0]).toMatchObject({ score: 1, details: 'graded' });
        });

        it('--validate runs the solution from outside the workspace', async () => {
            const fx = await evalProject(ctx => ({
                ...project(ctx.record),
                'evals/skills/greeter/graders/check.sh': `grep -q ${SECRET_SOLUTION} out.txt && echo '{"score":1,"details":"solved"}' || echo '{"score":0,"details":"unsolved"}'`,
            }));
            await fx.run({ validate: true });
            const [report] = await fx.reports('greeter');
            expect(report.trials[0].grader_results[0].details).toBe('solved');
        });
    });

    it('preview in the project shows what a run produced', async () => {
        const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
        await fx.run();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await runPreview(fx.projectDir, 'cli', fx.output);
            expect(log.mock.calls.flat().join('\n')).toContain('say');
        } finally {
            log.mockRestore();
        }
    });

    describe('legacy eval.yaml', () => {
        it('is rejected when it sits where the Eval Project should be', async () => {
            const fx = await evalProject(() => ({ 'evals/eval.yaml': 'tasks: []\n' }));
            await expect(fx.run()).rejects.toThrow(/eval\.yaml is no longer supported.*eval-project\.yml/s);
        });

        it('is rejected inside a resource eval directory', async () => {
            const fx = await evalProject(ctx => ({
                ...greeterProject(fakeAgent({ record: ctx.record })),
                'evals/skills/greeter/eval.yaml': 'tasks: []\n',
            }));
            await expect(fx.run()).rejects.toThrow(/eval\.yaml is no longer supported.*eval\.yml/s);
            expect(await fx.ran()).toBe(false);
        });

        it('a directory with no project file at all says so', async () => {
            const fx = await evalProject(() => ({ 'evals/README.md': 'nothing here' }));
            await expect(fx.run()).rejects.toThrow(/eval-project\.yml/);
        });
    });
});
