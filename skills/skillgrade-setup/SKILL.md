---
name: skillgrade-setup
description: Sets up and runs skillgrade evaluation pipelines for Static Resources (Skills, Agent Definitions, Project Instructions, Prompts) as an Eval Project. Use when initializing an Eval Project, configuring evals, running trials, reviewing results or Trial Records, or integrating with CI. Don't use for writing grader scripts, general test authoring, or non-agentic documentation.
---

# Skillgrade Evaluation Setup

## Concepts

* A **Static Resource** is any authored text that steers an agent: a **Skill** (a directory led by `SKILL.md`), an **Agent Definition** (one `<name>.md`), **Project Instructions** (a directory with `AGENTS.md`) or a **Prompt** (one `<name>.md` with `{{variables}}`).
* An **Eval Project** is a directory of evals kept apart from the resources, so graders, answer keys and solutions can never reach the agent. It holds `eval-project.yml` and one `<kind>/<name>/` directory per resource (`skills/`, `agents/`, `instructions/`, `prompts/`), named after the resource it evaluates.
* There is no single-file `eval.yaml` any more. Never create one, and never write a `skill:` key.

## Procedures

**Step 1: Install Skillgrade**
1. Verify Node.js 20+ and Docker are available.
2. Run `npm i -g skillgrade` to install the CLI globally.

**Step 2: Initialize an Eval Project**
1. Go to the directory that holds your skills (for example a repository with `skills/<name>/SKILL.md`). Do not run it inside a skill: the Eval Project is kept apart from the resources.
2. Optionally set an API key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`) so an LLM drafts the tasks and graders.
3. Run `skillgrade init`. It creates `evals/eval-project.yml` and one `evals/skills/<name>/eval.yml` per skill found. Without an API key, a well-commented template is written instead.
4. If `evals/eval-project.yml` already exists, pass `--force` to overwrite the generated files: `skillgrade init --force`.
5. For Agent Definitions, Project Instructions and Prompts, `init` does not scaffold: add the kind under `search_paths` in `eval-project.yml` and create `<kind>/<name>/eval.yml` by hand.

**Step 3: Configure the Eval Project**
1. Read `references/eval-project-spec.md` for the full schema: layout, search paths, naming rule, task workspaces, task references, judges, prompts, delivery and compatibility.
2. In `eval-project.yml`, declare where each kind is found: `search_paths: { skills: ["../skills"], agents: ["../agents"], ... }` (relative to the file). A resource's kind is the key it is found under; its name is its directory's (a one-file resource: its file name without `.md`), and its frontmatter `name:` must be the same.
3. In `<kind>/<name>/eval.yml`, define one or more tasks under `tasks:`. Each task requires:
   - `name`: a plain task identifier; it is also the name of the task's workspace folder
   - `instruction`: what the agent should accomplish (optional for a Prompt, whose rendered text is the ask)
   - `graders`: one or more scoring mechanisms (see the `skillgrade-graders` skill)
4. Put the files a task starts with in `workspace/<task name>/` next to `eval.yml`. No folder means an empty workspace. To reuse another task's files, write `workspace: [{task: other}]` (`other@resource` or `other@kind:resource` across resources).
5. Put grader scripts in `graders/`, reusable rubrics in `llm_judges/<name>.md` (used as `llm_judge: <name>`; optional frontmatter `llm_provider`/`llm_model`, the body is the rubric), and reference solutions in `solution/`.
6. For a Prompt, give each task its `variables:` (over the project-wide `variables:` in `eval-project.yml`).
7. Set `defaults:` in `eval-project.yml` for harness, runtime, trials, timeout, and threshold.

**Step 4: Run Evaluations**
1. Run from the Eval Project directory (the one with `eval-project.yml`).
2. Select an appropriate preset based on the evaluation goal:
   - `--smoke` (5 trials): Quick capability check.
   - `--reliable` (15 trials): Reliable pass rate estimate.
   - `--regression` (30 trials): High-confidence regression detection.
3. Run the evaluation: `skillgrade --smoke`. Every resource with an eval runs.
4. Run a specific task by name: `skillgrade --eval=fix-linting`.
5. Run multiple tasks: `skillgrade --eval=fix-linting,write-tests`.
6. Run only deterministic graders (skip LLM calls): `skillgrade --grader=deterministic`.
7. Run only LLM rubric graders: `skillgrade --grader=llm_rubric`.
8. The harness (the agent CLI under test) is auto-detected from the API key. Override with `--harness=gemini-cli|claude-code|codex|acp|opencode|command`.
9. For ACP, pass `--acp-command="gemini --acp"` or set `defaults.acp.command`.
10. For OpenCode, pass `--opencode-agent=build|plan|explore` or `--opencode-model=provider/model`.
11. For a custom agent, pass `--harness=command --command="node mycli.js"` or set `defaults.command`. The instruction is piped to the command's stdin.
12. Choose where trials run with `--runtime=docker|local`.
13. An Agent Definition whose frontmatter has keys the chosen harness does not support stops the run before any trial. Pass `--force` to run anyway; every Trial Record is then `harness_compatibility: degraded` and lists the ignored keys.
14. Check graders against the reference solutions with `skillgrade --validate`.

**Step 5: Review Results**
1. Run `skillgrade preview` for a CLI report.
2. Run `skillgrade preview browser` to browse every resource's results at `http://localhost:3847`: scores, Δ against the previous resource version (a run evaluates a commit: commit the changes first, or pass `--from-head` to evaluate HEAD without them), runs and trials.
3. Reports are saved to `$TMPDIR/skillgrade/<resource-name>/results/`. Override with `--output=DIR`.
4. Each run also writes `<run_id>.trials.jsonl` there: one Trial Record per trial, the stable result contract (fields and `schema_version` in `references/eval-project-spec.md`). Compute mean, pass@k and pass^k from the records, per harness, LLM and check.

**Step 6: Integrate with CI**
1. Add a GitHub Actions step that installs skillgrade, navigates to the Eval Project directory, and runs with `--regression --ci --runtime=local`.
2. Use `--runtime=local` in CI — the runner is already an ephemeral sandbox, so Docker adds overhead without benefit.
3. The `--ci` flag causes a non-zero exit code if the pass rate falls below `--threshold` (default: 0.8).
4. Read `references/ci-example.md` for a complete workflow template.

## Error Handling
* If `skillgrade init` fails with "inside a skill", run it from the directory that holds the skill, not from the skill itself.
* If a run fails with "No eval-project.yml found", run skillgrade from the Eval Project directory.
* If a run fails with "eval.yaml is no longer supported", migrate: create `eval-project.yml`, move the file to `<kind>/<name>/eval.yml`, drop `skill:` and `workspace:` file mappings, and move fixtures into `workspace/<task>/`.
* If a run fails on a name mismatch, make the resource's directory (or file) name and its frontmatter `name:` agree.
* If a task reference fails with "exists in more than one kind", use the full form `task@kind:resource`.
* If evaluation hangs, check Docker is running and the container has network access for API calls.
* If all trials fail with "No API key," ensure the environment variable is exported, not just set inline for a different command.
