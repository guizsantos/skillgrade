/**
 * The Harness capability table: one row per Harness, the single source of
 * truth for what each one supports. Changing a Harness's behavior means
 * changing its row here and nothing else.
 */
import { harnessName } from './registry';

export interface HarnessCapabilities {
    /** The file the Harness loads Project Instructions from, in its workspace. */
    instructionFile: string;
}

export const HARNESS_CAPABILITIES: Record<string, HarnessCapabilities> = {
    'claude-code': { instructionFile: 'CLAUDE.md' },
    'gemini-cli': { instructionFile: 'GEMINI.md' },
    codex: { instructionFile: 'AGENTS.md' },
    opencode: { instructionFile: 'AGENTS.md' },
    acp: { instructionFile: 'AGENTS.md' },
    command: { instructionFile: 'AGENTS.md' },
};

/** The row for a Harness, by current or deprecated name. Throws on an unknown one. */
export function capabilitiesOf(harness: string): HarnessCapabilities {
    const row = HARNESS_CAPABILITIES[harnessName(harness)];
    if (!row) {
        throw new Error(`Unknown harness "${harness}". Available harnesses: ${Object.keys(HARNESS_CAPABILITIES).join(', ')}`);
    }
    return row;
}
