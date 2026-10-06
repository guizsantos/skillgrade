/**
 * Parser and validator for eval.yaml config files.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    ResolvedGrader,
    WorkspaceMapping,
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

/**
 * Load and parse eval.yaml from a directory.
 */
export async function loadEvalConfig(dir: string): Promise<EvalConfig> {
    const yamlPath = path.join(dir, 'eval.yaml');
    if (!await fs.pathExists(yamlPath)) {
        throw new Error(`No eval.yaml found in ${dir}`);
    }

    // Sections may live in other files — expand every `$import` first
    const raw = await loadYamlWithImports(yamlPath);

    return validateConfig(raw);
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
            console.error(`  warning  eval.yaml: "${old}" in ${where} is deprecated, use "${now}"`);
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
        throw new Error('eval.yaml must be a YAML object');
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
            throw new Error('eval.yaml: acp.command is required when using ACP agent');
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
        throw new Error(`eval.yaml: llm_provider must be one of ${VALID_LLM_PROVIDERS.join(', ')}, got "${defaults.llm_provider}"`);
    }

    if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
        throw new Error('eval.yaml must have at least one task in the "tasks" array');
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

        const workspace: WorkspaceMapping[] = (t.workspace || []).map((w: any) => {
            if (typeof w === 'string') {
                // Support shorthand: "fixtures/app.js" → same filename in workspace
                return { src: w, dest: path.basename(w) };
            }
            if (!w.src || !w.dest) {
                throw new Error(`Task "${t.name}" has a workspace mapping without src/dest`);
            }
            return { src: w.src, dest: w.dest, chmod: w.chmod };
        });

        return {
            name: t.name,
            instruction: t.instruction,
            workspace,
            graders: t.graders.map((g: any) => {
                if (g.llm_provider && !VALID_LLM_PROVIDERS.includes(g.llm_provider)) {
                    throw new Error(`Task "${t.name}" grader has invalid llm_provider "${g.llm_provider}", must be one of ${VALID_LLM_PROVIDERS.join(', ')}`);
                }
                return {
                    type: g.type,
                    setup: g.setup,
                    run: g.run,
                    rubric: g.rubric,
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

    return { version, skill: raw.skill, defaults, tasks };
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
            if (g.type === 'llm_rubric' && g.rubric) {
                resolved.rubric = await resolveFileOrInline(g.rubric, baseDirs);
            }
            return resolved;
        })
    );

    // Resolve solution path
    const solution = task.solution
        ? await resolveExistingPath(task.solution, baseDirs)
        : undefined;

    return {
        name: task.name,
        instruction,
        workspace: task.workspace || [],
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
