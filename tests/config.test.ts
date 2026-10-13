import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs-extra before importing
vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from 'fs-extra';
import { loadEvalConfig, resolveTask } from '../src/core/config';
import { EvalTaskConfig, EvalDefaults } from '../src/core/config.types';

const mockPathExists = vi.mocked(fs.pathExists);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadEvalConfig', () => {
  it('throws when eval.yaml is missing', async () => {
    mockPathExists.mockResolvedValue(false as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('No eval.yaml found');
  });

  it('throws when YAML is not an object', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('just a string' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('must be a YAML object');
  });

  it('throws when tasks array is missing', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('version: "1"\n' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one task');
  });

  it('throws when tasks array is empty', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('version: "1"\ntasks: []\n' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one task');
  });

  it('throws when task is missing name', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - instruction: "do something"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('missing a "name"');
  });

  it('throws when task is missing instruction', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('missing an "instruction"');
  });

  it('throws when task has no graders', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: "do something"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one grader');
  });

  it('throws on workspace mapping without src/dest', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: "do something"
    workspace:
      - { foo: bar }
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('without src/dest');
  });

  it('parses valid config correctly', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
skill: ./SKILL.md
defaults:
  harness: claude-code
  trials: 10
  docker:
    base: ubuntu:22.04
tasks:
  - name: test-task
    instruction: "install the app"
    graders:
      - type: deterministic
        run: "echo ok"
        weight: 0.7
      - type: llm_rubric
        rubric: "check quality"
        weight: 0.3
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.version).toBe('1');
    expect(config.skill).toBe('./SKILL.md');
    expect(config.defaults.harness).toBe('claude-code');
    expect(config.defaults.trials).toBe(10);
    expect(config.defaults.docker.base).toBe('ubuntu:22.04');
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].name).toBe('test-task');
    expect(config.tasks[0].graders).toHaveLength(2);
    expect(config.tasks[0].graders[0].weight).toBe(0.7);
    expect(config.tasks[0].graders[1].type).toBe('llm_rubric');
  });

  it('applies default values when defaults not specified', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.defaults.harness).toBe('gemini-cli');
    expect(config.defaults.runtime).toBe('docker');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.docker.base).toBe('node:20-slim');
  });

  it('handles workspace string shorthand', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    workspace:
      - fixtures/app.js
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].workspace).toEqual([
      { src: 'fixtures/app.js', dest: 'app.js' },
    ]);
  });

  it('handles workspace objects with chmod', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    workspace:
      - src: scripts/run.sh
        dest: /workspace/run.sh
        chmod: "+x"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].workspace).toEqual([
      { src: 'scripts/run.sh', dest: '/workspace/run.sh', chmod: '+x' },
    ]);
  });

  it('defaults grader weight to 1.0', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });

  it('parses llm_provider from defaults', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  llm_provider: anthropic
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: llm_rubric
        rubric: "check quality"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.defaults.llm_provider).toBe('anthropic');
  });

  it('rejects invalid llm_provider value', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  llm_provider: invalid_provider
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('llm_provider must be one of');
  });

  it('loads the keys and harness names from before the rename, with a warning', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  agent: claude
  provider: local
  grader_provider: anthropic
  grader_model: claude-haiku
tasks:
  - name: test-task
    instruction: do it
    agent: gemini
    graders:
      - type: llm_rubric
        rubric: "check quality"
        provider: jev
        model: jev-latest
`;
    mockReadFile.mockResolvedValue(yaml as any);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = await loadEvalConfig('/test');
    expect(config.defaults).toMatchObject({ harness: 'claude-code', runtime: 'local', llm_provider: 'anthropic', llm_model: 'claude-haiku' });
    expect(config.defaults).not.toHaveProperty('agent');
    expect(config.tasks[0].harness).toBe('gemini-cli');
    expect(config.tasks[0].graders[0]).toMatchObject({ llm_provider: 'jev', llm_model: 'jev-latest' });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/"agent" in defaults is deprecated, use "harness"/);
    warn.mockRestore();
  });

  it('rejects the command harness when no command is set', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  harness: command
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('command');
  });

  it('accepts the command harness with a command in defaults', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  harness: command
  command: "node mycli.js"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.defaults.harness).toBe('command');
    expect(config.defaults.command).toBe('node mycli.js');
  });

  it('rejects invalid llm_provider on individual grader', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: llm_rubric
        rubric: "check quality"
        llm_provider: invalid_provider
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('grader has invalid llm_provider');
  });

  it('rejects invalid llm_provider at task level', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    llm_provider: bad_provider
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('has invalid llm_provider');
  });

  it('preserves task-level llm_provider through loadEvalConfig', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  llm_provider: gemini
tasks:
  - name: test-task
    instruction: do it
    llm_provider: anthropic
    graders:
      - type: llm_rubric
        rubric: "check quality"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].llm_provider).toBe('anthropic');
  });

  it('preserves task-level llm_model through loadEvalConfig', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  llm_model: gemini-1.5-flash
tasks:
  - name: test-task
    instruction: do it
    llm_model: claude-3-5-sonnet
    graders:
      - type: llm_rubric
        rubric: "check quality"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].llm_model).toBe('claude-3-5-sonnet');
  });

  it('preserves task-level environment through loadEvalConfig', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    environment:
      cpus: 4
      memory_mb: 4096
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].environment).toEqual({ cpus: 4, memory_mb: 4096 });
  });
});

describe('resolveTask', () => {
  const defaults: EvalDefaults = {
    harness: 'gemini-cli',
    runtime: 'docker',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    docker: { base: 'node:20-slim' },
    environment: { cpus: 2, memory_mb: 2048 },
  };

  it('applies defaults when task has no overrides', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'do it',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    // The instruction is inline (multi-line would be caught, single line tries file path)
    mockPathExists.mockResolvedValue(false as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.harness).toBe('gemini-cli');
    expect(resolved.runtime).toBe('docker');
    expect(resolved.trials).toBe(5);
    expect(resolved.timeout).toBe(300);
    expect(resolved.docker.base).toBe('node:20-slim');
  });

  it('leaves model undefined when neither task nor defaults set one', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.model).toBeUndefined();
  });

  it('inherits model from defaults and lets a task override it', async () => {
    const defaultsWithModel: EvalDefaults = { ...defaults, model: 'claude-sonnet-5' };
    const inherits: EvalTaskConfig = {
      name: 'inherits',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };
    const overrides: EvalTaskConfig = { ...inherits, name: 'overrides', model: 'claude-opus-5' };

    expect((await resolveTask(inherits, defaultsWithModel, '/base')).model).toBe('claude-sonnet-5');
    expect((await resolveTask(overrides, defaultsWithModel, '/base')).model).toBe('claude-opus-5');
  });

  it('resolves llm_provider on the task level', async () => {
    const defaultsWitProvider: EvalDefaults = {
      ...defaults,
      llm_provider: 'anthropic',
    };
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'llm_rubric', rubric: 'check quality', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaultsWitProvider, '/base');
    expect(resolved.llm_provider).toBe('anthropic');
    expect(resolved.graders[0].llm_provider).toBeUndefined();
  });

  it('grader-level llm_provider is preserved as-is', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'llm_rubric', rubric: 'check quality', weight: 1.0, llm_provider: 'openai' }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].llm_provider).toBe('openai');
  });

  it('grader without explicit llm_provider remains undefined', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'llm_rubric', rubric: 'check quality', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].llm_provider).toBeUndefined();
  });

  it('task-level llm_provider overrides defaults', async () => {
    const defaultsWitProvider: EvalDefaults = {
      ...defaults,
      llm_provider: 'gemini',
    };
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      llm_provider: 'openai',
      graders: [{ type: 'llm_rubric', rubric: 'check quality', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaultsWitProvider, '/base');
    expect(resolved.llm_provider).toBe('openai');
    expect(resolved.graders[0].llm_provider).toBeUndefined();
  });

  it('task overrides take precedence over defaults', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'do it now',
      harness: 'claude-code',
      runtime: 'local',
      trials: 10,
      timeout: 600,
      docker: { base: 'ubuntu:22.04' },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(false as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.harness).toBe('claude-code');
    expect(resolved.runtime).toBe('local');
    expect(resolved.trials).toBe(10);
    expect(resolved.timeout).toBe(600);
    expect(resolved.docker.base).toBe('ubuntu:22.04');
  });

  it('resolves instruction from file when it exists', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'instruction.md',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('File content here' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.instruction).toBe('File content here');
  });

  it('keeps inline multi-line instruction as-is', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'line 1\nline 2\nline 3',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.instruction).toBe('line 1\nline 2\nline 3');
  });

  it('resolves deterministic grader run from file', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline instruction',
      graders: [{ type: 'deterministic', run: 'test.sh', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('#!/bin/bash\necho pass' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].run).toBe('#!/bin/bash\necho pass');
  });

  it('resolves llm_rubric grader rubric from file', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline instruction',
      graders: [{ type: 'llm_rubric', rubric: 'rubric.md', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('Evaluate quality...' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].rubric).toBe('Evaluate quality...');
  });

  it('resolves solution path', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      solution: 'solutions/solve.sh',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.solution).toContain('solutions/solve.sh');
  });

  it('sets empty workspace when not provided', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.workspace).toEqual([]);
  });

  it('preserves grader setup field', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{
        type: 'deterministic',
        setup: 'npm install -g typescript',
        run: 'echo ok',
        weight: 1.0,
      }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].setup).toBe('npm install -g typescript');
  });

  it('inherits the command from defaults for the command harness', async () => {
    const commandDefaults: EvalDefaults = {
      ...defaults,
      harness: 'command',
      command: 'node mycli.js',
    };
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, commandDefaults, '/base');
    expect(resolved.harness).toBe('command');
    expect(resolved.command).toBe('node mycli.js');
  });

  it('lets a task override the command', async () => {
    const commandDefaults: EvalDefaults = {
      ...defaults,
      harness: 'command',
      command: 'node default.js',
    };
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'multi\nline',
      command: 'node override.js',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, commandDefaults, '/base');
    expect(resolved.command).toBe('node override.js');
  });
});
