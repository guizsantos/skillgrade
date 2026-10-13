/**
 * What a run evaluated, recorded in every report so results can be compared
 * across skill versions and traced back to the eval that produced them.
 *
 * Versions are git commits: the skill's is the last commit that touched its
 * folder, the eval's the last commit that touched the eval dir outside it.
 * A run evaluates a commit: `skillgrade` refuses uncommitted inputs, and with
 * --from-head reads them from a worktree at HEAD (see headWorktree), listing
 * the changes it left out in `ignored`.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

export interface Provenance {
    run_id: string;              // groups the reports of one invocation
    commit: string | null;       // HEAD
    skill_commit: string | null;
    eval_commit: string | null;
    dirty?: string[];            // legacy: reports from before uncommitted runs were refused
    from_head?: boolean;         // read from a worktree at HEAD, leaving `ignored` out
    ignored?: string[];          // `git status --porcelain` lines not evaluated
    harness?: string;            // the agent CLI under test
    agent?: string;              // legacy: `harness` before it was renamed
    model?: string | null;
    args: string[];
    eval_dir: string;
    skill_dirs: string[];
}

function git(cwd: string, ...args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    } catch {
        return null;  // not a repo, or git missing
    }
}

/**
 * Run-level provenance; `harness` and `model` are added per task. `evalFiles` are
 * eval inputs outside the eval dir (imported YAML).
 */
export function gitProvenance(evalDir: string, skillDirs: string[], evalFiles: string[] = [], now = new Date()): Provenance {
    const dir = path.resolve(evalDir);
    const exclude = skillDirs.map(s => `:(exclude)${path.resolve(s)}`);
    const last = (...paths: string[]) => git(dir, 'log', '-1', '--format=%H', '--', ...paths) || null;
    const commit = git(dir, 'rev-parse', 'HEAD');
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return {
        run_id: `${stamp}-${commit ? commit.slice(0, 7) : 'nogit'}`,
        commit,
        skill_commit: skillDirs.length ? last(...skillDirs) : null,
        // the eval is its dir plus the files eval.yaml imports; the skill can sit inside the
        // eval dir (SKILL.md beside eval.yaml), and is not part of the eval
        eval_commit: commit ? last(dir, ...evalFiles, ...exclude) : null,
        args: process.argv.slice(2),
        eval_dir: dir,
        skill_dirs: skillDirs.map(s => path.resolve(s)),
    };
}

/** The repo's top level, or null outside a git repo (or one without a commit yet). */
export function repoRoot(dir: string): string | null {
    return git(dir, 'rev-parse', 'HEAD') ? git(dir, 'rev-parse', '--show-toplevel') : null;
}

/** `git status --porcelain` lines for the inputs inside `root`; others can't be committed here. */
export function uncommitted(root: string, inputs: string[]): string[] {
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const inside = inputs.map(real).filter(p => !path.relative(root, p).startsWith('..'));
    if (!inside.length) return [];
    return (git(root, 'status', '--porcelain', '--', ...inside) || '').split('\n').filter(Boolean);
}

/**
 * A detached worktree of HEAD in a temp dir, to read committed inputs from.
 * `at` maps a path in `root` into it, `back` maps one back; `remove` is sync and
 * idempotent so a signal handler can call it. A crashed run's leftover is
 * cleared by `git worktree prune` (see pruneWorktrees).
 */
export function headWorktree(root: string) {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'skillgrade-head-'));
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', wt, 'HEAD'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let removed = false;
    return {
        path: wt,
        at: (p: string) => path.join(wt, path.relative(root, fs.realpathSync(p))),
        back: (p: string) => path.join(root, path.relative(wt, p)),
        remove() {
            if (removed) return;
            removed = true;
            git(root, 'worktree', 'remove', '--force', wt);
            fs.removeSync(wt);
            git(root, 'worktree', 'prune');
        },
    };
}

export function pruneWorktrees(root: string) {
    git(root, 'worktree', 'prune');
}
