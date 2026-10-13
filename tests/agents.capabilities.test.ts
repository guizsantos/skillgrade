import { describe, it, expect } from 'vitest';
import { HARNESS_CAPABILITIES, capabilitiesOf } from '../src/agents/capabilities';
import { getAgentNames } from '../src/agents/registry';

describe('Harness capability table', () => {
    it('has exactly one row per registered Harness', () => {
        expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual(getAgentNames().sort());
    });

    it.each([
        ['claude-code', 'CLAUDE.md'],
        ['gemini-cli', 'GEMINI.md'],
        ['codex', 'AGENTS.md'],
        ['opencode', 'AGENTS.md'],
        ['acp', 'AGENTS.md'],
        ['command', 'AGENTS.md'],
    ])('%s loads Project Instructions from %s', (harness, filename) => {
        expect(capabilitiesOf(harness).instructionFile).toBe(filename);
    });

    it('resolves a deprecated Harness name to its current row', () => {
        expect(capabilitiesOf('claude')).toBe(capabilitiesOf('claude-code'));
    });

    it('rejects an unknown Harness', () => {
        expect(() => capabilitiesOf('nope')).toThrow(/Unknown harness "nope"/);
    });
});
