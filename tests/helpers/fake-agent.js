#!/usr/bin/env node
/**
 * Scripted fake agent for the `command` harness. No LLM, no network.
 *
 * Run as `node fake-agent.js <base64 JSON script>`; the harness pipes the task
 * instruction to stdin and runs it with the trial workspace as cwd. Build the
 * command line with `fakeAgent()` from ./evalProject.ts rather than by hand.
 *
 * Script keys, applied in this order:
 *   record  absolute path: write a JSON snapshot of what the agent can see
 *           ({ prompt, files: { relPath: content }, env: { NAME: value } })
 *           BEFORE touching anything, so tests assert on exactly what was
 *           delivered to the agent.
 *   env     env var names to include in the record
 *   write   { relPath: content } files to create in the workspace
 */
const fs = require('fs');
const path = require('path');

const script = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString('utf-8'));
const prompt = fs.readFileSync(0, 'utf-8');
const cwd = process.cwd();

function walk(dir, out = {}) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out[path.relative(cwd, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
    return out;
}

if (script.record) {
    const env = {};
    for (const name of script.env || []) env[name] = process.env[name] ?? null;
    fs.mkdirSync(path.dirname(script.record), { recursive: true });
    fs.writeFileSync(script.record, JSON.stringify({ prompt, files: walk(cwd), env }));
}

for (const [rel, content] of Object.entries(script.write || {})) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
}
