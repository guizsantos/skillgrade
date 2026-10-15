/**
 * The Harness capability table: one row per Harness, the single source of
 * truth for what each one supports. Changing a Harness's behavior means
 * changing its row here and nothing else.
 */
import { harnessName } from './registry';

export interface HarnessCapabilities {
    /** The file the Harness loads Project Instructions from, in its workspace. */
    instructionFile: string;
    /**
     * How an Agent Definition is delivered: `subagent` when the Harness can run a
     * named agent as the top-level agent of a headless run, else `project_instruction`.
     * Never "the model chose to delegate".
     */
    invocation: 'subagent' | 'project_instruction';
    /** Where the Harness discovers named agents, in its workspace. Set exactly when `invocation` is `subagent`. */
    agentsDir?: string;
    /**
     * The definition (frontmatter) keys the Harness acts on, besides `name`, which
     * is identity and always accepted. Small on purpose: only keys that change how
     * the agent runs. Anything else in a definition is ignored, hence "unsupported".
     */
    supportedKeys: string[];
}

// Facts from each Harness's official docs (checked 2026-10-14; URLs per row).
// Claude: `claude -p --agent <name>` runs `.claude/agents/<name>.md` as the main
// agent. opencode: `opencode run --agent <name>` with `.opencode/agents/<name>.md`.
// Codex (`.codex/agents/*.toml`) and Gemini CLI (`.gemini/agents/*.md`) have agent
// files but document no flag to run one as the top-level agent, and ACP defines no
// file-based agents, so they and the generic `command` Harness get the prompt as
// Project Instructions, where only the prose is read and `description`
// (documentation) is the one key that is harmless to drop.
export const HARNESS_CAPABILITIES: Record<string, HarnessCapabilities> = {
    'claude-code': {
        // Instruction file: https://code.claude.com/docs/en/memory (`./CLAUDE.md`; `AGENTS.md`
        // is read only when no CLAUDE.md exists, and only from v2.1.277).
        // Dir, `-p --agent <name>`: https://code.claude.com/docs/en/sub-agents
        instructionFile: 'CLAUDE.md',
        invocation: 'subagent',
        agentsDir: '.claude/agents',
        // Keys: https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields
        // Left out: `omitClaudeMd`, documented as ignored when the agent runs via `--agent`.
        supportedKeys: [
            'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks',
            'memory', 'background', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental',
        ],
    },
    // Instruction file: https://geminicli.com/docs/cli/gemini-md/ (default `GEMINI.md`).
    // No top-level agent flag: https://geminicli.com/docs/cli/cli-reference/ and
    // https://geminicli.com/docs/core/subagents/ (agents are `.gemini/agents/*.md`, delegated to only).
    'gemini-cli': { instructionFile: 'GEMINI.md', invocation: 'project_instruction', supportedKeys: ['description'] },
    // Instruction file: https://learn.chatgpt.com/docs/agent-configuration/agents-md (`AGENTS.override.md`, then `AGENTS.md`).
    // Agents are TOML in `.codex/agents/`, spawned as subagents only:
    // https://learn.chatgpt.com/docs/agent-configuration/subagents.md ; `codex exec` has no agent flag:
    // https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs
    codex: { instructionFile: 'AGENTS.md', invocation: 'project_instruction', supportedKeys: ['description'] },
    opencode: {
        // Instruction file: https://opencode.ai/docs/rules/ (`AGENTS.md`, `CLAUDE.md` as fallback).
        // Dir: https://opencode.ai/docs/agents/ ; `opencode run --agent`: https://opencode.ai/docs/cli/
        instructionFile: 'AGENTS.md',
        invocation: 'subagent',
        agentsDir: '.opencode/agents',
        // Keys: https://opencode.ai/docs/agents/#options (`tools` and `maxSteps` are deprecated
        // but still read). opencode passes any other key to the provider as a model option;
        // those stay "unsupported" here, since nothing guarantees the provider acts on them.
        supportedKeys: ['description', 'mode', 'model', 'temperature', 'top_p', 'steps', 'tools', 'permission', 'maxSteps', 'disable', 'prompt', 'hidden', 'color'],
    },
    // ACP defines no instruction file nor file-based agents (https://agentclientprotocol.com/overview/introduction).
    // unverified: `AGENTS.md` is skillgrade's choice; which file is read depends on the ACP agent behind it.
    acp: { instructionFile: 'AGENTS.md', invocation: 'project_instruction', supportedKeys: ['description'] },
    // Skillgrade's own convention for a user-supplied command (README "Custom command"); no external doc applies.
    command: { instructionFile: 'AGENTS.md', invocation: 'project_instruction', supportedKeys: ['description'] },
};

/** The row for a Harness, by current or deprecated name. Throws on an unknown one. */
export function capabilitiesOf(harness: string): HarnessCapabilities {
    const row = HARNESS_CAPABILITIES[harnessName(harness)];
    if (!row) {
        throw new Error(`Unknown harness "${harness}". Available harnesses: ${Object.keys(HARNESS_CAPABILITIES).join(', ')}`);
    }
    return row;
}

/** The keys of a definition that the Harness does not support, in the definition's order. `name` is identity, never a setting. */
export function unsupportedKeys(harness: string, keys: string[]): string[] {
    const supported = new Set(capabilitiesOf(harness).supportedKeys);
    return keys.filter(k => k !== 'name' && !supported.has(k));
}
