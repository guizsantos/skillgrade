/**
 * `skillgrade` (run) command.
 *
 * Reads an Eval Project, resolves each resource's tasks, and executes the evals.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { EVAL_FILE, loadEvalConfig, resolveTask } from '../core/config';
import { TaskFilter, describeSelection, metadataKeys, selectTasks } from '../core/filter';
import { PROJECT_FILE, Resource, loadProject, testedResources } from '../core/project';
import { DockerProvider } from '../providers/docker';
import { LocalProvider } from '../providers/local';
import { EvalRunner, EvalRunOptions } from '../evalRunner';
import { createAgent, AgentConfig, harnessName } from '../agents/registry';
import { BaseAgent, EvalReport } from '../types';
import { EvalConfig, EvalTaskConfig, ResolvedTask } from '../core/config.types';
import { parseEnvFile } from '../utils/env';
import { gitProvenance, headWorktree, pruneWorktrees, repoRoot, uncommitted } from '../core/provenance';
import { importedFiles } from '../core/imports';
import { appendTrialRecords, buildTrialRecords, deliveryFor, harnessVersion } from '../core/trialRecords';
import { fmt, header, kv, progress, resultsSummary, validationResult } from '../utils/cli';

/** Agents that accept a model on the command line. */
const MODEL_AWARE_HARNESSES = new Set(['gemini-cli', 'claude-code', 'codex', 'opencode']);

interface RunOptions {
    eval?: string;       // run specific eval(s) by name (comma-separated)
    filters?: TaskFilter[];   // --filter / --not-filter over task metadata
    filterPattern?: string;   // --filter-pattern regex over task names
    list?: boolean;           // print the selection and run nothing
    trials?: number;     // override trial count
    parallel?: number;
    validate?: boolean;
    ci?: boolean;
    threshold?: number;
    preset?: 'smoke' | 'reliable' | 'regression';
    harness?: string;    // override the agent CLI under test (gemini-cli|claude-code|codex|acp|opencode|command)
    model?: string;      // override the model the harness answers with (gemini-cli, claude-code, codex, opencode)
    runtime?: string;    // override where trials run (docker|local)
    output?: string;     // output directory for reports and temp files
    grader?: string;     // filter graders by type (deterministic|llm_rubric)
    acpCommand?: string; // ACP agent command (e.g., "gemini --acp")
    command?: string;    // command agent command (e.g., "node mycli.js")
    openCodeAgent?: string;   // OpenCode agent (build|plan|explore)
    openCodeModel?: string;   // OpenCode model (provider/model format)
    fromHead?: boolean;  // with uncommitted inputs: evaluate HEAD from a worktree, leaving them out
}

/** One resource with an eval, and the tasks of it that a run selected. */
interface Target {
    resource: Resource;
    config: EvalConfig;
    tasks: EvalTaskConfig[];
}

async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
    if (await fs.pathExists(filePath)) {
        return parseEnvFile(await fs.readFile(filePath, 'utf-8'));
    }
    return {};
}

export async function runEvals(dir: string, opts: RunOptions) {
    console.log(`\n${fmt.bold('skillgrade')}\n`);

    // Load environment variables
    const rootEnv = await loadEnvFile(path.join(dir, '.env'));
    const env: Record<string, string> = { ...rootEnv };
    if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (Object.keys(rootEnv).length > 0) {
        kv('env', Object.keys(rootEnv).join(', '));
    }

    let { targets } = await loadSuite(dir, opts, true);
    const allTasks = targets.flatMap(t => t.config.tasks);
    const selected = targets.reduce((n, t) => n + t.tasks.length, 0);
    if (selected !== allTasks.length) {
        kv('selected', `${selected} of ${allTasks.length} tasks`);
    }

    if (opts.list) {
        for (const t of targets) {
            header(`${t.resource.name} tasks (${t.tasks.length})`);
            for (const line of describeSelection(t.tasks)) {
                console.log(`    ${line}`);
            }
        }
        const keys = metadataKeys(allTasks);
        console.log(`\n  ${fmt.dim('metadata keys:')} ${keys.join(', ') || '(none)'}\n`);
        return;
    }

    if (selected === 0) {
        console.error(`  ${fmt.red('error')}  no tasks match the selection`);
        console.log(`  ${fmt.dim('metadata keys:')} ${metadataKeys(allTasks).join(', ') || '(none)'}`);
        throw new Error('No tasks match the selection');
    }

    // A run evaluates a commit, so uncommitted inputs stop it. --validate grades
    // the working tree on purpose: it produces no comparable result, and is exempt.
    if (opts.fromHead && opts.validate) {
        throw new Error('--from-head is for real runs; --validate grades the working tree');
    }
    const root = opts.validate ? null : repoRoot(dir);
    if (opts.fromHead && !root) {
        throw new Error('--from-head needs a git repo with a commit to evaluate');
    }
    let ignored: string[] = [];
    if (root) {
        pruneWorktrees(root);  // a crashed --from-head run's leftover
        ignored = uncommitted(root, (await runInputs(dir, targets)).all);
        if (ignored.length && !opts.fromHead) {
            console.error(`  ${fmt.red('error')}  uncommitted changes to this eval's inputs:`);
            for (const line of ignored) console.error(`    ${line}`);
            console.error(`\n  A run evaluates a commit. Commit them, or pass --from-head to evaluate HEAD without them.\n`);
            throw new Error('Uncommitted changes to the eval inputs');
        }
    }

    // Output directory: in this tree, even when the inputs come from a worktree.
    // Each resource's results and scratch space sit under its own name.
    const outputBase = opts.output || path.join(os.tmpdir(), 'skillgrade');
    kv('output', outputBase);

    // --from-head: read every input from a worktree at HEAD, removed however the run ends
    const head = ignored.length ? headWorktree(root!) : null;
    const onSignal = (signal: NodeJS.Signals) => {
        head?.remove();
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    if (head) {
        console.error(`  ${fmt.red('warning')}  --from-head: evaluating HEAD; these uncommitted changes are NOT evaluated:`);
        for (const line of ignored) console.error(`    ${line}`);
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
    }
    try {
        const src = head ? head.at(dir) : dir;
        if (head) {
            if (!await fs.pathExists(path.join(src, PROJECT_FILE))) {
                throw new Error(`${PROJECT_FILE} is not committed at HEAD: nothing to evaluate`);
            }
            ({ targets } = await loadSuite(src, opts, false));
        }

        // Taken before the run: files edited mid-run don't count. One run id for every resource.
        const now = new Date();
        const provenanceOf = new Map<Target, ReturnType<typeof gitProvenance>>();
        for (const t of targets) {
            let provenance = gitProvenance(t.resource.evalDir, [t.resource.dir], (await runInputs(src, [t])).imported, now);
            if (head) {
                provenance = {
                    ...provenance, eval_dir: head.back(provenance.eval_dir),
                    skill_dirs: provenance.skill_dirs.map(head.back), from_head: true, ignored,
                };
            }
            provenanceOf.set(t, provenance);
        }

        // Track CI results
        const reports: EvalReport[] = [];
        let allPassed = true;

        // Agents whose CLI takes a model; the rest ignore --model and are told so.
        const warnedNoModelSupport = new Set<string>();

        // Each Harness's version is read once per run, however many tasks use it
        const harnessVersions = new Map<string, string>();

        // Run each task of each resource
        const jobs = targets.flatMap(target => target.tasks.map(taskDef => ({ target, taskDef })));
        let taskIndex = 0;
        for (const { target, taskDef } of jobs) {
            taskIndex++;
            const { config, resource } = target;
            const evalDir = resource.evalDir;
            const skillsPaths = [resource.dir];
            const outputDir = path.join(outputBase, resource.name);
            const resultsDir = path.join(outputDir, 'results');
            await fs.ensureDir(resultsDir);

            const resolved = await resolveTask(taskDef, config.defaults, evalDir);
            const trials = opts.trials ?? resolved.trials;
            const parallel = opts.parallel ?? 1;

            // Pick the harness: CLI flag > task-level override > auto-detect from API key > default
            let agentName = opts.harness ? harnessName(opts.harness) : resolved.harness;
            if (!opts.harness && !taskDef.harness) {
                // No explicit override — auto-detect from available API keys
                const hasGemini = !!env.GEMINI_API_KEY;
                const hasAnthropic = !!env.ANTHROPIC_API_KEY;
                const hasOpenAI = !!env.OPENAI_API_KEY;
                const keyCount = [hasGemini, hasAnthropic, hasOpenAI].filter(Boolean).length;
                if (keyCount === 1) {
                    if (hasAnthropic) agentName = 'claude-code';
                    else if (hasOpenAI) agentName = 'codex';
                    else if (hasGemini) agentName = 'gemini-cli';
                }
            }
            const providerName = opts.runtime || resolved.runtime;
            // The task dir is laid out for these: the Dockerfile installs the harness that
            // runs, and workspace files go where the runtime that runs expects them
            resolved.harness = agentName;
            resolved.runtime = providerName;

            // Two temp dirs per task: what the agent's workspace is built from, and the
            // grader files, which only reach the workspace once the agent has exited
            const tmpTaskDir = path.join(outputDir, 'tmp', resolved.name);
            const tmpGraderDir = path.join(outputDir, 'tmp-graders', resolved.name);
            await prepareTempTaskDir(resolved, evalDir, tmpTaskDir, tmpGraderDir);

            // Build eval options — pass resolved content directly
            const evalOpts: EvalRunOptions = {
                instruction: resolved.instruction,
                graders: opts.grader
                    ? resolved.graders.filter(g => g.type === opts.grader)
                    : resolved.graders,
                timeoutSec: resolved.timeout,
                llmModel: resolved.llm_model,
                llmProvider: resolved.llm_provider,
                expected: resolved.expected,
                metadata: resolved.metadata,
                environment: resolved.environment,
                graderDir: tmpGraderDir,
            };

            // CLI flag > task-level override > defaults; undefined means the harness decides
            const requestedModel = opts.model || resolved.model;
            // Only reported when it is actually used — printing a model the harness
            // ignores would make a run look like something it was not.
            const modelName = MODEL_AWARE_HARNESSES.has(agentName) ? requestedModel : undefined;
            if (requestedModel && !modelName && !warnedNoModelSupport.has(agentName)) {
                warnedNoModelSupport.add(agentName);
                console.error(`  ${fmt.red('warning')}  --model is ignored by the "${agentName}" harness`);
            }

            // Build agent config
            const agentConfig: AgentConfig = {};
            if (agentName === 'claude-code') {
                if (modelName) agentConfig.claude = { model: modelName };
            } else if (agentName === 'gemini-cli') {
                if (modelName) agentConfig.gemini = { model: modelName };
            } else if (agentName === 'codex') {
                if (modelName) agentConfig.codex = { model: modelName };
            } else if (agentName === 'acp') {
                const acpCommand = opts.acpCommand || resolved.acp?.command;
                if (!acpCommand) {
                    throw new Error('The acp harness requires a command. Specify via --acp-command or acp.command in eval.yml');
                }
                agentConfig.acp = {
                    command: acpCommand,
                    env: resolved.acp?.env,
                    apiKey: env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY,
                };
            } else if (agentName === 'opencode') {
                agentConfig.opencode = {};
                if (opts.openCodeAgent) {
                    agentConfig.opencode.agent = opts.openCodeAgent;
                }
                // --opencode-model predates --model and stays the more specific one
                const openCodeModel = opts.openCodeModel || modelName;
                if (openCodeModel) {
                    agentConfig.opencode.model = openCodeModel;
                }
            } else if (agentName === 'command') {
                const command = opts.command || resolved.command;
                if (!command) {
                    throw new Error('The command harness requires a command. Specify via --command or command in eval.yml');
                }
                agentConfig.command = { command };
            }

            // Pick the runtime
            const provider = providerName === 'docker'
                ? new DockerProvider()
                : new LocalProvider();

            const runner = new EvalRunner(provider, resultsDir, opts.validate ? undefined : {
                ...provenanceOf.get(target)!, harness: agentName, model: modelName ?? null,
            });

            if (opts.validate) {
                // Validation mode
                if (!resolved.solution) {
                    console.error(`  ${fmt.red('error')}  task "${resolved.name}" has no solution defined`);
                    continue;
                }

                header(`validate: ${resource.name} / ${resolved.name}`);

                // The solution lives in the eval, outside the workspace: put it there for this run only
                const solution = resolved.solution;
                const solveAgent = {
                    async run(_instruction: string, _workspace: string, runCommand: any) {
                        const script = path.basename(solution);
                        const b64 = (await fs.readFile(solution)).toString('base64');
                        await runCommand(`echo '${b64}' | base64 -d > '${script}'`);
                        const result = await runCommand(`bash '${script}'`);
                        return result.stdout;
                    }
                } as BaseAgent;

                const report = await runner.runEval(solveAgent, tmpTaskDir, skillsPaths, evalOpts, 1, env);
                const passed = report.trials[0].reward >= 0.5;

                validationResult(passed, report.trials[0].reward, report.trials[0].grader_results.map(gr => ({
                    type: gr.grader_type,
                    score: gr.score,
                    details: gr.details
                })));

                if (!passed) allPassed = false;
            } else {
                // Normal eval mode
                const agent = createAgent(agentName, agentConfig);

                header(`${resource.name} / ${resolved.name}  ${fmt.dim(`(${taskIndex}/${jobs.length})`)}`);
                console.log(`    ${fmt.dim('harness')} ${agentName}${modelName ? `  ${fmt.dim('model')} ${modelName}` : ''}  ${fmt.dim('runtime')} ${providerName}  ${fmt.dim('trials')} ${trials}${parallel > 1 ? `  ${fmt.dim('parallel')} ${parallel}` : ''}`);
                console.log();

                try {
                    const report = await runner.runEval(agent, tmpTaskDir, skillsPaths, evalOpts, trials, env, parallel);
                    reports.push(report);

                    // One Trial Record per trial, beside the report
                    const versionKey = `${agentName}:${providerName}`;
                    if (!harnessVersions.has(versionKey)) harnessVersions.set(versionKey, harnessVersion(agentName, providerName));
                    await appendTrialRecords(resultsDir, report.provenance!.run_id, buildTrialRecords(report, {
                        resource,
                        provenance: report.provenance!,
                        harness: agentName,
                        harnessVersion: harnessVersions.get(versionKey)!,
                        llm: agentConfig.opencode?.model ?? modelName,
                        delivery: deliveryFor(resource.kind),
                        date: now,
                    }));

                    // LLM grader reasoning (condensed)
                    for (const trial of report.trials) {
                        for (const g of trial.grader_results.filter(g => g.grader_type === 'llm_rubric')) {
                            console.log(`    ${fmt.dim(`trial ${trial.trial_id} llm_rubric:`)} ${g.details.substring(0, 120)}`);
                        }
                    }

                    resultsSummary(report.pass_rate, report.pass_at_k, report.pass_pow_k, trials, opts.preset);

                    if (report.pass_rate < (opts.threshold ?? config.defaults.threshold)) {
                        allPassed = false;
                    }
                } catch (err) {
                    console.error(`\n  ${fmt.fail('error')}  evaluation failed: ${err}\n`);
                    allPassed = false;
                }
            }

            // How far through the selected tasks we are. Pointless for a single
            // task, and the run is otherwise silent about it until the very end.
            if (jobs.length > 1) {
                progress(taskIndex, jobs.length);
            }

            // Cleanup temp dirs
            try { await fs.remove(tmpTaskDir); } catch { /* ignore cleanup errors */ }
            try { await fs.remove(tmpGraderDir); } catch { /* ignore cleanup errors */ }
        }

        // CI mode: exit with appropriate code
        if (opts.ci) {
            const ciThreshold = opts.threshold ?? targets[0].config.defaults.threshold;
            if (!allPassed) {
                console.error(`\n  ${fmt.fail('CI FAILED')}  below threshold ${(ciThreshold * 100).toFixed(0)}%\n`);
                throw new Error('CI check failed');
            }
            console.log(`\n  ${fmt.pass('CI PASSED')}  above threshold ${(ciThreshold * 100).toFixed(0)}%\n`);
        }
    } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        head?.remove();
    }
}

/** The Eval Project's resources with an eval, and the tasks of each that the selection picks. */
async function loadSuite(dir: string, opts: RunOptions, log: boolean) {
    const project = await loadProject(dir);
    const resources = await testedResources(project);
    if (resources.length === 0) {
        throw new Error(`No evals in ${dir}: add <kind>/<name>/${EVAL_FILE} for a resource found in search_paths`);
    }
    if (log) kv('skills', resources.filter(r => r.kind === 'skill').map(r => r.name).join(', '));

    // Select which of the tasks to run: by name, by name pattern, by metadata. A
    // selection that does not fit one resource's tasks just leaves that one out,
    // and is an error only when it fits none.
    const selection = {
        names: opts.eval?.split(',').map(s => s.trim()).filter(Boolean),
        filters: opts.filters,
        pattern: opts.filterPattern,
    };
    const targets: Target[] = [];
    const errors: unknown[] = [];
    for (const resource of resources) {
        const config = await loadEvalConfig(resource.evalDir, project.defaults);
        try {
            targets.push({ resource, config, tasks: selectTasks(config.tasks, selection) });
        } catch (err) {
            // Only "no task by that name here" may pass: a bad filter or pattern is wrong everywhere
            if (!(err instanceof Error && /^Eval ".*" not found$/.test(err.message))) throw err;
            errors.push(err);
            targets.push({ resource, config, tasks: [] });
        }
    }
    if (errors.length === targets.length) {
        const err = errors[0];
        if (!log) throw err;
        console.error(`  ${fmt.red('error')}  ${err instanceof Error ? err.message : err}`);
        if (opts.eval) {
            console.log(`  ${fmt.dim('available:')} ${targets.flatMap(t => t.config.tasks.map(task => task.name)).join(', ')}`);
        }
        throw err;
    }
    return { targets };
}

/** Every file a run reads that git tracks: the project, its evals and their imports, the resources. */
async function runInputs(dir: string, targets: Target[]) {
    const imported = [...new Set([
        path.join(dir, PROJECT_FILE),
        ...(await Promise.all(targets.map(t => importedFiles(path.join(t.resource.evalDir, EVAL_FILE))))).flat(),
    ])];
    return { imported, all: [dir, ...imported, ...targets.map(t => t.resource.dir)] };
}

/**
 * Create the temp dirs for one task.
 *
 * `agentDir` is what the agent's workspace is built from: the task's workspace
 * folder and, for Docker, the Dockerfile. `graderDir` holds the grader scripts
 * and rubrics, copied into the workspace only after the agent has exited.
 * No task.toml or instruction.md — those are passed directly.
 */
export async function prepareTempTaskDir(resolved: ResolvedTask, baseDir: string, agentDir: string, graderDir: string) {
    await fs.ensureDir(agentDir);
    await fs.ensureDir(graderDir);

    // An imported task looks for its files next to its own file first
    const baseDirs = resolved.baseDirs?.length ? resolved.baseDirs : [baseDir];
    const findSrc = async (ref: string) => {
        for (const dir of baseDirs) {
            const candidate = path.resolve(dir, ref);
            if (await fs.pathExists(candidate)) return candidate;
        }
        return null;
    };

    // Write each deterministic grader script
    await fs.ensureDir(path.join(graderDir, 'tests'));
    const detGraders = resolved.graders.filter(g => g.type === 'deterministic');
    for (let i = 0; i < detGraders.length; i++) {
        if (detGraders[i].run) {
            const script = `#!/bin/bash\n${detGraders[i].run!.trim()}\n`;
            const filename = i === 0 ? 'test.sh' : `test_${i}.sh`;
            await fs.writeFile(path.join(graderDir, 'tests', filename), script);
        }
    }

    // Copy referenced grader files/directories
    for (const g of resolved.graders) {
        if (g.type === 'deterministic' && g.run) {
            const pathMatches = g.run.match(/[\w./-]+\.\w{1,4}/g) || [];
            for (const ref of pathMatches) {
                const refDir = ref.split('/')[0];
                const srcDir = await findSrc(refDir);
                const destDir = path.join(graderDir, refDir);
                if (refDir !== ref && srcDir && !await fs.pathExists(destDir)) {
                    await fs.copy(srcDir, destDir);
                }
            }
        }
    }

    // Write each LLM rubric
    await fs.ensureDir(path.join(graderDir, 'prompts'));
    const llmGraders = resolved.graders.filter(g => g.type === 'llm_rubric');
    for (let i = 0; i < llmGraders.length; i++) {
        if (llmGraders[i].rubric) {
            const filename = i === 0 ? 'quality.md' : `quality_${i}.md`;
            await fs.writeFile(path.join(graderDir, 'prompts', filename), llmGraders[i].rubric!);
        }
    }

    // The task's workspace folder; without one the workspace starts empty
    if (resolved.workspaceDir) {
        await fs.copy(resolved.workspaceDir, agentDir);
    }

    // Only the Docker runtime builds an image
    if (resolved.runtime !== 'docker') return;

    // Write Dockerfile
    await fs.ensureDir(path.join(agentDir, '.skillgrade'));
    let dockerfileContent = `FROM ${resolved.docker.base}\n\nWORKDIR /workspace\n\n`;

    // Install the harness
    if (resolved.harness === 'gemini-cli') {
        dockerfileContent += `RUN npm install -g @google/gemini-cli\n\n`;
    } else if (resolved.harness === 'claude-code') {
        dockerfileContent += `RUN npm install -g @anthropic-ai/claude-code\n\n`;
    } else if (resolved.harness === 'codex') {
        dockerfileContent += `RUN npm install -g @openai/codex\n\n`;
    } else if (resolved.harness === 'acp') {
        dockerfileContent += `RUN npm install -g @google/gemini-cli\n\n`;
    } else if (resolved.harness === 'opencode') {
        dockerfileContent += `RUN npm install -g opencode\n\n`;
    }
    // The 'command' harness brings its own binary — install it via docker.setup
    // below, or use `runtime: local` to run a command on the host.

    // Docker setup commands
    if (resolved.docker.setup) {
        dockerfileContent += `RUN ${resolved.docker.setup.trim()}\n\n`;
    }

    // Grader setup commands
    for (const g of resolved.graders) {
        if (g.setup) {
            dockerfileContent += `# Grader setup\nRUN ${g.setup.trim()}\n\n`;
        }
    }

    // The workspace files come in with the build context; the Dockerfile itself stays out of the workspace
    dockerfileContent += `COPY . .\nRUN rm -rf .skillgrade\nCMD ["bash"]\n`;
    await fs.writeFile(path.join(agentDir, '.skillgrade', 'Dockerfile'), dockerfileContent);
}
