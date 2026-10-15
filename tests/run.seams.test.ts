/**
 * Seams between the resource kinds: behaviour that only shows once an Eval
 * Project holds more than one kind at the same time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { evalProject, evalYml, fakeAgent, projectYml, skillMd, task } from './helpers/evalProject';

const ALL_PATHS = { skills: ['../skills'], agents: ['../agents'], instructions: ['../instructions'], prompts: ['../prompts'] };
const promptMd = (name: string, body = 'Say hello.') => `---\nname: ${name}\ndescription: ${name} prompt\n---\n${body}\n`;
const agentMd = (name: string) => `---\nname: ${name}\ndescription: ${name} agent\n---\nYou are terse.\n`;

/** One resource of each kind, each with its own eval. Names differ by kind unless a test overrides. */
const allKinds = (command: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'skills/greeter/SKILL.md': skillMd('greeter'),
    'agents/reviewer.md': agentMd('reviewer'),
    'instructions/team/AGENTS.md': '# House rules\nBe brief.\n',
    'prompts/hello.md': promptMd('hello'),
    'evals/eval-project.yml': projectYml(command, { search_paths: ALL_PATHS }),
    'evals/skills/greeter/eval.yml': evalYml([task('say')]),
    'evals/agents/reviewer/eval.yml': evalYml([task('review')]),
    'evals/instructions/team/eval.yml': evalYml([task('follow')]),
    'evals/prompts/hello/eval.yml': evalYml([task('greet')]),
    ...extra,
});

describe('reference ambiguity across kinds', () => {
    /** A skill and a prompt both called `shared`, each with a task `setup`; skill `user` borrows `ref`. */
    const ambiguous = (command: string, ref: string) => ({
        'skills/shared/SKILL.md': skillMd('shared'),
        'skills/user/SKILL.md': skillMd('user'),
        'prompts/shared.md': promptMd('shared'),
        'evals/eval-project.yml': projectYml(command, { search_paths: { skills: ['../skills'], prompts: ['../prompts'] } }),
        'evals/skills/shared/eval.yml': evalYml([task('setup')]),
        'evals/skills/shared/workspace/setup/who.txt': 'skill setup',
        'evals/prompts/shared/eval.yml': evalYml([task('setup')]),
        'evals/prompts/shared/workspace/setup/who.txt': 'prompt setup',
        'evals/skills/user/eval.yml': evalYml([task('go', { workspace: [{ task: ref }] })]),
    });

    it('name@resource matching two kinds fails, asking for name@kind:resource, before any trial', async () => {
        const fx = await evalProject(ctx => ambiguous(fakeAgent({ record: ctx.record }), 'setup@shared'));
        const error = await fx.run().then(() => new Error('did not throw'), (e: Error) => e);
        expect(error.message).toMatch(/"shared".*prompts, skills.*setup@<kind>:shared/s);
        expect(await fx.ran()).toBe(false);
    });

    it.each([
        ['skills', 'skill setup'],
        ['prompts', 'prompt setup'],
    ])('name@%s:resource resolves it', async (kind, content) => {
        const fx = await evalProject(ctx => ambiguous(fakeAgent({ record: ctx.record }), `setup@${kind}:shared`));
        await fx.run({ eval: 'go' });
        expect((await fx.seen()).files['who.txt']).toBe(content);
    });
});

describe('one Eval Project holding every kind', () => {
    const bin = path.join(os.tmpdir(), `sg-fake-bin-seams-${process.pid}`);
    const originalPath = process.env.PATH;
    afterEach(async () => {
        process.env.PATH = originalPath;
        await fs.remove(bin);
    });

    const records = async (fx: Awaited<ReturnType<typeof evalProject>>) => ({
        skill: (await fx.trialRecords('greeter'))[0],
        agent: (await fx.trialRecords('reviewer'))[0],
        instructions: (await fx.trialRecords('team'))[0],
        prompt: (await fx.trialRecords('hello'))[0],
    });

    it('runs all four together, each Trial Record carrying its own kind and delivery', async () => {
        const fx = await evalProject(ctx => allKinds(fakeAgent({ record: ctx.record })));
        await fx.run();

        for (const name of ['greeter', 'reviewer', 'team', 'hello']) {
            expect((await fx.reports(name))[0]).toMatchObject({ pass_rate: 1 });
        }
        const r = await records(fx);
        expect(r.skill).toMatchObject({ resource_kind: 'skill', resource_name: 'greeter', agent_invocation: null, harness_compatibility: 'full' });
        expect(r.agent).toMatchObject({ resource_kind: 'agent', resource_name: 'reviewer', agent_invocation: 'project_instruction', harness_compatibility: 'full' });
        expect(r.instructions).toMatchObject({ resource_kind: 'instructions', resource_name: 'team', agent_invocation: null, harness_compatibility: 'full' });
        expect(r.prompt).toMatchObject({ resource_kind: 'prompt', resource_name: 'hello', agent_invocation: null, harness_compatibility: 'full' });
    });

    it('a Harness that runs agents as subagents changes only the Agent Definition\'s delivery', async () => {
        const fx = await evalProject(ctx => allKinds(fakeAgent({ record: ctx.record })));
        await fs.ensureDir(bin);
        await fs.outputFile(path.join(bin, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "1.2.3"; exit 0; }\n${fakeAgent({ record: fx.record })} < /dev/null\n`, { mode: 0o755 });
        process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
        await fx.run({ harness: 'claude-code' });

        const r = await records(fx);
        expect(r.agent).toMatchObject({ resource_kind: 'agent', agent_invocation: 'subagent', harness_compatibility: 'full' });
        expect(r.skill).toMatchObject({ resource_kind: 'skill', agent_invocation: null, harness_compatibility: 'full' });
        expect(r.instructions).toMatchObject({ resource_kind: 'instructions', agent_invocation: null, harness_compatibility: 'full' });
        expect(r.prompt).toMatchObject({ resource_kind: 'prompt', agent_invocation: null, harness_compatibility: 'full' });
    });

    it('--force marks only the Agent Definition with unsupported keys as degraded', async () => {
        const fx = await evalProject(ctx => allKinds(fakeAgent({ record: ctx.record }), {
            'agents/reviewer.md': '---\nname: reviewer\ntemperature: 0.2\n---\nYou are terse.\n',
        }));
        await expect(fx.run()).rejects.toThrow(/temperature keys unsupported; run with --force/);
        await fx.run({ force: true });

        const r = await records(fx);
        expect(r.agent).toMatchObject({ harness_compatibility: 'degraded', ignored_keys: ['temperature'] });
        for (const other of [r.skill, r.instructions, r.prompt]) {
            expect(other.harness_compatibility).toBe('full');
            expect(other.ignored_keys).toBeUndefined();
        }
    });
});
