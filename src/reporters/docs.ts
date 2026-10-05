/**
 * The data behind `skillgrade preview browser`: every skill under the output
 * directory, built fresh on each request so a run that just finished shows on reload.
 *
 * A skill is `<output>/<name>/results/*.json`. Its eval.yaml, graders and SKILL.md
 * are found through the newest report's `provenance.eval_dir`; reports from
 * before provenance (or from another machine) still show, from the reports alone.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { loadEvalConfig, resolveTask } from '../core/config';
import { importedFiles } from '../core/imports';
import { ResolvedGrader, ResolvedTask } from '../core/config.types';
import { TrialResult } from '../types';
import { Run, agentOutput, checks, errored, loadRuns, stats, summary } from './report';

function git(cwd: string, ...args: string[]): string {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    } catch {
        return '';
    }
}

function frontmatter(text: string): { fm: Record<string, any>; body: string } {
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
    if (!m) return { fm: {}, body: text };
    let fm: Record<string, any>;
    try {
        fm = (yaml.load(m[1]) as Record<string, any>) || {};
    } catch {  // agents tolerate unquoted colons in frontmatter; YAML doesn't
        fm = Object.fromEntries([...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map(x => [x[1], x[2]]));
    }
    return { fm, body: text.slice(m[0].length).trim() };
}

/** What the trial page needs, with the session log narrowed to what the agent did. */
function trialView(t: TrialResult) {
    let details: any = {};
    for (const g of t.grader_results || []) {
        try { details = JSON.parse(g.details); } catch { /* free-text details */ }
    }
    const log = t.session_log || [];
    // checks() counts a judge as one check, passed at score 1: so does the page, its reasoning as evidence
    const own = details.checks || Object.entries(checks(t)).filter(([k]) => k !== 'llm_rubric')
        .map(([check, ok]) => ({ check, ok, evidence: (t.grader_results || []).find(g => g.grader_type === check)?.details || '' }));
    const judges = (t.grader_results || []).filter(g => g.grader_type === 'llm_rubric').map(g => ({
        check: 'llm_rubric', ok: (g.score || 0) >= 1, judge: true, evidence: `score ${(g.score || 0).toFixed(2)} · ${g.details || ''}`,
    }));
    return {
        trial_id: t.trial_id, reward: t.reward, duration_ms: t.duration_ms, errored: errored(t),
        checks: [...own, ...judges],
        changed: details.changed || {},
        output: agentOutput(t) || (errored(t) ? log.find(e => e.type === 'reward')?.output || '' : ''),
        commands: log.filter(e => e.type === 'command').map(e => ({
            timestamp: e.timestamp, command: e.command || '', stdout: e.stdout, stderr: e.stderr, exitCode: e.exitCode,
        })),
        started: log.find(e => e.type === 'agent_start')?.timestamp || null,
    };
}

/** A deterministic grader shows its script, plus the source of any file it runs; an llm_rubric, its rubric. */
async function graderView(g: ResolvedGrader, baseDirs: string[]) {
    const out = { type: g.type, weight: g.weight ?? 1 };
    if (g.type === 'llm_rubric') {
        return { ...out, rubric: g.rubric || '(skillgrade default rubric)', provider: g.provider, model: g.model };
    }
    let run = g.run || '';
    for (const ref of new Set(run.match(/[\w./-]+\.\w{1,4}/g) || [])) {
        for (const dir of baseDirs) {
            const p = path.resolve(dir, ref);
            if (await fs.pathExists(p) && (await fs.stat(p)).isFile()) {
                run += `\n\n# ${ref}\n${await fs.readFile(p, 'utf-8')}`;
                break;
            }
        }
    }
    return { ...out, run };
}

/**
 * Every commit that touched the skill (kind "skill") or only the eval's other
 * inputs (kind "workspace"), oldest first, each skill commit with the score of
 * the compared runs made at it.
 */
function history(evalDir: string, skillDirs: string[], inputs: string[], runs: Run[], s: any) {
    if (!git(evalDir, 'rev-parse', 'HEAD')) return [];
    const log = git(evalDir, 'log', '--reverse', '--format=%H%x09%cI%x09%s', '--', ...skillDirs, evalDir, ...inputs);
    const touched = new Set(git(evalDir, 'log', '--format=%H', '--', ...skillDirs).split('\n'));
    const compared = new Set(s.runs.filter((r: any) => r.comparable).map((r: any) => r.id));
    const trials: Record<string, Record<string, TrialResult[]>> = {};  // skill commit → task → valid trials
    for (const r of runs) {
        const c = r.prov.skill_commit;
        if (!compared.has(r.id) || !c) continue;
        for (const [, d] of r.tasks) ((trials[c] ??= {})[d.task] ??= []).push(...(d.trials || []).filter(t => !errored(t)));
    }
    return log.split('\n').filter(Boolean).map(line => {
        const [h, date, ...subject] = line.split('\t');
        const byTask = Object.entries(trials[h] || {}).filter(([, v]) => v.length);
        const every = byTask.flatMap(([, v]) => v.map(t => t.reward));
        return {
            commit: h, date, subject: subject.join('\t'), kind: touched.has(h) ? 'skill' : 'workspace',
            score: every.length ? stats(every) : null,
            tasks: Object.fromEntries(byTask.map(([k, v]) => [k, { mean: stats(v.map(t => t.reward)).mean, n: v.length }])),
        };
    });
}

async function skillView(name: string, resultsDir: string) {
    const runs = await loadRuns(resultsDir);
    const prov = [...runs].reverse().find(r => r.prov.eval_dir)?.prov || {};
    const evalDir: string | undefined = prov.eval_dir;
    const skillDirs: string[] = prov.skill_dirs || [];
    const out: any = {
        name, description: '', skill_md: '', skill_dirs: skillDirs, eval_dir: evalDir || null,
        has_eval: true,  // every skill here has results; `config` says whether its eval.yaml was found
        config: !!evalDir && await fs.pathExists(path.join(evalDir, 'eval.yaml')),
        tasks: [], summary: null, trials: {}, history: [],
    };
    const skillMd = skillDirs.length && path.join(skillDirs[0], 'SKILL.md');
    if (skillMd && await fs.pathExists(skillMd)) {
        const { fm, body } = frontmatter(await fs.readFile(skillMd, 'utf-8'));
        out.description = fm.description || '';
        out.skill_md = body;
    }
    let resolved: ResolvedTask[] = [];
    if (out.config) {
        const config = await loadEvalConfig(evalDir!);
        resolved = await Promise.all(config.tasks.map(t => resolveTask(t, config.defaults, evalDir!)));
        out.tasks = await Promise.all(resolved.map(async t => ({
            name: t.name, instruction: t.instruction, metadata: t.metadata || {},
            graders: await Promise.all(t.graders.map(g => graderView(g, t.baseDirs?.length ? t.baseDirs : [evalDir!]))),
            expected: t.expected == null || typeof t.expected === 'string' ? t.expected ?? null : JSON.stringify(t.expected, null, 2),
            solution: t.solution || null,
        })));
    } else {  // no eval.yaml to read: the tasks the reports name
        const seen = new Map<string, any>();
        for (const r of runs) for (const [, d] of r.tasks) seen.set(d.task, { name: d.task, instruction: '', metadata: d.metadata || {}, graders: [], expected: null, solution: null });
        out.tasks = [...seen.values()];
    }
    if (runs.length) {
        out.summary = summary(name, runs, out.tasks.map((t: any) => t.name));
        if (evalDir) {
            const inputs = [
                ...out.config ? await importedFiles(path.join(evalDir, 'eval.yaml')) : [],
                ...resolved.flatMap(t => t.workspace.map(w => path.resolve(evalDir, w.src))),
            ];
            out.history = history(evalDir, skillDirs, inputs, runs, out.summary);
        }
        // ponytail: every trial of every run in one payload; serve runs on demand past a few MB.
        for (const r of runs) {
            out.trials[r.id] = Object.fromEntries(r.tasks.map(([file, d]) => [file, (d.trials || []).map(trialView)]));
        }
    }
    return out;
}

export async function manifest(outputBase: string) {
    const root = path.resolve(outputBase);
    const names = (await fs.readdir(root).catch(() => [] as string[])).sort();
    const skills = [];
    for (const name of names) {
        const results = path.join(root, name, 'results');
        if (!await fs.pathExists(results)) continue;
        try {
            skills.push(await skillView(name, results));
        } catch (e) {  // one unreadable skill shouldn't blank the site: show why instead
            skills.push({ name, description: '', has_eval: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
        }
    }
    return { root, skills };
}
