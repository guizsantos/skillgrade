import { describe, it, expect } from 'vitest';
import { HARNESS_CAPABILITIES, capabilitiesOf, unsupportedKeys } from '../src/agents/capabilities';
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

    describe('Agent Definition delivery', () => {
        it.each([
            ['claude-code', 'subagent', '.claude/agents'],
            ['opencode', 'subagent', '.opencode/agents'],
            ['codex', 'project_instruction', undefined],
            ['gemini-cli', 'project_instruction', undefined],
            ['acp', 'project_instruction', undefined],
            ['command', 'project_instruction', undefined],
        ])('%s runs a definition as %s', (harness, invocation, agentsDir) => {
            expect(capabilitiesOf(harness).invocation).toBe(invocation);
            expect(capabilitiesOf(harness).agentsDir).toBe(agentsDir);
        });

        it('every Harness lists the keys it understands', () => {
            for (const row of Object.values(HARNESS_CAPABILITIES)) {
                expect(Array.isArray(row.supportedKeys)).toBe(true);
            }
            expect(capabilitiesOf('claude-code').supportedKeys).toEqual([
                'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks',
                'memory', 'background', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental',
            ]);
            expect(capabilitiesOf('opencode').supportedKeys).toEqual(['description', 'mode', 'model', 'temperature', 'top_p', 'steps', 'tools', 'permission', 'maxSteps', 'disable', 'prompt', 'hidden', 'color']);
            for (const h of ['codex', 'gemini-cli', 'acp', 'command']) {
                expect(capabilitiesOf(h).supportedKeys).toEqual(['description']);
            }
        });

        it('reports the keys a Harness does not support, in the definition order', () => {
            expect(unsupportedKeys('claude-code', ['description', 'top_p', 'tools', 'temperature'])).toEqual(['top_p', 'temperature']);
            expect(unsupportedKeys('claude-code', ['description', 'tools'])).toEqual([]);
            // Documented as ignored when the agent runs via `--agent`, so it is a degraded run.
            expect(unsupportedKeys('claude-code', ['omitClaudeMd', 'effort'])).toEqual(['omitClaudeMd']);
        });

        it('never counts the name, which is identity and not a setting', () => {
            expect(unsupportedKeys('command', ['name', 'description'])).toEqual([]);
        });
    });
});
