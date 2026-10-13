/**
 * eval.yml configuration types.
 *
 * These types define the schema for a resource's `eval.yml` (inside an Eval
 * Project) that developers write to define evaluation tasks.
 */

/** Grader definition */
export interface EvalGraderConfig {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;                               // commands to install grader dependencies (runs during image build)
    run?: string;                                 // inline script or file path (deterministic)
    rubric?: string;                              // inline rubric or file path (llm_rubric)
    llm_judge?: string;                           // name of a reusable Judge in the eval's llm_judges/ (instead of a rubric)
    llm_model?: string;                           // llm_rubric: model override, e.g. 'claude-sonnet-5' or 'gemini-3-flash-preview'
    llm_provider?: LlmProvider;                   // llm_rubric: which LLM API scores it (default: 'gemini')
    weight: number;
}

/** LLM APIs an llm_rubric grader can score with */
export type LlmProvider = 'gemini' | 'anthropic' | 'openai' | 'jev';

/** Docker configuration */
export interface DockerConfig {
    base: string;       // base Docker image
    setup?: string;     // extra RUN commands for Dockerfile
}

/** Environment resource limits */
export interface EnvironmentConfig {
    cpus: number;
    memory_mb: number;
}

/** ACP (Agent Client Protocol) configuration */
export interface AcpConfig {
    /** Command to start the ACP agent (e.g., "gemini --acp") */
    command: string;
    /** Optional environment variables for the ACP process */
    env?: Record<string, string>;
}

/** Single eval task */
export interface EvalTaskConfig {
    name: string;
    instruction: string;    // inline text or path to .md file
    /** Task references (`name`, `name@resource`, `name@kind:resource`) whose workspaces this task starts from. */
    workspaceFrom?: string[];
    graders: EvalGraderConfig[];
    solution?: string;      // path to reference solution script

    /**
     * Reference output for this task — the row's answer key. Reaches graders
     * only (as `SKILLGRADE_INPUT` for deterministic, as a prompt section for
     * llm_rubric) and is never written into the agent's workspace. skillgrade
     * delivers it; it never interprets it.
     */
    expected?: unknown;

    /**
     * Labels used to select and slice tasks (`--filter tier=easy`). Never
     * reaches the agent; recorded with the results.
     */
    metadata?: Record<string, unknown>;

    // Per-task overrides
    harness?: string;
    model?: string;     // model the harness answers with (harnesses that support one)
    command?: string;   // command to run when the harness is 'command'
    runtime?: string;
    trials?: number;
    timeout?: number;
    llm_model?: string;
    llm_provider?: LlmProvider;
    docker?: DockerConfig;
    environment?: Partial<EnvironmentConfig>;

    /** Absolute path of the file this task was parsed from — set when the task came from a `$import`. */
    sourceFile?: string;
}

/** Top-level defaults */
export interface EvalDefaults {
    harness: string;    // the agent CLI under test: 'gemini-cli' | 'claude-code' | 'codex' | 'acp' | 'opencode' | 'command'
    model?: string;     // model the harness answers with (harnesses that support one)
    command?: string;   // command to run when the harness is 'command' (e.g. "node mycli.js")
    runtime: string;    // where trials run: 'docker' | 'local'
    trials: number;
    timeout: number;
    threshold: number;  // for --ci mode
    llm_model?: string;         // default model for llm_rubric graders
    llm_provider?: LlmProvider; // default LLM API for llm_rubric graders
    acp?: AcpConfig;    // ACP agent configuration
    docker: DockerConfig;
    environment: EnvironmentConfig;
}

/** A resource's eval.yml, with the Eval Project's defaults underneath its own */
export interface EvalConfig {
    version: string;
    defaults: EvalDefaults;
    tasks: EvalTaskConfig[];
}

/** Resolved task — all defaults applied, file references resolved to content */
export interface ResolvedTask {
    name: string;
    instruction: string;    // actual content (not file path)
    /** The folder named after the task under the eval's `workspace/`, if there is one; copied into the agent's workspace. */
    workspaceDir?: string;
    /** Workspace folders borrowed from other tasks (`workspace: [{task: ...}]`), copied in before `workspaceDir`. */
    borrowedWorkspaceDirs?: string[];
    graders: ResolvedGrader[];
    solution?: string;      // resolved file path
    expected?: unknown;                     // reference output — graders only, never the workspace
    metadata?: Record<string, unknown>;     // filterable labels — never sent to the agent
    harness: string;
    model?: string;         // model the harness answers with (harnesses that support one)
    command?: string;       // command to run when the harness is 'command'
    runtime: string;
    trials: number;
    timeout: number;
    llm_model?: string;           // inherited default model for llm_rubric graders
    llm_provider?: LlmProvider;   // inherited default LLM API for llm_rubric graders
    acp?: AcpConfig;        // ACP agent configuration
    docker: DockerConfig;
    environment: EnvironmentConfig;
    /** Directories that this task's relative paths resolve against, in order: its own file's dir, then the eval root. */
    baseDirs?: string[];
}

export interface ResolvedGrader {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;                               // resolved setup commands
    run?: string;                                 // resolved content for deterministic
    rubric?: string;                              // resolved content for llm_rubric
    llm_model?: string;                           // resolved model override
    llm_provider?: LlmProvider;                   // which LLM API scores it (default: 'gemini')
    weight: number;
}
