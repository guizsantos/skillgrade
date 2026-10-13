/**
 * `skillgrade init` command.
 *
 * Detects skills in the current directory and scaffolds an Eval Project for
 * them in `./evals`: `eval-project.yml` plus one `skills/<name>/eval.yml` per
 * skill. The evals sit apart from the skills, so nothing in them can reach the
 * agent. With an API key, an LLM drafts each eval's tasks and graders; without
 * one, a well-commented template is written.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { detectSkills } from '../core/skills';
import { EVAL_FILE } from '../core/config';
import { PROJECT_FILE } from '../core/project';
import { parseEnvFile } from '../utils/env';
import { resolveGeminiModel, resolveAnthropicModel, resolveOpenAIModel } from '../utils/models';

/** Where the Eval Project is scaffolded, inside the directory `init` runs in. */
export const PROJECT_DIR = 'evals';

export async function runInit(dir: string, opts: { force?: boolean } = {}) {
  const projectDir = path.join(dir, PROJECT_DIR);
  const projectPath = path.join(projectDir, PROJECT_FILE);

  if (await fs.pathExists(projectPath) && !opts.force) {
    console.error(`  ${PROJECT_DIR}/${PROJECT_FILE} already exists. Use --force to overwrite.`);
    throw new Error(`${PROJECT_DIR}/${PROJECT_FILE} already exists`);
  }

  console.log('\nskillgrade init\n');

  // Detect skills
  const skills = await detectSkills(dir);

  // An Eval Project is kept apart from the resources it evaluates, so it cannot live inside a skill
  if (skills.some(s => path.resolve(s.path) === path.resolve(dir))) {
    console.error('  This directory is itself a skill. An Eval Project is kept apart from the skills it evaluates:');
    console.error('     run skillgrade init from the directory that holds it (with skills/<name>/SKILL.md under it).\n');
    throw new Error('Cannot scaffold an Eval Project inside a skill');
  }

  if (skills.length === 0) {
    console.log('  No SKILL.md found. Creating a generic template, with a placeholder skill to evaluate.');
    console.log('     Add skills/<name>/SKILL.md for better scaffolding.\n');
    const stub = path.join(dir, 'skills', 'my-skill', 'SKILL.md');
    if (!await fs.pathExists(stub)) {
      await fs.outputFile(stub, '---\nname: my-skill\ndescription: Describe what this skill does and when to use it.\n---\n\n# My Skill\n\nDescribe what the agent should do with this skill.\n');
    }
    await writeProject(projectDir, [path.join(dir, 'skills')]);
    await writeEval(projectDir, 'my-skill', await renderEvalTemplate('my-skill-task', 'Describe what the agent should do with this skill.'));
    console.log(`  Created ${PROJECT_DIR}/ for the skill my-skill.`);
    console.log(`     Edit ${PROJECT_DIR}/skills/my-skill/${EVAL_FILE}, then run: cd ${PROJECT_DIR} && skillgrade\n`);
    return;
  }

  console.log(`  Found ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}\n`);

  // Load .env file if present
  const envPath = path.join(dir, '.env');
  if (await fs.pathExists(envPath)) {
    const envVars = parseEnvFile(await fs.readFile(envPath, 'utf-8'));
    for (const [key, value] of Object.entries(envVars)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Try LLM-powered scaffold — auto-detect from available API key
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const llmProvider = geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : openaiKey ? 'openai' : null;
  const llmApiKey = geminiKey || anthropicKey || openaiKey;

  const providerLabel: Record<string, string> = { gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' };

  if (!llmProvider || !llmApiKey) {
    console.log('  Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY for AI-powered eval generation.\n');
  }

  await writeProject(projectDir, [...new Set(skills.map(s => path.dirname(s.path)))]);

  for (const skill of skills) {
    // A skill is named by its directory, and so is its eval's directory in the Eval Project
    const name = path.basename(skill.path);
    let evalYml: string | undefined;

    if (llmProvider && llmApiKey) {
      const { Spinner, fmt } = await import('../utils/cli');
      const spinner = new Spinner('init', `generating eval for ${name} with ${providerLabel[llmProvider]}`);
      try {
        evalYml = await generateWithLLM([skill], llmApiKey, llmProvider);
        spinner.stop(fmt.green(`created ${PROJECT_DIR}/skills/${name}/${EVAL_FILE}`));
      } catch (err: any) {
        spinner.stop(fmt.red(`AI generation failed: ${err.message}`));
        console.log('     Falling back to template.\n');
      }
    }

    // Fallback: template-based scaffold
    evalYml ??= await renderEvalTemplate(`test-${name}`, extractInstructionHint(skill.skillMd));
    await writeEval(projectDir, name, evalYml);
  }

  console.log(`  Created ${PROJECT_DIR}/. Review and edit the evals, then run: cd ${PROJECT_DIR} && skillgrade\n`);
}

/** The `eval-project.yml` for the skills found in `skillDirs` (absolute directories holding skill folders). */
async function writeProject(projectDir: string, skillDirs: string[]) {
  const searchPaths = skillDirs.map(d => path.relative(projectDir, d).split(path.sep).join('/') || '.');
  const template = await readTemplate('eval-project.yml.template', getInlineProjectTemplate());
  await fs.outputFile(path.join(projectDir, PROJECT_FILE), template.replace(/\{\{SKILLS_PATHS\}\}/g, JSON.stringify(searchPaths)), 'utf-8');
}

/** A skill's eval: `<project>/skills/<name>/eval.yml`. */
async function writeEval(projectDir: string, name: string, content: string) {
  await fs.outputFile(path.join(projectDir, 'skills', name, EVAL_FILE), content, 'utf-8');
}

async function readTemplate(file: string, inline: string): Promise<string> {
  const templatePath = path.join(__dirname, '..', '..', 'templates', file);
  // Inline fallback if the template file is not found (e.g., if installed globally)
  return await fs.pathExists(templatePath) ? fs.readFile(templatePath, 'utf-8') : inline;
}

async function renderEvalTemplate(taskName: string, instruction: string): Promise<string> {
  const template = await readTemplate('eval.yml.template', getInlineTemplate());
  return template
    .replace(/\{\{TASK_NAME\}\}/g, taskName)
    .replace(/\{\{INSTRUCTION\}\}/g, instruction);
}

/**
 * Extract a reasonable instruction hint from SKILL.md content.
 */
export function extractInstructionHint(skillMd: string): string {
  // Try to get the first paragraph after the main heading
  const lines = skillMd.split('\n');
  let foundHeading = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ') && !foundHeading) {
      foundHeading = true;
      continue;
    }
    if (foundHeading) {
      if (line.trim() === '' && paragraphLines.length > 0) break;
      if (line.startsWith('#')) break;
      if (line.trim()) paragraphLines.push(line.trim());
    }
  }

  if (paragraphLines.length > 0) {
    return `TODO: Write an instruction based on this skill.\n      Skill description: ${paragraphLines.join(' ')}`;
  }

  return 'TODO: Write an instruction for the agent.';
}

/**
 * Resolve an OpenAI-/Anthropic-compatible base URL from the environment.
 *
 * An override that is empty or whitespace is ignored rather than treated as a
 * real value — otherwise a set-but-empty *_BASE_URL would produce "/messages".
 * Trailing slashes are stripped so callers can append a path directly.
 */
function resolveBaseUrl(envValue: string | undefined, fallback: string): string {
  const override = envValue?.trim();
  return (override || fallback).replace(/\/+$/, '');
}

/**
 * Generate an eval.yml (the `tasks:` of one skill's eval) using the configured LLM provider
 * (Gemini, Anthropic, or OpenAI).
 */
export async function generateWithLLM(
  skills: Array<{ name: string; skillMd: string }>,
  apiKey: string,
  provider: 'gemini' | 'anthropic' | 'openai' = 'gemini'
): Promise<string> {
  const skillSummaries = skills.map(s =>
    `## Skill: ${s.name}\n\n${s.skillMd}`
  ).join('\n\n---\n\n');

  const prompt = `You are an expert at creating evaluation tasks for AI agent skills.

Given the following skill definition(s), generate an eval.yml file that defines 1-2 evaluation tasks to test whether an AI agent correctly discovers and uses the skill.

For each task:
- Write a realistic instruction (what a user would ask the agent to do)
- Write a deterministic grader (shell script that outputs JSON to stdout)
- Write an LLM rubric (criteria for the LLM judge)

IMPORTANT GRADING RULES:
- Deterministic graders MUST output JSON to stdout: {"score": 0.0-1.0, "details": "...", "checks": [...]}
- Do NOT use exit codes for scoring. The grader should always exit 0 and report the score in JSON.
- Use awk for floating point arithmetic (bc is not available in node:20-slim).
- The "checks" array is optional but recommended for per-check breakdown.
- The agent starts in an EMPTY workspace: do not assume any input files exist. Tasks must be solvable by creating files from scratch (the author adds fixture files later, as folders, outside this YAML).
- Do NOT write "version", "defaults", "workspace" or "skill" keys: the file holds only "tasks".

CRITICAL — FILENAME CONSISTENCY:
- The instruction MUST tell the agent exactly what filenames to create (e.g., "Save the result as output.txt").
- The deterministic grader MUST only check for filenames that are explicitly mentioned in the instruction.
- NEVER check for a hardcoded filename that the instruction does not mention — the agent will choose its own names and the grader will fail.
- Example: if the grader checks for "output.html", the instruction must say "Save the HTML file as output.html".

${skillSummaries}

Respond with ONLY the eval.yml content. Use this exact format:

tasks:
  - name: <descriptive-task-name>   # a plain name: no slashes
    instruction: |
      <realistic user instruction>
      Save <expected output> as <exact-filename>.
    graders:
      - type: deterministic
        run: |
          # Check conditions and output JSON
          passed=0
          total=2
          c1_pass=false c1_msg="Check 1 failed"
          c2_pass=false c2_msg="Check 2 failed"

          if <check1>; then
            passed=$((passed + 1))
            c1_pass=true; c1_msg="Check 1 passed"
          fi

          if <check2>; then
            passed=$((passed + 1))
            c2_pass=true; c2_msg="Check 2 passed"
          fi

          score=$(awk "BEGIN {printf \\"%.2f\\", $passed/$total}")
          echo "{\\"score\\":$score,\\"details\\":\\"$passed/$total checks passed\\",\\"checks\\":[{\\"name\\":\\"check1\\",\\"passed\\":$c1_pass,\\"message\\":\\"$c1_msg\\"},{\\"name\\":\\"check2\\",\\"passed\\":$c2_pass,\\"message\\":\\"$c2_msg\\"}]}"
        weight: 0.7
      - type: llm_rubric
        rubric: |
          <evaluation criteria>
        weight: 0.3`;

  let text: string;
  const fetchOpts = { signal: AbortSignal.timeout(120_000) };

  if (provider === 'anthropic') {
    const model = await resolveAnthropicModel(apiKey, process.env, 'init');
    const baseUrl = resolveBaseUrl(process.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com/v1');
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        // No `temperature`: current Claude models (Sonnet 5, Opus 4.7+) reject
        // sampling parameters with a 400. The grader's Anthropic call omits it too.
      }),
      ...fetchOpts,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const data = await response.json() as any;
    // Adaptive thinking is on by default on current Claude models, so the first
    // content block may be a thinking block — select the text block explicitly.
    text = data.content?.find((b: any) => b.type === 'text')?.text;
    if (!text) throw new Error('Empty response from Anthropic API');
  } else if (provider === 'openai') {
    const model = await resolveOpenAIModel(apiKey, process.env, 'init');
    const baseUrl = resolveBaseUrl(process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
      ...fetchOpts,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = await response.json() as any;
    text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenAI API');
  } else {
    const model = await resolveGeminiModel(apiKey, process.env, 'init');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
      ...fetchOpts,
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned ${response.status}`);
    }

    const data = await response.json() as any;
    text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini API');
  }

  // Extract YAML from response (strip markdown code fences if present)
  const yamlContent = text.replace(/```ya?ml\n?/g, '').replace(/```\n?/g, '').trim();
  return yamlContent + '\n';
}

/** Used when `templates/eval.yml.template` cannot be found; the same shape, without the comments. */
export function getInlineTemplate(): string {
  return `tasks:
  - name: {{TASK_NAME}}
    instruction: |
      {{INSTRUCTION}}

    graders:
      - type: deterministic
        run: |
          # Grader must output JSON: {"score": 0.0-1.0, "details": "...", "checks": [...]}
          echo '{"score": 0.0, "details": "TODO: implement grader"}'
        weight: 0.7

      - type: llm_rubric
        rubric: |
          TODO: Write evaluation criteria.
        weight: 0.3
`;
}

/** Used when `templates/eval-project.yml.template` cannot be found. */
export function getInlineProjectTemplate(): string {
  return `defaults:
  harness: gemini-cli
  runtime: docker
  trials: 5
  timeout: 300
  threshold: 0.8
  docker:
    base: node:20-slim

search_paths:
  skills: {{SKILLS_PATHS}}
`;
}
