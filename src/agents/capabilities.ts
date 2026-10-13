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

// Facts from each Harness's official docs. Claude: `claude -p --agent <name>` runs
// `.claude/agents/<name>.md` as the main agent. opencode: `opencode run --agent <name>`
// with `.opencode/agents/<name>.md`. Codex and Gemini have agent-file forms but no
// reliable headless top-level flag, and ACP has no file-based agents, so they and the
// generic `command` Harness get the prompt as Project Instructions, where only the
// prose is read and `description` (documentation) is the one key that is harmless to drop.
export const HARNESS_CAPABILITIES: Record<string, HarnessCapabilities> = {
    'claude-code': {
        instructionFile: 'CLAUDE.md',
        invocation: 'subagent',
        agentsDir: '.claude/agents',
        supportedKeys: ['description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks'],
    },
    'gemini-cli': { instructionFile: 'GEMINI.md', invocation: 'project_instruction', supportedKeys: ['description'] },
    codex: { instructionFile: 'AGENTS.md', invocation: 'project_instruction', supportedKeys: ['description'] },
    opencode: {
        instructionFile: 'AGENTS.md',
        invocation: 'subagent',
        agentsDir: '.opencode/agents',
        supportedKeys: ['description', 'mode', 'model', 'temperature', 'top_p', 'steps', 'tools', 'permission'],
    },
    acp: { instructionFile: 'AGENTS.md', invocation: 'project_instruction', supportedKeys: ['description'] },
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
