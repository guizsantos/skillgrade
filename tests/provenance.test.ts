import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { gitProvenance, uncommitted } from '../src/core/provenance';

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' }).trim();

describe('gitProvenance', () => {
    it('versions the skill and the eval by the last commit that touched each', async () => {
        const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-prov-')));
        const skill = path.join(repo, 'skill'), evalDir = path.join(repo, 'eval');
        await fs.outputFile(path.join(skill, 'SKILL.md'), 'v1');
        await fs.outputFile(path.join(evalDir, 'eval.yaml'), 'tasks: []');
        git(repo, 'init', '-q');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-qm', 'both');
        const both = git(repo, 'rev-parse', 'HEAD');
        await fs.outputFile(path.join(skill, 'SKILL.md'), 'v2');
        git(repo, 'commit', '-qam', 'skill only');
        const head = git(repo, 'rev-parse', 'HEAD');

        const p = gitProvenance(evalDir, [skill], [], new Date('2026-01-02T03:04:05.678Z'));
        expect(p.run_id).toBe(`20260102T030405Z-${head.slice(0, 7)}`);
        expect([p.commit, p.skill_commit, p.eval_commit]).toEqual([head, head, both]);

        await fs.outputFile(path.join(skill, 'SKILL.md'), 'v3');
        expect(uncommitted(repo, [evalDir, skill])).toEqual([' M skill/SKILL.md']);
        expect(uncommitted(repo, [evalDir])).toEqual([]);
    });

    it('records no versions outside a git repo, without failing', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-prov-'));
        const p = gitProvenance(dir, [dir]);
        expect([p.commit, p.skill_commit, p.eval_commit]).toEqual([null, null, null]);
        expect(p.run_id).toMatch(/-nogit$/);
    });
});
