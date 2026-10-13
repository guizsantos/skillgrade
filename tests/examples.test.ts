/**
 * The bundled examples are real Eval Projects: each loads with the same loaders
 * `skillgrade` uses, its graders pass against its reference solutions, and a
 * run on a trivial command agent writes reports and Trial Records.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { runEvals } from '../src/commands/run';
import { loadEvalConfig } from '../src/core/config';
import { loadProject, testedResources } from '../src/core/project';

const EXAMPLES = path.resolve(__dirname, '..', 'examples');

/** example -> the resources (kind:name) it evaluates */
const EXPECTED: Record<string, string[]> = {
    superlint: ['skill:superlint'],
    'angular-modern': ['skill:angular-modern-apis'],
    platform: ['skill:conventional-commits', 'agent:release-notes-writer', 'instructions:team-conventions', 'prompt:release-summary'],
};

/** A copy of the example in a fresh git repo, so a run has a commit to evaluate. */
async function copyOf(example: string) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-example-')));
    await fs.copy(path.join(EXAMPLES, example), path.join(base, example));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: base, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'example');
    return { base, projectDir: path.join(base, example, 'evals'), output: path.join(base, 'output') };
}

async function trialRecords(output: string, resource: string) {
    const dir = path.join(output, resource, 'results');
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.trials.jsonl'));
    const lines = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf-8')))).flatMap(t => t.split('\n').filter(Boolean));
    return lines.map(l => JSON.parse(l));
}

describe('bundled examples', () => {
    it('are all covered by this test', async () => {
        const dirs = (await fs.readdir(EXAMPLES, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
        expect(dirs).toEqual(Object.keys(EXPECTED).sort());
    });

    it('document an example of every resource kind', () => {
        const kinds = new Set(Object.values(EXPECTED).flat().map(r => r.split(':')[0]));
        expect([...kinds].sort()).toEqual(['agent', 'instructions', 'prompt', 'skill']);
    });

    describe.each(Object.entries(EXPECTED))('%s', (example, resources) => {
        it('loads as an Eval Project, resource by resource', async () => {
            const projectDir = path.join(EXAMPLES, example, 'evals');
            const project = await loadProject(projectDir);
            const found = await testedResources(project);
            expect(found.map(r => `${r.kind}:${r.name}`).sort()).toEqual([...resources].sort());
            for (const r of found) {
                const config = await loadEvalConfig(r.evalDir, project.defaults, { instructionRequired: r.kind !== 'prompt' });
                expect(config.tasks.length).toBeGreaterThan(0);
                // an eval is checkable: every task has a reference solution
                for (const task of config.tasks) expect(task.solution, `${r.name} / ${task.name}`).toBeTruthy();
            }
        });

        it('has deterministic graders that pass against the reference solutions', async () => {
            const { projectDir, output } = await copyOf(example);
            await expect(runEvals(projectDir, { validate: true, grader: 'deterministic', runtime: 'local', ci: true, output })).resolves.toBeUndefined();
        });

        it('runs with a command agent, writing a report and a Trial Record per resource', async () => {
            const { projectDir, output } = await copyOf(example);
            // `tools:` is a Claude Code key: any other harness needs --force
            await runEvals(projectDir, { harness: 'command', command: 'true', runtime: 'local', trials: 1, grader: 'deterministic', force: true, output });
            for (const resource of resources) {
                const name = resource.split(':')[1];
                const records = await trialRecords(output, name);
                expect(records.length, name).toBeGreaterThan(0);
                for (const r of records) {
                    expect(r).toMatchObject({ schema_version: 1, resource_kind: resource.split(':')[0], resource_name: name });
                }
            }
        });
    });

    it('platform: each kind carries its own delivery in the Trial Records', async () => {
        const { projectDir, output } = await copyOf('platform');
        await runEvals(projectDir, { harness: 'command', command: 'true', runtime: 'local', trials: 1, grader: 'deterministic', force: true, output });

        const [skill] = await trialRecords(output, 'conventional-commits');
        const [agent] = await trialRecords(output, 'release-notes-writer');
        const [instructions] = await trialRecords(output, 'team-conventions');
        const [prompt] = await trialRecords(output, 'release-summary');
        expect(skill).toMatchObject({ agent_invocation: null, harness_compatibility: 'full' });
        expect(agent).toMatchObject({ agent_invocation: 'project_instruction', harness_compatibility: 'degraded', ignored_keys: ['tools'] });
        expect(instructions).toMatchObject({ agent_invocation: null, harness_compatibility: 'full' });
        expect(prompt).toMatchObject({ agent_invocation: null, harness_compatibility: 'full' });
    });

    it('platform: stops on a harness that ignores the agent definition\'s keys, unless forced', async () => {
        const { projectDir, output } = await copyOf('platform');
        await expect(runEvals(projectDir, { harness: 'command', command: 'true', runtime: 'local', trials: 1, grader: 'deterministic', output }))
            .rejects.toThrow('Running eval for release-notes-writer in harness command with tools keys unsupported; run with --force to continue');
    });
});
