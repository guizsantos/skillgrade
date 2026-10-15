/**
 * Shared fixtures for the `runEvals(dir, opts)` seam.
 *
 * Each test builds a real Eval Project inside a real temp git repo (so
 * provenance and the uncommitted-inputs check work), runs `runEvals` with the
 * `local` runtime and the `command` harness driven by a scripted fake agent
 * (./fake-agent.js), and asserts only external behavior: errors, what the
 * agent saw, and the reports written. No Docker, no LLM, no network.
 *
 *   const fx = await evalProject(ctx => greeterProject(fakeAgent({ record: ctx.record })));
 *   await fx.run();
 *   expect((await fx.seen()).files).toHaveProperty('.agents/skills/greeter/SKILL.md');
 *   expect((await fx.reports('greeter'))[0].pass_rate).toBe(1);
 *
 * Layout built by `greeterProject` (the repo root is `fx.repo`):
 *
 *   skills/greeter/SKILL.md                  the resource, kept apart from its evals
 *   evals/eval-project.yml                   the Eval Project (`fx.projectDir`)
 *   evals/skills/greeter/eval.yml            one eval per resource
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runEvals } from '../../src/commands/run';
import type { EvalReport } from '../../src/types';

type RunOptions = Parameters<typeof runEvals>[1];

const FAKE_AGENT = path.resolve(__dirname, 'fake-agent.js');

/** What `fake-agent.js` is told to do; see that file for the semantics. */
export interface FakeAgentScript {
    record?: string;
    env?: string[];
    write?: Record<string, string>;
}

/** What the fake agent saw in its workspace, as written by `record`. */
export interface AgentRecord {
    prompt: string;
    files: Record<string, string>;
    env: Record<string, string | null>;
}

/** The `command` for the `command` harness that plays `script`. */
export function fakeAgent(script: FakeAgentScript = {}): string {
    const b64 = Buffer.from(JSON.stringify(script)).toString('base64');
    return `node '${FAKE_AGENT}' '${b64}'`;
}

/** A SKILL.md whose frontmatter name is `name`. */
export function skillMd(name: string, body = 'Greet the user.'): string {
    return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

/** A deterministic grader that always passes; `run` overrides the script. */
export function passingGrader(run = `echo '{"score":1,"details":"ok"}'`) {
    return { type: 'deterministic', run };
}

/** A task with one passing grader. `extra` overrides or adds task keys. */
export function task(name = 'say', extra: Record<string, unknown> = {}) {
    return { name, instruction: `do the ${name} thing`, graders: [passingGrader()], ...extra };
}

export const evalYml = (tasks: unknown[], extra: Record<string, unknown> = {}) => yaml.dump({ ...extra, tasks });

/** An `eval-project.yml` running `command` on the local runtime, one trial, with skills at `../skills`. */
export function projectYml(command: string, extra: Record<string, unknown> = {}) {
    return yaml.dump({
        defaults: { harness: 'command', runtime: 'local', trials: 1, command },
        search_paths: { skills: ['../skills'] },
        ...extra,
    });
}

/**
 * The smallest working project: skill `greeter` and its eval. Spread the
 * result and override single paths to build a variation, e.g.
 * `{ ...greeterProject(cmd), 'skills/greeter/SKILL.md': skillMd('wrong') }`.
 */
export function greeterProject(command: string, tasks: unknown[] = [task()]): Record<string, string> {
    return {
        'skills/greeter/SKILL.md': skillMd('greeter'),
        'evals/eval-project.yml': projectYml(command),
        'evals/skills/greeter/eval.yml': evalYml(tasks),
    };
}

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' }).trim();

export interface EvalProjectFixture {
    repo: string;
    /** The Eval Project directory: where `skillgrade run` is invoked. */
    projectDir: string;
    output: string;
    /** Where the fake agent's `record` script key should point. */
    record: string;
    /** What the fake agent recorded; rejects if it never ran. */
    seen(): Promise<AgentRecord>;
    /** Whether the fake agent ran at all. */
    ran(): Promise<boolean>;
    /** The reports written for one resource's results. */
    reports(resource: string): Promise<EvalReport[]>;
    /** Names of the `<run_id>.trials.jsonl` files written beside one resource's reports. */
    trialRecordFiles(resource: string): Promise<string[]>;
    /** Every Trial Record line written for one resource, parsed. */
    trialRecords(resource: string): Promise<Record<string, any>[]>;
    /** `runEvals` on the project with the local runtime and the command harness. */
    run(opts?: Partial<RunOptions>): Promise<void>;
    git(...args: string[]): string;
    write(rel: string, content: string): Promise<void>;
    commit(message?: string): void;
}

/**
 * Write `build(ctx)`'s files (paths relative to the repo root) into a temp git
 * repo and commit them. `ctx.record` is the path the fake agent records to.
 * Pass `{ git: false }` for a tree outside any repo.
 */
export async function evalProject(
    build: (ctx: { record: string }) => Record<string, string>,
    opts: { git?: boolean } = {},
): Promise<EvalProjectFixture> {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-project-')));
    const repo = path.join(base, 'repo');
    const output = path.join(base, 'output');
    const record = path.join(base, 'seen.json');
    for (const [rel, content] of Object.entries(build({ record }))) {
        await fs.outputFile(path.join(repo, rel), content);
    }
    await fs.ensureDir(repo);

    const fx: EvalProjectFixture = {
        repo, output, record,
        projectDir: path.join(repo, 'evals'),
        seen: () => fs.readJson(record),
        ran: () => fs.pathExists(record),
        async reports(resource) {
            const dir = path.join(output, resource, 'results');
            if (!await fs.pathExists(dir)) return [];
            return Promise.all((await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort().map(f => fs.readJson(path.join(dir, f))));
        },
        async trialRecordFiles(resource) {
            const dir = path.join(output, resource, 'results');
            if (!await fs.pathExists(dir)) return [];
            return (await fs.readdir(dir)).filter(f => f.endsWith('.trials.jsonl')).sort();
        },
        async trialRecords(resource) {
            const dir = path.join(output, resource, 'results');
            const files = await fx.trialRecordFiles(resource);
            const lines = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf-8')))).flatMap(t => t.split('\n').filter(Boolean));
            return lines.map(l => JSON.parse(l));
        },
        run: (o = {}) => runEvals(fx.projectDir, { harness: 'command', runtime: 'local', output, ...o }),
        git: (...args) => git(repo, ...args),
        write: (rel, content) => fs.outputFile(path.join(repo, rel), content),
        commit(message = 'commit') {
            git(repo, 'add', '-A');
            git(repo, 'commit', '-qm', message);
        },
    };
    if (opts.git !== false) {
        git(repo, 'init', '-q');
        fx.commit('initial');
    }
    return fx;
}
