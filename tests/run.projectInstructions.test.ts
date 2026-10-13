import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { evalProject, evalYml, fakeAgent, projectYml, task } from './helpers/evalProject';

const INSTRUCTIONS = '# House rules\nAlways greet.\n';

/** Instructions `team` with one eval, run through the `command` harness. */
const instructionsProject = (command: string, md = INSTRUCTIONS) => ({
    'instructions/team/AGENTS.md': md,
    'evals/eval-project.yml': projectYml(command, { search_paths: { instructions: ['../instructions'] } }),
    'evals/instructions/team/eval.yml': evalYml([task('greet')]),
});

describe('running a Project Instructions eval from an Eval Project', () => {
    it('evaluates a resource under search_paths.instructions, named by its directory', async () => {
        const fx = await evalProject(ctx => instructionsProject(fakeAgent({ record: ctx.record })));
        await fx.run();
        const [report] = await fx.reports('team');
        expect(report).toMatchObject({ task: 'greet', pass_rate: 1 });
        expect(report.provenance).toMatchObject({
            skill_dirs: [path.join(fx.repo, 'instructions', 'team')],
            eval_dir: path.join(fx.projectDir, 'instructions', 'team'),
        });
    });

    it('delivers the file unchanged, with no frontmatter added', async () => {
        const fx = await evalProject(ctx => instructionsProject(fakeAgent({ record: ctx.record })));
        await fx.run();
        const { files } = await fx.seen();
        expect(files['AGENTS.md']).toBe(INSTRUCTIONS);
        expect(Object.keys(files)).toEqual(['AGENTS.md']);
    });

    it('delivers frontmatter unchanged, and does not hold it to the name rule', async () => {
        const md = '---\nname: something-else\n---\nBe brief.\n';
        const fx = await evalProject(ctx => instructionsProject(fakeAgent({ record: ctx.record }), md));
        await fx.run();
        expect((await fx.seen()).files['AGENTS.md']).toBe(md);
    });

    it('keeps the task workspace beside the instructions, and eval material out', async () => {
        const fx = await evalProject(ctx => ({
            ...instructionsProject(fakeAgent({ record: ctx.record })),
            'evals/instructions/team/workspace/greet/app.js': 'console.log(1)',
            'evals/instructions/team/graders/check.sh': 'echo hi',
        }));
        await fx.run();
        expect(Object.keys((await fx.seen()).files).sort()).toEqual(['AGENTS.md', 'app.js']);
    });

    it('does not run an eval whose directory holds no AGENTS.md', async () => {
        const fx = await evalProject(ctx => {
            const files: Record<string, string> = { ...instructionsProject(fakeAgent({ record: ctx.record })) };
            delete files['instructions/team/AGENTS.md'];
            files['instructions/team/README.md'] = 'not the file';
            return files;
        });
        await expect(fx.run()).rejects.toThrow(/team.*search_paths\.instructions/s);
        expect(await fx.ran()).toBe(false);
    });

    describe('filename per Harness', () => {
        const bin = path.join(os.tmpdir(), `sg-fake-bin-${process.pid}`);
        const originalPath = process.env.PATH;
        afterEach(async () => {
            process.env.PATH = originalPath;
            await fs.remove(bin);
        });

        /** Stand-in for a Harness's CLI on PATH, playing `command`. */
        async function fakeCli(name: string, command: string) {
            await fs.ensureDir(bin);
            // stdin is closed: the real CLIs are not piped their prompt
            await fs.outputFile(path.join(bin, name), `#!/bin/sh\n${command} < /dev/null\n`, { mode: 0o755 });
            process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
        }

        it.each([
            ['claude-code', 'CLAUDE.md', 'claude'],
            ['gemini-cli', 'GEMINI.md', 'gemini'],
            ['codex', 'AGENTS.md', 'codex'],
            ['opencode', 'AGENTS.md', 'opencode'],
        ])('%s gets %s', async (harness, filename, cli) => {
            const fx = await evalProject(ctx => instructionsProject(fakeAgent({ record: ctx.record })));
            await fakeCli(cli, fakeAgent({ record: fx.record }));
            await fx.run({ harness });
            const { files } = await fx.seen();
            expect(files[filename]).toBe(INSTRUCTIONS);
            expect(Object.keys(files)).toEqual([filename]);
        });

        it('the generic command harness gets AGENTS.md', async () => {
            const fx = await evalProject(ctx => instructionsProject(fakeAgent({ record: ctx.record })));
            await fx.run();
            expect(Object.keys((await fx.seen()).files)).toEqual(['AGENTS.md']);
        });
    });
});
