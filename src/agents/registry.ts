/**
 * Harness registry — maps harness names (the agent CLI under test) to their
 * implementations.
 *
 * Supported harnesses:
 *   - gemini-cli: Google Gemini CLI
 *   - claude-code: Anthropic Claude Code CLI
 *   - codex: OpenAI Codex CLI
 *   - acp: Agent Client Protocol compatible agents
 *   - opencode: OpenCode AI coding agent
 *   - command: arbitrary user-provided command (bring your own agent)
 */
import { BaseAgent } from '../types';
import { GeminiAgent, GeminiAgentConfig } from './gemini';
import { ClaudeAgent, ClaudeAgentConfig } from './claude';
import { CodexAgent, CodexAgentConfig } from './codex';
import { AcpAgent, AcpAgentConfig } from './acp';
import { OpenCodeAgent, OpenCodeAgentConfig } from './opencode';
import { CommandAgent, CommandAgentConfig } from './command';

/** Configuration for agent creation */
export interface AgentConfig {
    /** Claude-specific configuration */
    claude?: ClaudeAgentConfig;
    /** Gemini-specific configuration */
    gemini?: GeminiAgentConfig;
    /** Codex-specific configuration */
    codex?: CodexAgentConfig;
    /** ACP-specific configuration */
    acp?: AcpAgentConfig;
    /** OpenCode-specific configuration */
    opencode?: OpenCodeAgentConfig;
    /** Command agent configuration */
    command?: CommandAgentConfig;
}

/** Registry of available agent implementations */
const AGENT_REGISTRY: Record<string, (config?: AgentConfig) => BaseAgent> = {
    'gemini-cli': (config) => new GeminiAgent(config?.gemini || {}),
    'claude-code': (config) => new ClaudeAgent(config?.claude || {}),
    codex: (config) => new CodexAgent(config?.codex || {}),
    // ACP agent requires config, registered as placeholder
    acp: (config) => new AcpAgent(config?.acp || { command: 'gemini --acp' }),
    opencode: (config) => new OpenCodeAgent(config?.opencode || {}),
    // Command agent requires a command, validated in the CommandAgent constructor
    command: (config) => new CommandAgent(config?.command as CommandAgentConfig),
};

/** Names from before harnesses were named after their CLI, not the model's vendor */
const LEGACY_NAMES: Record<string, string> = { gemini: 'gemini-cli', claude: 'claude-code' };
const warned = new Set<string>();

/** The current name for a harness, warning once when given a deprecated one. */
export function harnessName(name: string): string {
    const now = LEGACY_NAMES[name];
    if (!now) return name;
    if (!warned.has(name)) {
        warned.add(name);
        console.error(`  warning  harness "${name}" is deprecated, use "${now}"`);
    }
    return now;
}

/** Get the list of supported harness names */
export function getAgentNames(): string[] {
    return Object.keys(AGENT_REGISTRY);
}

/** Create a harness instance by name. Throws if the name is unknown. */
export function createAgent(name: string, config?: AgentConfig): BaseAgent {
    const factory = AGENT_REGISTRY[harnessName(name)];
    if (!factory) {
        const available = getAgentNames().join(', ');
        throw new Error(`Unknown harness "${name}". Available harnesses: ${available}`);
    }
    return factory(config);
}
