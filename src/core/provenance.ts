/**
 * What a run evaluated, recorded in every report so results can be compared
 * across skill versions and traced back to the eval that produced them.
 *
 * Versions are git commits: the skill's is the last commit that touched its
 * folder, the eval's the last commit that touched the eval dir outside it.
 * Uncommitted changes to either are listed in `dirty`; such a run measured a
 * state no commit describes, so the browser preview never compares it.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

export interface Provenance {
    run_id: string;              // groups the reports of one invocation
    commit: string | null;       // HEAD
    skill_commit: string | null;
    eval_commit: string | null;
    dirty: string[];             // `git status --porcelain` lines over the run's inputs
    agent?: string;
    model?: string | null;
    args: string[];
    eval_dir: string;
    skill_dirs: string[];
}

function git(cwd: string, ...args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;  // not a repo, or git missing
    }
}

/**
 * Run-level provenance; `agent` and `model` are added per task. `evalFiles` are
 * eval inputs outside the eval dir (imported YAML); `inputs`, the other files
 * the tasks read (workspace sources), which make a run dirty but aren't the eval.
 */
export function gitProvenance(
    evalDir: string, skillDirs: string[], evalFiles: string[] = [], inputs: string[] = [], now = new Date(),
): Provenance {
    const dir = path.resolve(evalDir);
    const exclude = skillDirs.map(s => `:(exclude)${path.resolve(s)}`);
    const last = (...paths: string[]) => git(dir, 'log', '-1', '--format=%H', '--', ...paths) || null;
    const commit = git(dir, 'rev-parse', 'HEAD');
    const dirty = git(dir, 'status', '--porcelain', '--', dir, ...evalFiles, ...skillDirs, ...inputs);
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return {
        run_id: `${stamp}-${commit ? commit.slice(0, 7) : 'nogit'}`,
        commit,
        skill_commit: skillDirs.length ? last(...skillDirs) : null,
        // the eval is its dir plus the files eval.yaml imports; the skill can sit inside the
        // eval dir (SKILL.md beside eval.yaml), and is not part of the eval
        eval_commit: commit ? last(dir, ...evalFiles, ...exclude) : null,
        dirty: dirty ? dirty.split('\n') : [],
        args: process.argv.slice(2),
        eval_dir: dir,
        skill_dirs: skillDirs.map(s => path.resolve(s)),
    };
}
