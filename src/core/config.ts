/**
 * Parser and validator for a resource's eval.yml (inside an Eval Project).
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    ResolvedGrader,
    EnvironmentConfig,
    AcpConfig,
    LlmProvider,
} from './config.types';
import { loadYamlWithImports, sourceFileOf } from './imports';
import { harnessName } from '../agents/registry';

// We use a simple YAML parser — js-yaml is the standard
// For now, we'll use a lightweight approach: JSON-compatible YAML subset

const DEFAULT_CONFIG: EvalDefaults = {
    harness: 'gemini-cli',
    runtime: 'docker',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    docker: {
        base: 'node:20-slim',
    },
    environment: {
        cpus: 2,
        memory_mb: 2048,
    },
};

/** The file a resource's eval lives in, inside its directory of the Eval Project. */
export const EVAL_FILE = 'eval.yml';
export const LEGACY_EVAL_FILE = 'eval.yaml';

/**
 * Load and parse a resource's eval.yml from its eval directory. The Eval
 * Project's `defaults` sit underneath the eval's own.
 */
export async function loadEvalConfig(evalDir: string, projectDefaults: Record<string, any> = {}): Promise<EvalConfig> {
    const legacy = path.join(evalDir, LEGACY_EVAL_FILE);
    if (await fs.pathExists(legacy)) {
        throw new Error(`${legacy}: eval.yaml is no longer supported. Rename it to ${EVAL_FILE}, move it to <eval project>/<kind>/<name>/, and drop the \`skill:\` and \`workspace:\` keys (see docs).`);
    }
    const yamlPath = path.join(evalDir, EVAL_FILE);
    if (!await fs.pathExists(yamlPath)) {
        throw new Error(`No ${EVAL_FILE} found in ${evalDir}`);
    }

    // Sections may live in other files — expand every `$import` first
    const raw = await loadYamlWithImports(yamlPath);
    if (raw && typeof raw === 'object') {
        raw.defaults = mergeDefaults(projectDefaults, raw.defaults);
    }

    const config = validateConfig(raw);
    await checkJudges(config, evalDir);
    return config;
}

/** Where a resource's reusable Judges are, inside its directory of the Eval Project. */
export const JUDGES_DIR = 'llm_judges';
export const judgeFile = (evalDir: string, name: string) => path.join(evalDir, JUDGES_DIR, `${name}.md`);

/** Every `llm_judge:` names a definition that exists, so a bad name fails before any trial runs. */
async function checkJudges(config: EvalConfig, evalDir: string) {
    for (const task of config.tasks) {
        for (const g of task.graders) {
            if (g.llm_judge === undefined) continue;
            const file = judgeFile(evalDir, g.llm_judge);
            const stat = await fs.stat(file).catch(() => null);
            if (!stat?.isFile()) {
                throw new Error(`${path.basename(evalDir)}: task "${task.name}" uses llm_judge "${g.llm_judge}", but there is no ${JUDGES_DIR}/${g.llm_judge}.md in ${evalDir}`);
            }
            if (!(await fs.readFile(file, 'utf-8')).trim()) {
                throw new Error(`${path.basename(evalDir)}: llm_judge "${g.llm_judge}" is empty (${file}); a judge needs a rubric`);
            }
        }
    }
}

/** `own` over `base`, one level deeper for the nested settings. */
function mergeDefaults(base: Record<string, any>, own: Record<string, any> = {}): Record<string, any> {
    const merged = { ...base, ...own };
    for (const key of ['docker', 'environment', 'acp']) {
        if (base[key] && own[key]) merged[key] = { ...base[key], ...own[key] };
    }
    return merged;
}

const VALID_LLM_PROVIDERS: LlmProvider[] = ['gemini', 'anthropic', 'openai', 'jev'];

/** Keys renamed so each names one thing; the old ones still load, with a warning. */
const RENAMED_KEYS: Record<string, string> = {
    agent: 'harness',              // the agent CLI under test
    provider: 'runtime',           // where trials run
    grader_provider: 'llm_provider',
    grader_model: 'llm_model',
};
const RENAMED_GRADER_KEYS: Record<string, string> = { provider: 'llm_provider', model: 'llm_model' };
const warned = new Set<string>();

/** Rewrite deprecated keys of `obj` in place; `where` names it in the warning. */
function renameLegacyKeys(obj: any, renames: Record<string, string>, where: string) {
    if (!obj || typeof obj !== 'object') return;
    for (const [old, now] of Object.entries(renames)) {
        if (!(old in obj)) continue;
        if (!warned.has(`${where}.${old}`)) {
            warned.add(`${where}.${old}`);
            console.error(`  warning  eval.yml: "${old}" in ${where} is deprecated, use "${now}"`);
        }
        if (!(now in obj)) obj[now] = obj[old];
        delete obj[old];
    }
}

/**
 * Validate raw parsed YAML into a typed EvalConfig.
 */
function validateConfig(raw: any): EvalConfig {
    if (!raw || typeof raw !== 'object') {
        throw new Error('eval.yml must be a YAML object');
    }
    if ('skill' in raw) {
        throw new Error('eval.yml has a "skill:" key. The resource is the directory this eval sits in (<kind>/<name>/); drop the key');
    }

    renameLegacyKeys(raw.defaults, RENAMED_KEYS, 'defaults');
    for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
        renameLegacyKeys(t, RENAMED_KEYS, 'a task');
        for (const g of Array.isArray(t?.graders) ? t.graders : []) renameLegacyKeys(g, RENAMED_GRADER_KEYS, 'a grader');
    }

    const version = raw.version || '1';

    // Handle ACP config
    let acp: AcpConfig | undefined;
    if (raw.defaults?.acp) {
        if (!raw.defaults.acp.command) {
            throw new Error('eval.yml: acp.command is required when using ACP agent');
        }
        acp = {
            command: raw.defaults.acp.command,
            env: raw.defaults.acp.env,
        };
    }

    const defaults: EvalDefaults = {
        ...DEFAULT_CONFIG,
        ...(raw.defaults || {}),
        docker: {
            ...DEFAULT_CONFIG.docker,
            ...(raw.defaults?.docker || {}),
        },
        environment: {
            ...DEFAULT_CONFIG.environment,
            ...(raw.defaults?.environment || {}),
        },
    };

    // Add ACP config if present
    if (acp) {
        defaults.acp = acp;
    }

    defaults.harness = harnessName(defaults.harness);
    if (defaults.llm_provider && !VALID_LLM_PROVIDERS.includes(defaults.llm_provider)) {
        throw new Error(`eval.yml: llm_provider must be one of ${VALID_LLM_PROVIDERS.join(', ')}, got "${defaults.llm_provider}"`);
    }

    if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
        throw new Error('eval.yml must have at least one task in the "tasks" array');
    }

    const tasks: EvalTaskConfig[] = raw.tasks.map((t: any, i: number) => {
        if (!t.name) throw new Error(`Task ${i} is missing a "name"`);
        if (!t.instruction) throw new Error(`Task "${t.name}" is missing an "instruction"`);
        if (!t.graders || !Array.isArray(t.graders) || t.graders.length === 0) {
            throw new Error(`Task "${t.name}" must have at least one grader`);
        }
        if (t.llm_provider && !VALID_LLM_PROVIDERS.includes(t.llm_provider)) {
            throw new Error(`Task "${t.name}" has invalid llm_provider "${t.llm_provider}", must be one of ${VALID_LLM_PROVIDERS.join(', ')}`);
        }
        const harness = t.harness ? harnessName(t.harness) : undefined;

        // The "command" harness requires a command (per-task override or inherited default)
        const effectiveCommand = t.command || defaults.command;
        if ((harness || defaults.harness) === 'command' && !effectiveCommand) {
            throw new Error(`Task "${t.name}" uses the "command" harness but no command is set (add a "command" to the task or defaults)`);
        }

        if (t.metadata !== undefined && (typeof t.metadata !== 'object' || t.metadata === null || Array.isArray(t.metadata))) {
            throw new Error(`Task "${t.name}" has a "metadata" that is not an object — metadata holds key/value labels used by --filter`);
        }

        // The task's workspace is the folder named after it, so the name must be a safe folder name
        if (typeof t.name !== 'string' || /[\\/]/.test(t.name) || t.name === '.' || t.name === '..') {
            throw new Error(`Task name "${t.name}" must be a plain name: it is also the name of the task's workspace/ folder`);
        }
        if (t.workspace !== undefined) {
            throw new Error(`Task "${t.name}" has a "workspace:" key. A task's workspace is the folder workspace/${t.name}/ next to eval.yml; put its files there and drop the key`);
        }

        return {
            name: t.name,
            instruction: t.instruction,
            graders: t.graders.map((g: any) => {
                if (g.llm_provider && !VALID_LLM_PROVIDERS.includes(g.llm_provider)) {
                    throw new Error(`Task "${t.name}" grader has invalid llm_provider "${g.llm_provider}", must be one of ${VALID_LLM_PROVIDERS.join(', ')}`);
                }
                if (g.llm_judge !== undefined) {
                    if (typeof g.llm_judge !== 'string' || !/^[\w][\w.-]*$/.test(g.llm_judge)) {
                        throw new Error(`Task "${t.name}" grader has an invalid llm_judge ${JSON.stringify(g.llm_judge)}: it must be the plain name of a file in ${JUDGES_DIR}/`);
                    }
                    if (g.rubric !== undefined) {
                        throw new Error(`Task "${t.name}" grader has both "rubric" and "llm_judge": the judge is the rubric, use one`);
                    }
                    if (g.type !== undefined && g.type !== 'llm_rubric') {
                        throw new Error(`Task "${t.name}" grader has llm_judge but type "${g.type}": a judge is an llm_rubric grader`);
                    }
                }
                return {
                    type: g.llm_judge !== undefined ? 'llm_rubric' : g.type,
                    setup: g.setup,
                    run: g.run,
                    rubric: g.rubric,
                    llm_judge: g.llm_judge,
                    llm_model: g.llm_model,
                    llm_provider: g.llm_provider,
                    weight: g.weight ?? 1.0,
                };
            }),
            solution: t.solution,
            expected: t.expected,
            metadata: t.metadata,
            harness,
            model: t.model,
            command: t.command,
            runtime: t.runtime,
            trials: t.trials,
            timeout: t.timeout,
            llm_model: t.llm_model,
            llm_provider: t.llm_provider,
            docker: t.docker,
            environment: t.environment,
            sourceFile: sourceFileOf(t),
        };
    });

    return { version, defaults, tasks };
}

/**
 * Resolve a single task: apply defaults, resolve file references to content.
 */
export async function resolveTask(
    task: EvalTaskConfig,
    defaults: EvalDefaults,
    baseDir: string
): Promise<ResolvedTask> {
    // Merge defaults with task overrides
    const harness = task.harness || defaults.harness;
    const model = task.model || defaults.model;
    const command = task.command || defaults.command;
    const runtime = task.runtime || defaults.runtime;
    const trials = task.trials ?? defaults.trials;
    const timeout = task.timeout ?? defaults.timeout;
    const docker = {
        ...defaults.docker,
        ...(task.docker || {}),
    };
    const environment: EnvironmentConfig = {
        ...defaults.environment,
        ...(task.environment || {}),
    };
    const llm_model = task.llm_model || defaults.llm_model;
    const llm_provider = task.llm_provider || defaults.llm_provider;
    const acp = defaults.acp;  // ACP config is only at defaults level

    // An imported task's relative paths belong to its own directory first,
    // then fall back to the eval root so shared graders/fixtures keep working.
    const baseDirs = [...new Set([
        ...(task.sourceFile ? [path.dirname(task.sourceFile)] : []),
        baseDir,
    ])];

    // Resolve instruction — could be inline text or file path
    const instruction = await resolveFileOrInline(task.instruction, baseDirs);

    // Resolve graders
    const graders: ResolvedGrader[] = await Promise.all(
        task.graders.map(async g => {
            const resolved: ResolvedGrader = {
                type: g.type,
                setup: g.setup,
                llm_model: g.llm_model,
                llm_provider: g.llm_provider,
                weight: g.weight,
            };
            if (g.type === 'deterministic' && g.run) {
                resolved.run = await resolveFileOrInline(g.run, baseDirs);
            }
            if (g.llm_judge !== undefined) {
                resolved.rubric = (await fs.readFile(judgeFile(baseDir, g.llm_judge), 'utf-8')).trim();
            } else if (g.type === 'llm_rubric' && g.rubric) {
                resolved.rubric = await resolveFileOrInline(g.rubric, baseDirs);
            }
            return resolved;
        })
    );

    // Resolve solution path
    const solution = task.solution
        ? await resolveExistingPath(task.solution, baseDirs)
        : undefined;

    // The task's workspace is the folder named after it; no folder means an empty workspace
    const taskWorkspace = path.join(baseDir, 'workspace', task.name);
    const workspaceDir = await fs.pathExists(taskWorkspace) ? taskWorkspace : undefined;

    return {
        name: task.name,
        instruction,
        workspaceDir,
        graders,
        solution,
        expected: task.expected,
        metadata: task.metadata,
        harness,
        model,
        command,
        runtime,
        trials,
        timeout,
        llm_model,
        llm_provider,
        acp,
        docker,
        environment,
        baseDirs,
    };
}

/**
 * If value looks like a file path and the file exists, read it.
 * Otherwise return the value as-is (inline content).
 */
async function resolveFileOrInline(value: string, baseDirs: string[]): Promise<string> {
    const trimmed = value.trim();

    // Multi-line strings are always inline content
    if (trimmed.includes('\n')) return trimmed;

    // Check if it could be a file path (no spaces except in path, has extension)
    for (const baseDir of baseDirs) {
        const candidate = path.resolve(baseDir, trimmed);
        if (await fs.pathExists(candidate)) {
            return (await fs.readFile(candidate, 'utf-8')).trim();
        }
    }

    return trimmed;
}

/** Resolve a relative path against the first base dir that contains it. */
async function resolveExistingPath(value: string, baseDirs: string[]): Promise<string> {
    for (const baseDir of baseDirs) {
        const candidate = path.resolve(baseDir, value);
        if (await fs.pathExists(candidate)) return candidate;
    }
    return path.resolve(baseDirs[baseDirs.length - 1], value);
}
