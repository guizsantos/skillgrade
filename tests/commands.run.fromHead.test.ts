import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { runEvals } from '../src/commands/run';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' }).trim();
const worktrees = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '));

/** A repo with a committed skill ("v1") and an eval whose agent copies the skill it sees to out.txt. */
async function scratch(agent = 'cat .agents/skills/greeter/SKILL.md > out.txt', init = true) {
    const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-head-')));
    const evalDir = path.join(repo, 'evals', 'greeter');
    await fs.outputFile(path.join(repo, 'skills', 'greeter', 'SKILL.md'), '---\nname: greeter\ndescription: d\n---\nv1\n');
    await fs.outputFile(path.join(evalDir, 'eval.yaml'), `skill: ../../skills/greeter
defaults:
  harness: command
  runtime: local
  trials: 1
  command: "${agent}"
tasks:
  - name: say
    instruction: copy the skill
    graders:
      - type: deterministic
        run: "grep -q v1 out.txt && echo '{\\"score\\":1,\\"details\\":\\"head\\"}' || echo '{\\"score\\":0,\\"details\\":\\"not head\\"}'"
`);
    if (init) {
        git(repo, 'init', '-q');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-qm', 'v1');
    }
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-head-out-'));
    const dirtySkill = () => fs.outputFile(path.join(repo, 'skills', 'greeter', 'SKILL.md'), 'v2 uncommitted\n');
    const results = async () => {
        const dir = path.join(output, 'greeter', 'results');
        return await fs.pathExists(dir) ? Promise.all((await fs.readdir(dir)).map(f => fs.readJson(path.join(dir, f)))) : [];
    };
    return { repo, evalDir, output, dirtySkill, results };
}

describe('uncommitted eval inputs', () => {
    it('stop a run before any task runs', async () => {
        const s = await scratch();
        await s.dirtySkill();
        await expect(runEvals(s.evalDir, { harness: 'command', output: s.output })).rejects.toThrow(/Uncommitted changes/);
        expect(await s.results()).toEqual([]);
    });

    it('--from-head evaluates HEAD from a worktree, files results here, and removes the worktree', async () => {
        const s = await scratch();
        await s.dirtySkill();
        await runEvals(s.evalDir, { harness: 'command', output: s.output, fromHead: true });

        const [report] = await s.results();
        expect(report.trials[0].reward).toBe(1);  // the agent saw v1, the committed skill
        expect(report.provenance).toMatchObject({
            from_head: true, ignored: [' M skills/greeter/SKILL.md'],
            eval_dir: s.evalDir, skill_dirs: [path.join(s.repo, 'skills', 'greeter')],
            commit: git(s.repo, 'rev-parse', 'HEAD'),
        });
        expect(worktrees(s.repo)).toHaveLength(1);
        expect(await fs.readFile(path.join(s.repo, 'skills', 'greeter', 'SKILL.md'), 'utf-8')).toBe('v2 uncommitted\n');
    });

    it('a clean tree runs as is, without a worktree', async () => {
        const s = await scratch();
        await runEvals(s.evalDir, { harness: 'command', output: s.output, fromHead: true });
        const [report] = await s.results();
        expect(report.provenance.from_head).toBeUndefined();
        expect(report.trials[0].reward).toBe(1);
    });

    it('--validate grades the working tree: exempt from the check, and rejects --from-head', async () => {
        const s = await scratch();
        await s.dirtySkill();
        await expect(runEvals(s.evalDir, { harness: 'command', output: s.output, validate: true, fromHead: true }))
            .rejects.toThrow(/--from-head is for real runs/);
        await expect(runEvals(s.evalDir, { harness: 'command', output: s.output, validate: true })).resolves.toBeUndefined();
    });

    it('are not checked outside a git repo, where --from-head is an error', async () => {
        const s = await scratch(undefined, false);
        await expect(runEvals(s.evalDir, { harness: 'command', output: s.output, fromHead: true })).rejects.toThrow(/needs a git repo/);
        await runEvals(s.evalDir, { harness: 'command', output: s.output });
        expect(await s.results()).toHaveLength(1);
    });

    it('a killed --from-head run still removes its worktree', async () => {
        const s = await scratch('sleep 30');
        await s.dirtySkill();
        const cli = path.resolve(__dirname, '..', 'src', 'skillgrade.ts');
        const p = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), cli,
            '--from-head', '--harness=command', `--output=${s.output}`],
            { cwd: s.evalDir, stdio: 'ignore', env: { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '..', 'tsconfig.json') } });
        const exited = new Promise<number | null>(resolve => p.on('exit', code => resolve(code)));
        let wt: string[] = [];
        for (let i = 0; i < 300 && wt.length < 2; i++) {
            await new Promise(r => setTimeout(r, 100));
            wt = worktrees(s.repo);
        }
        expect(wt).toHaveLength(2);
        const tmp = wt[1].slice('worktree '.length);
        p.kill('SIGTERM');
        expect(await exited).toBe(143);
        expect(worktrees(s.repo)).toHaveLength(1);
        expect(await fs.pathExists(tmp)).toBe(false);
    }, 60_000);
});
