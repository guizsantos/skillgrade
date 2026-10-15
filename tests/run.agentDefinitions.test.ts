import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { evalProject, evalYml, fakeAgent, projectYml, task } from './helpers/evalProject';

const PROMPT = 'You are a terse reviewer.\nAlways answer in one line.\n';
const definition = (frontmatter = 'name: reviewer\ndescription: reviews code') => `---\n${frontmatter}\n---\n${PROMPT}`;

/** Agent Definition `reviewer` (one file, as a platform repo keeps it) with one eval. */
const agentProject = (command: string, md = definition(), tasks: unknown[] = [task('review')]) => ({
    'agents/reviewer.md': md,
    'evals/eval-project.yml': projectYml(command, { search_paths: { agents: ['../agents'] } }),
    'evals/agents/reviewer/eval.yml': evalYml(tasks),
});

describe('running an Agent Definition eval from an Eval Project', () => {
    const bin = path.join(os.tmpdir(), `sg-fake-bin-agents-${process.pid}`);
    const originalPath = process.env.PATH;
    afterEach(async () => {
        process.env.PATH = originalPath;
        await fs.remove(bin);
    });

    /** Stand-in for a Harness's CLI on PATH: logs its arguments, one per line, then plays `command`. */
    async function fakeCli(name: string, command: string, argsFile: string) {
        await fs.ensureDir(bin);
        await fs.outputFile(path.join(bin, name), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "1.2.3"; exit 0; }\n printf '%s\\n' "$@" > '${argsFile}'\n${command} < /dev/null\n`, { mode: 0o755 });
        process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    }

    it('evaluates a resource under search_paths.agents, named by its file', async () => {
        const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record })));
        await fx.run();
        const [report] = await fx.reports('reviewer');
        expect(report).toMatchObject({ task: 'review', pass_rate: 1 });
        expect(report.provenance!.skill_dirs).toEqual([path.join(fx.repo, 'agents', 'reviewer.md')]);
        expect((await fx.trialRecords('reviewer'))[0]).toMatchObject({ resource_kind: 'agent', resource_name: 'reviewer' });
    });

    it('fails loudly when the frontmatter name differs from the file name, before any trial', async () => {
        const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), definition('name: other')));
        await expect(fx.run()).rejects.toThrow(/name "other" does not match.*"reviewer"/s);
        expect(await fx.ran()).toBe(false);
    });

    it('fails loudly when the frontmatter has no name', async () => {
        const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), definition('description: no name')));
        await expect(fx.run()).rejects.toThrow(/needs "name: reviewer"/);
        expect(await fx.ran()).toBe(false);
    });

    describe('Harnesses that run it as the top-level agent', () => {
        it.each([
            ['claude-code', 'claude', '.claude/agents/reviewer.md'],
            ['opencode', 'opencode', '.opencode/agents/reviewer.md'],
        ])('%s runs it by name as a subagent', async (harness, cli, file) => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record })));
            const argsFile = path.join(path.dirname(fx.record), 'args.txt');
            await fakeCli(cli, fakeAgent({ record: fx.record }), argsFile);
            await fx.run({ harness });

            const args = (await fs.readFile(argsFile, 'utf-8')).split('\n');
            expect(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 2)).toEqual(['--agent', 'reviewer']);

            const { files } = await fx.seen();
            expect(files[file]).toBe(definition());
            expect(Object.keys(files)).toEqual([file]);
            expect(await fx.trialRecords('reviewer')).toEqual([expect.objectContaining({
                agent_invocation: 'subagent', harness_compatibility: 'full',
            })]);
        });
    });

    describe('Harnesses that get it as Project Instructions', () => {
        it('the generic command harness gets the prompt in AGENTS.md, without the frontmatter', async () => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record })));
            await fx.run();
            const { files } = await fx.seen();
            expect(files).toEqual({ 'AGENTS.md': PROMPT });
            expect(await fx.trialRecords('reviewer')).toEqual([expect.objectContaining({
                agent_invocation: 'project_instruction', harness_compatibility: 'full',
            })]);
        });

        it.each([
            ['gemini-cli', 'GEMINI.md', 'gemini'],
            ['codex', 'AGENTS.md', 'codex'],
        ])('%s gets it in %s, and is not given an agent to run', async (harness, filename, cli) => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record })));
            const argsFile = path.join(path.dirname(fx.record), 'args.txt');
            await fakeCli(cli, fakeAgent({ record: fx.record }), argsFile);
            await fx.run({ harness });
            expect((await fx.seen()).files).toEqual({ [filename]: PROMPT });
            expect(await fs.readFile(argsFile, 'utf-8')).not.toContain('--agent');
            expect((await fx.trialRecords('reviewer'))[0].agent_invocation).toBe('project_instruction');
        });
    });

    describe('the compatibility gate', () => {
        const withExtras = definition('name: reviewer\ndescription: reviews code\ntemperature: 0.2\ntop_p: 0.9');

        it('stops a run whose definition carries keys the Harness does not support, before any trial', async () => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), withExtras));
            await expect(fx.run()).rejects.toThrow(
                'Running eval for reviewer in harness command with temperature, top_p keys unsupported; run with --force to continue',
            );
            expect(await fx.ran()).toBe(false);
            expect(await fx.reports('reviewer')).toEqual([]);
            expect(await fx.trialRecordFiles('reviewer')).toEqual([]);
        });

        it('names the task-level Harness, and stops before the first task even when only a later one is unsupported', async () => {
            const md = definition('name: reviewer\ntemperature: 0.2');
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), md, [
                task('first', { harness: 'opencode' }),   // supports temperature
                task('second', { harness: 'claude-code' }),
            ]));
            await fakeCli('opencode', fakeAgent({ record: fx.record }), path.join(path.dirname(fx.record), 'args.txt'));
            await expect(fx.run({ harness: undefined })).rejects.toThrow(
                'Running eval for reviewer in harness claude-code with temperature keys unsupported; run with --force to continue',
            );
            expect(await fx.ran()).toBe(false);
        });

        it('names only the keys this Harness lacks: opencode supports temperature', async () => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), definition('name: reviewer\ntemperature: 0.2\nhooks: {}')));
            await fakeCli('opencode', fakeAgent({ record: fx.record }), path.join(path.dirname(fx.record), 'args.txt'));
            await expect(fx.run({ harness: 'opencode' })).rejects.toThrow(
                'Running eval for reviewer in harness opencode with hooks keys unsupported; run with --force to continue',
            );
        });

        it('with --force runs anyway, and every Trial Record is degraded and lists the ignored keys', async () => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record }), withExtras));
            await fx.run({ force: true, trials: 2 });
            expect(await fx.ran()).toBe(true);
            const records = await fx.trialRecords('reviewer');
            expect(records).toHaveLength(2);
            for (const r of records) {
                expect(r).toMatchObject({
                    agent_invocation: 'project_instruction',
                    harness_compatibility: 'degraded',
                    ignored_keys: ['temperature', 'top_p'],
                });
            }
        });

        it('a clean run is full and carries no ignored keys', async () => {
            const fx = await evalProject(ctx => agentProject(fakeAgent({ record: ctx.record })));
            await fx.run({ force: true });
            const [record] = await fx.trialRecords('reviewer');
            expect(record.harness_compatibility).toBe('full');
            expect(record.ignored_keys).toBeUndefined();
        });

        it('does not gate a Skill, whatever its frontmatter holds', async () => {
            const fx = await evalProject(ctx => ({
                'skills/greeter/SKILL.md': '---\nname: greeter\ndescription: d\ntemperature: 1\n---\nHi\n',
                'evals/eval-project.yml': projectYml(fakeAgent({ record: ctx.record })),
                'evals/skills/greeter/eval.yml': evalYml([task()]),
            }));
            await fx.run();
            const [record] = await fx.trialRecords('greeter');
            expect(record).toMatchObject({ agent_invocation: null, harness_compatibility: 'full' });
        });
    });
});
