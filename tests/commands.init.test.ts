import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { extractInstructionHint, generateWithLLM, getInlineProjectTemplate, getInlineTemplate, runInit } from '../src/commands/init';
import { loadProject, testedResources } from '../src/core/project';
import { loadEvalConfig } from '../src/core/config';

describe('extractInstructionHint', () => {
  it('extracts first paragraph after heading', () => {
    const content = `# My Skill

This is the first paragraph
that spans multiple lines.

## Section 2
More content here.`;

    const result = extractInstructionHint(content);
    expect(result).toContain('This is the first paragraph');
    expect(result).toContain('that spans multiple lines.');
    expect(result).not.toContain('Section 2');
  });

  it('stops at next heading', () => {
    const content = `# My Skill
First line
## Next Section
Should not appear`;

    const result = extractInstructionHint(content);
    expect(result).toContain('First line');
    expect(result).not.toContain('Should not appear');
  });

  it('returns default when no heading found', () => {
    const content = 'Just some text without headings';
    const result = extractInstructionHint(content);
    expect(result).toBe('TODO: Write an instruction for the agent.');
  });

  it('returns default when heading has no following text', () => {
    const content = '# My Skill\n';
    const result = extractInstructionHint(content);
    expect(result).toBe('TODO: Write an instruction for the agent.');
  });

  it('handles single line after heading', () => {
    const content = `# Skill
Short description.`;

    const result = extractInstructionHint(content);
    expect(result).toContain('Short description.');
  });
});

describe('inline templates', () => {
  it('the eval template holds tasks only: no version, skill or workspace keys', () => {
    const template = getInlineTemplate();
    expect(template).toContain('{{TASK_NAME}}');
    expect(template).toContain('{{INSTRUCTION}}');
    expect(template).toMatch(/^tasks:/m);
    expect(template).not.toMatch(/^(version|skill|workspace|defaults):/m);
  });

  it('the eval template has both grader types and a placeholder grader that outputs JSON', () => {
    const template = getInlineTemplate();
    expect(template).toContain('type: deterministic');
    expect(template).toContain('type: llm_rubric');
    expect(template).toContain('"score"');
    expect(template).toContain('"details"');
  });

  it('the project template carries the defaults and the skills search path', () => {
    const template = getInlineProjectTemplate();
    expect(template).toContain('harness: gemini-cli');
    expect(template).toContain('runtime: docker');
    expect(template).toContain('trials: 5');
    expect(template).toContain('timeout: 300');
    expect(template).toContain('threshold: 0.8');
    expect(template).toContain('{{SKILLS_PATHS}}');
  });
});

describe('runInit', () => {
  const savedEnv = { ...process.env };
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-init-')));
    // No key: init writes the template instead of calling an LLM
    for (const key of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    await fs.remove(dir);
  });

  const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\nDoes ${name} things.\n`;

  /** Everything an Eval Project's `skillgrade` run would load, through the same loaders. */
  async function loadScaffold() {
    const projectDir = path.join(dir, 'evals');
    const project = await loadProject(projectDir);
    const resources = await testedResources(project);
    const configs = await Promise.all(resources.map(r => loadEvalConfig(r.evalDir, project.defaults)));
    return { projectDir, project, resources, configs };
  }

  it('scaffolds an Eval Project for the skills it finds, which the loaders accept', async () => {
    await fs.outputFile(path.join(dir, 'skills/alpha/SKILL.md'), skillMd('alpha'));
    await fs.outputFile(path.join(dir, 'skills/beta/SKILL.md'), skillMd('beta'));
    await runInit(dir);

    const { project, resources, configs } = await loadScaffold();
    expect(project.searchPaths.skills).toEqual([path.join(dir, 'skills')]);
    expect(resources.map(r => [r.kind, r.name])).toEqual([['skill', 'alpha'], ['skill', 'beta']]);
    expect(configs.map(c => c.tasks[0].name)).toEqual(['test-alpha', 'test-beta']);
    expect(configs[0].tasks[0].instruction).toContain('Does alpha things.');
  });

  it('does not write the removed single-file eval.yaml, anywhere', async () => {
    await fs.outputFile(path.join(dir, 'skills/alpha/SKILL.md'), skillMd('alpha'));
    await runInit(dir);
    const files: string[] = [];
    for (const entry of await fs.readdir(dir, { recursive: true })) files.push(String(entry));
    expect(files.filter(f => f.endsWith('eval.yaml'))).toEqual([]);
    expect(await fs.pathExists(path.join(dir, 'evals/eval-project.yml'))).toBe(true);
  });

  it('points the search path at wherever the skills are, relative to the project', async () => {
    await fs.outputFile(path.join(dir, '.agents/skills/alpha/SKILL.md'), skillMd('alpha'));
    await runInit(dir);
    expect((await fs.readFile(path.join(dir, 'evals/eval-project.yml'), 'utf-8'))).toContain('skills: ["../.agents/skills"]');
    expect((await loadScaffold()).resources.map(r => r.name)).toEqual(['alpha']);
  });

  it('names an eval after the skill directory, not its frontmatter', async () => {
    await fs.outputFile(path.join(dir, 'skills/alpha/SKILL.md'), skillMd('alpha'));
    await runInit(dir);
    expect(await fs.pathExists(path.join(dir, 'evals/skills/alpha/eval.yml'))).toBe(true);
  });

  it('with no skill, writes a project around a placeholder skill so that it still loads', async () => {
    await runInit(dir);
    const { resources } = await loadScaffold();
    expect(resources.map(r => r.name)).toEqual(['my-skill']);
    expect(await fs.pathExists(path.join(dir, 'skills/my-skill/SKILL.md'))).toBe(true);
  });

  it('refuses to scaffold inside a skill, which an Eval Project must stay apart from', async () => {
    await fs.outputFile(path.join(dir, 'SKILL.md'), skillMd('alpha'));
    await expect(runInit(dir)).rejects.toThrow(/inside a skill/);
    expect(await fs.pathExists(path.join(dir, 'evals'))).toBe(false);
  });

  it('refuses to overwrite an existing project without --force, and overwrites the generated files with it', async () => {
    await fs.outputFile(path.join(dir, 'skills/alpha/SKILL.md'), skillMd('alpha'));
    await runInit(dir);
    const evalFile = path.join(dir, 'evals/skills/alpha/eval.yml');
    await fs.writeFile(evalFile, 'edited');
    await fs.outputFile(path.join(dir, 'evals/skills/alpha/graders/keep.sh'), 'keep');

    await expect(runInit(dir)).rejects.toThrow(/already exists/);
    expect(await fs.readFile(evalFile, 'utf-8')).toBe('edited');

    await runInit(dir, { force: true });
    expect(await fs.readFile(evalFile, 'utf-8')).toContain('tasks:');
    expect(await fs.pathExists(path.join(dir, 'evals/skills/alpha/graders/keep.sh'))).toBe(true);
  });
});

describe('generateWithLLM — Anthropic', () => {
  const skills = [{ name: 'my-skill', skillMd: '# My Skill\n\nDoes a thing.' }];
  const savedEnv = { ...process.env };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Pin the model so resolveAnthropicModel short-circuits instead of hitting /v1/models.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
  });

  // Stub fetch, capturing the request URL and parsed body for assertions.
  function stubFetch() {
    const captured: { url?: string; body?: any } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      captured.url = url;
      captured.body = JSON.parse(opts.body);
      return {
        ok: true,
        json: () => Promise.resolve({ content: [{ type: 'text', text: 'version: "1"\n' }] }),
      };
    }) as any;
    return captured;
  }

  it('reads the text block past a leading thinking block', async () => {
    // Adaptive thinking is on by default on current Claude models, so the API
    // prepends a thinking block and content[0] is not the text block.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '```yaml\nversion: "1"\ntasks: []\n```' },
        ],
      }),
    }) as any;

    const result = await generateWithLLM(skills, 'test-key', 'anthropic');

    expect(result).toContain('version: "1"');
    expect(result).not.toContain('```');
  });

  it('does not send a temperature parameter (rejected by current Claude models)', async () => {
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'anthropic');
    expect(captured.body).not.toHaveProperty('temperature');
  });

  it('posts to the default messages endpoint', async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'anthropic');
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('honors ANTHROPIC_BASE_URL for parity with the grader', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080/v1/';
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'anthropic');
    expect(captured.url).toBe('http://localhost:8080/v1/messages');
  });

  it('ignores an empty ANTHROPIC_BASE_URL rather than treating it as an override', async () => {
    process.env.ANTHROPIC_BASE_URL = '   ';
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'anthropic');
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('generateWithLLM — OpenAI', () => {
  const skills = [{ name: 'my-skill', skillMd: '# My Skill\n\nDoes a thing.' }];
  const savedEnv = { ...process.env };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.OPENAI_MODEL = 'gpt-5-mini';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
  });

  function stubFetch() {
    const captured: { url?: string } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      captured.url = url;
      return {
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'version: "1"\n' } }] }),
      };
    }) as any;
    return captured;
  }

  it('posts to the default chat/completions endpoint', async () => {
    delete process.env.OPENAI_BASE_URL;
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'openai');
    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('honors OPENAI_BASE_URL so init works against Ollama/vLLM', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    const captured = stubFetch();
    await generateWithLLM(skills, 'test-key', 'openai');
    expect(captured.url).toBe('http://localhost:11434/v1/chat/completions');
  });
});
