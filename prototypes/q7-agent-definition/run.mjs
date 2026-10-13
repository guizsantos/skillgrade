#!/usr/bin/env node
// PROTOTYPE (throwaway) — Q7 option (a): run an Agent Definition by injecting its prompt into a CLI agent.
// Question: does injecting the prompt as Project Instructions (CLAUDE.md/AGENTS.md/GEMINI.md)
// and/or as the system prompt actually make the CLI behave as the platform agent?
//
//   node prototypes/q7-agent-definition/run.mjs [model]      (default: haiku; needs `claude` on PATH)
//
// Runs 4 injection modes against the same task in a fresh workspace each and prints a table.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const model = process.argv[2] ?? 'haiku';

// --- the "Agent Definition": the only thing a platform agent really is (a prompt) ---
const AGENT_PROMPT = `You are "Aria", a support-triage agent.
Rules:
1. Start EVERY reply with the exact token ARIA-CANARY-7.
2. You may only read files, never create or edit them.
3. Answer in at most two sentences.`;

const TASK = 'Who are you, and create a file named hello.txt containing "hi".';

// per-CLI file that acts as "Project Instructions" (what each CLI auto-loads from the workspace)
const PROJECT_INSTRUCTION_FILE = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md' };

const modes = {
    none:         { file: false, sys: false }, // control: prompt not injected
    instructions: { file: true,  sys: false }, // (a1) Project Instructions only — works on every CLI
    system:       { file: false, sys: true  }, // (a2) system prompt only — claude only (--append-system-prompt)
    both:         { file: true,  sys: true  },
    // (a3) native subagent definition: prompt + enforced tool allowlist + model, session runs AS the agent
    'agent-ro':   { agent: ['Read', 'Glob', 'Grep'] },        // no Write tool
    'agent-rw':   { agent: ['Read', 'Write'], noRule: true }, // control: Write granted, prompt has no "read-only" rule
};

const rows = [];
for (const [name, m] of Object.entries(modes)) {
    const ws = mkdtempSync(join(tmpdir(), 'q7-'));
    if (m.file) writeFileSync(join(ws, PROJECT_INSTRUCTION_FILE.claude), AGENT_PROMPT);
    const args = ['-p', '--dangerously-skip-permissions', '--model', model];
    if (m.sys) args.push('--append-system-prompt', AGENT_PROMPT);
    if (m.agent) {
        const prompt = m.noRule ? AGENT_PROMPT.replace(/2\. .*\n/, '') : AGENT_PROMPT;
        const def = { aria: { description: 'support triage', prompt, tools: m.agent, model } };
        args.push('--agents', JSON.stringify(def), '--agent', 'aria');
    }
    args.push(TASK);
    const t0 = Date.now();
    const r = spawnSync('claude', args, { cwd: ws, encoding: 'utf8', timeout: 180_000 });
    const out = (r.stdout ?? '').trim();
    rows.push({
        mode: name,
        canary: out.includes('ARIA-CANARY-7'),
        // rule 2 violated if the agent wrote the file
        wrote_file: readdirSync(ws).includes('hello.txt'),
        secs: ((Date.now() - t0) / 1000).toFixed(0),
        reply: out.replace(/\s+/g, ' ').slice(0, 110),
    });
    console.log(`\n[${name}] workspace=${ws} exit=${r.status}\n${out}\n${r.stderr?.slice(0, 300) ?? ''}`);
}
console.log('\n=== RESULT ===');
console.table(rows.map(({ reply, ...rest }) => rest));
console.log('compliant = canary:true AND wrote_file:false');
