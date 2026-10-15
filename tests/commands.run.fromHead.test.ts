import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { EvalProjectFixture, evalProject, greeterProject, passingGrader, task } from './helpers/evalProject';

const worktrees = (fx: EvalProjectFixture) => fx.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '));

/** A committed skill ("v1") and an eval whose agent copies the skill it sees to out.txt. */
async function scratch(agent = 'cat .agents/skills/greeter/SKILL.md > out.txt', init = true) {
    const grader = passingGrader(`grep -q v1 out.txt && echo '{"score":1,"details":"head"}' || echo '{"score":0,"details":"not head"}'`);
    const fx = await evalProject(() => ({
        ...greeterProject(agent, [task('say', { graders: [grader] })]),
        'skills/greeter/SKILL.md': '---\nname: greeter\ndescription: d\n---\nv1\n',
    }), { git: init });
    const dirtySkill = () => fx.write('skills/greeter/SKILL.md', '---\nname: greeter\ndescription: d\n---\nv2 uncommitted\n');
    return { fx, dirtySkill };
}

describe('uncommitted eval inputs', () => {
    it('stop a run before any task runs', async () => {
        const { fx, dirtySkill } = await scratch();
        await dirtySkill();
        await expect(fx.run()).rejects.toThrow(/Uncommitted changes/);
        expect(await fx.reports('greeter')).toEqual([]);
    });

    it('--from-head evaluates HEAD from a worktree, files results here, and removes the worktree', async () => {
        const { fx, dirtySkill } = await scratch();
        await dirtySkill();
        await fx.run({ fromHead: true });

        const [report] = await fx.reports('greeter');
        expect(report.trials[0].reward).toBe(1);  // the agent saw v1, the committed skill
        expect(report.provenance).toMatchObject({
            from_head: true, ignored: [' M skills/greeter/SKILL.md'],
            eval_dir: path.join(fx.projectDir, 'skills', 'greeter'), skill_dirs: [path.join(fx.repo, 'skills', 'greeter')],
            commit: fx.git('rev-parse', 'HEAD'),
        });
        expect(worktrees(fx)).toHaveLength(1);
        expect(await fs.readFile(path.join(fx.repo, 'skills', 'greeter', 'SKILL.md'), 'utf-8')).toContain('v2 uncommitted');
    });

    it.each(['evals/eval-project.yml', 'evals/skills/greeter/eval.yml'])('an uncommitted change to %s counts too', async (file) => {
        const { fx } = await scratch();
        await fx.write(file, (await fs.readFile(path.join(fx.repo, file), 'utf-8')) + '# edited\n');
        await expect(fx.run()).rejects.toThrow(/Uncommitted changes/);
    });

    it('a clean tree runs as is, without a worktree', async () => {
        const { fx } = await scratch();
        await fx.run({ fromHead: true });
        const [report] = await fx.reports('greeter');
        expect(report.provenance!.from_head).toBeUndefined();
        expect(report.trials[0].reward).toBe(1);
    });

    it('--validate grades the working tree: exempt from the check, and rejects --from-head', async () => {
        const { fx, dirtySkill } = await scratch();
        await dirtySkill();
        await expect(fx.run({ validate: true, fromHead: true })).rejects.toThrow(/--from-head is for real runs/);
        await expect(fx.run({ validate: true })).resolves.toBeUndefined();
    });

    it('are not checked outside a git repo, where --from-head is an error', async () => {
        const { fx } = await scratch(undefined, false);
        await expect(fx.run({ fromHead: true })).rejects.toThrow(/needs a git repo/);
        await fx.run();
        expect(await fx.reports('greeter')).toHaveLength(1);
    });

    it('a killed --from-head run still removes its worktree', async () => {
        const { fx, dirtySkill } = await scratch('sleep 30');
        await dirtySkill();
        const cli = path.resolve(__dirname, '..', 'src', 'skillgrade.ts');
        const p = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), cli,
            '--from-head', '--harness=command', `--output=${fx.output}`],
            { cwd: fx.projectDir, stdio: 'ignore', env: { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '..', 'tsconfig.json') } });
        const exited = new Promise<number | null>(resolve => p.on('exit', code => resolve(code)));
        let wt: string[] = [];
        for (let i = 0; i < 300 && wt.length < 2; i++) {
            await new Promise(r => setTimeout(r, 100));
            wt = worktrees(fx);
        }
        expect(wt).toHaveLength(2);
        const tmp = wt[1].slice('worktree '.length);
        p.kill('SIGTERM');
        expect(await exited).toBe(143);
        expect(worktrees(fx)).toHaveLength(1);
        expect(await fs.pathExists(tmp)).toBe(false);
    }, 60_000);
});
