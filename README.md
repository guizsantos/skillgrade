# Skillgrade

The easiest way to evaluate your [Agent Skills](https://agentskills.io/home). Tests that AI agents correctly discover and use your skills.

See [examples/](examples/) — [superlint](examples/superlint/) (simple) and [angular-modern](examples/angular-modern/) (TypeScript grader).

![Browser Preview](https://raw.githubusercontent.com/mgechev/skillgrade/main/assets/browser-preview.png)

## Quick Start

**Prerequisites**: Node.js 20+, Docker

```bash
npm i -g skillgrade
```

**1. Initialize** — go to your skill directory (must have `SKILL.md`) and scaffold:

```bash
cd my-skill/
GEMINI_API_KEY=your-key skillgrade init    # or ANTHROPIC_API_KEY / OPENAI_API_KEY
# Use --force to overwrite an existing eval.yaml
```

Generates `eval.yaml` with AI-powered tasks and graders. Without an API key, creates a well-commented template.

**2. Edit** — customize `eval.yaml` for your skill (see [eval.yaml Reference](#evalyaml-reference)).

**3. Run**:

```bash
GEMINI_API_KEY=your-key skillgrade --smoke
```

The agent is auto-detected from your API key: `GEMINI_API_KEY` → Gemini, `ANTHROPIC_API_KEY` → Claude, `OPENAI_API_KEY` → Codex. Override with `--harness=claude-code`.

**4. Review**:

```bash
skillgrade preview          # CLI report
skillgrade preview browser  # every skill's results → http://localhost:3847
```

Reports are saved to `$TMPDIR/skillgrade/<skill-name>/results/`. Override with `--output=DIR`.

## Browsing results

`skillgrade preview browser [--port=3847] [--output=DIR]` serves a local site over every skill under the output directory. It re-reads the results on each page load, so a run that just finished appears when you reload. It shows:

- Each skill's current score ± 95% interval, and **Δ** against the previous skill version, with a verdict: better, worse, or within noise (two standard errors; needs ≥2 trials a side).
- The score of every commit that touched the skill, overall and per task.
- Per-check pass rates with Wilson intervals, by version.
- How many more trials would resolve the Δ.
- A **Harmonize** toggle for when tasks have unequal trial counts. It scores the same number of trials from every task: the worst ones (pessimistic) or the best ones (optimistic).
- Each run, task and trial, down to the check evidence, the agent's output, its commands, and the grader source.

**Versions are commits.** Every report records a `provenance` block:

- `run_id`, which groups the reports of one invocation.
- `commit` (HEAD).
- `skill_commit`: the last commit that touched the skill.
- `eval_commit`: the last commit that touched the eval dir or a file `eval.yaml` imports.
- `from_head` and `ignored`, when the run used `--from-head` (see below).
- `harness`, `model`, `args`, and the eval and skill paths.

Runs are compared only when their `eval_commit` and model match the latest run's. Anything else measures a different test, not a different skill.

**A run evaluates a commit.** In a git repo, `skillgrade` won't start if the run's inputs have uncommitted changes. The inputs are the skill, the eval dir, the YAML that `eval.yaml` imports, and the files tasks copy in. The error lists the changed paths. You can commit them, or pass `--from-head` to evaluate HEAD without them.

`--from-head` reads every input from a temporary `git worktree` at HEAD and prints the changes it leaves out. Results still go to this tree's `--output`. The worktree is removed when the run ends, including when it's interrupted or killed. A leftover from a crashed run is pruned at the next start.

`--validate` grades the working tree on purpose, so it's never checked and can't be combined with `--from-head`. Outside a git repo, nothing is checked.

Old reports that recorded `dirty` changes are listed but never compared, because no commit describes what they evaluated.

Reports from before provenance existed still show: each file is a run of its own.

## Presets

| Flag | Trials | Use Case |
|------|--------|----------|
| `--smoke` | 5 | Quick capability check |
| `--reliable` | 15 | Reliable pass rate estimate |
| `--regression` | 30 | High-confidence regression detection |

## Options

| Flag | Description |
|------|-------------|
| `--eval=NAME[,NAME]` | Run specific evals by name (comma-separated) |
| `--grader=TYPE` | Run only graders of a type (`deterministic` or `llm_rubric`) |
| `--trials=N` | Override trial count |
| `--parallel=N` | Run trials concurrently |
| `--harness=gemini-cli\|claude-code\|codex\|acp\|opencode\|command` | The agent CLI under test (default: auto-detect from API key) |
| `--model=NAME` | Model the agent answers with (`gemini`, `claude`, `codex`, `opencode`). Default: whatever the agent CLI is configured to use |
| `--runtime=docker\|local` | Where trials run |
| `--acp-command=CMD` | ACP agent command (e.g., `gemini --acp`) |
| `--command=CMD` | Command to run for the `command` agent (e.g., `node mycli.js`) |
| `--opencode-agent=NAME` | OpenCode agent (build\|plan\|explore) |
| `--opencode-model=MODEL` | OpenCode model (provider/model format) |
| `--output=DIR` | Output directory (default: `$TMPDIR/skillgrade`) |
| `--validate` | Verify graders using reference solutions |
| `--from-head` | Evaluate HEAD from a temporary worktree, leaving uncommitted changes to the inputs out (see [Browsing results](#browsing-results)) |
| `--ci` | CI mode: exit non-zero if below threshold |
| `--threshold=0.8` | Pass rate threshold for CI mode |
| `--preview` | Show CLI results after running |

## eval.yaml Reference

```yaml
version: "1"

# Optional: explicit path to skill directory (defaults to auto-detecting SKILL.md)
# skill: path/to/my-skill

defaults:
  harness: gemini-cli    # the agent CLI under test: gemini-cli | claude-code | codex | acp | opencode | command
  model: claude-opus-5   # model the harness answers with (gemini-cli, claude-code, codex, opencode)
  runtime: docker        # where trials run: docker | local
  trials: 5
  timeout: 300           # seconds
  threshold: 0.8         # for --ci mode
  llm_model: gemini-3-flash-preview  # default model for llm_rubric graders
  llm_provider: gemini               # default LLM API for llm_rubric graders: gemini | anthropic | openai | jev
  command: node mycli.js # command to run when the harness is 'command' (see Custom Command Agent)
  acp:                   # ACP agent configuration (optional)
    command: gemini --acp  # command to start ACP-compatible agent
    env:                  # optional environment variables
      DEBUG: "1"
  docker:
    base: node:20-slim
    setup: |             # extra commands run during image build
      apt-get update && apt-get install -y jq
  environment:           # container resource limits
    cpus: 2
    memory_mb: 2048

tasks:
  - name: fix-linting-errors
    instruction: |
      Use the superlint tool to fix coding standard violations in app.js.

    workspace:                           # files copied into the container
      - src: fixtures/broken-app.js
        dest: app.js
      - src: bin/superlint
        dest: /usr/local/bin/superlint
        chmod: "+x"

    graders:
      - type: deterministic
        setup: npm install typescript    # grader-specific deps (optional)
        run: npx ts-node graders/check.ts
        weight: 0.7
      - type: llm_rubric
        rubric: |
          Did the agent follow the check → fix → verify workflow?
        llm_provider: gemini             # optional: gemini (default) | anthropic | openai | jev
        llm_model: gemini-3.5-flash      # optional model override
        weight: 0.3

    # Per-task overrides (optional)
    harness: claude-code
    model: claude-sonnet-5       # override the model for this task only
    llm_provider: anthropic      # override the default LLM API for llm_rubric graders
    trials: 10
    timeout: 600
```

**Renamed keys.** Each key now names one thing. The old names still load, with a deprecation warning:

| Old | New | What it names |
|-----|-----|---------------|
| `agent` / `--agent` | `harness` / `--harness` | the agent CLI under test; `gemini` and `claude` are now `gemini-cli` and `claude-code` |
| `provider` / `--provider` (task, defaults) | `runtime` / `--runtime` | where trials run: `docker` or `local` |
| `grader_provider`, and `provider` on a grader | `llm_provider` | the LLM API that scores an `llm_rubric` |
| `grader_model`, and `model` on a grader | `llm_model` | that API's model |

String values (`instruction`, `rubric`, `run`) support **file references** — if the value is a valid file path, its contents are read automatically:

```yaml
instruction: instructions/fix-linting.md
rubric: rubrics/workflow-quality.md
```

### Reference output and metadata

A task can carry the row's answer key and a set of labels:

```yaml
- name: easy--tooltip-token
  instruction: |
    Report the background colour token of the Tooltip's default variant.
    Write {"token": "..."} to answer.json.
  expected:                 # the answer key — graders only, never the agent
    token: Brand/100
    variants: [default, hover]
  metadata:                 # labels for --filter, recorded with the results
    tier: easy
    form: open
    tags: [smoke]
  graders:
    - type: deterministic
      run: node graders/check-token.mjs
```

Both are optional: a task without `expected` is scored purely on what its
graders measure, so golden-truth and metric-style tasks live in the same suite.

skillgrade **delivers `expected`, it never interprets it** — comparison is the
grader's job. A deterministic grader receives the task context as one JSON
document in `SKILLGRADE_INPUT`, so `expected` keeps its structure:

```js
// graders/check-token.mjs — one script for every token task
const { task, trial, expected, metadata } = JSON.parse(process.env.SKILLGRADE_INPUT);
const answer = JSON.parse(fs.readFileSync('answer.json', 'utf8'));   // cwd is the workspace

console.log(JSON.stringify({
  score: answer.token === expected.token ? 1 : 0,
  details: `${task}: want ${expected.token}, got ${answer.token ?? '(none)'}`,
}));
```

```bash
# or from a shell grader
want=$(jq -r .expected.token <<< "$SKILLGRADE_INPUT")
```

An `llm_rubric` grader gets `expected` as an `## Expected Output` section in its
prompt. Both channels are built after the agent process has exited, and neither
writes to the workspace — unlike `run:` and `rubric:`, which are staged into the
agent's working directory before it starts, so keep answer keys out of those.

### Selecting which tasks to run

`metadata` is what `--filter` selects on. Values are OR within a key and AND
across keys; `--filter` and `--not-filter` are repeatable:

```bash
skillgrade --filter=tier=easy,medium              # easy OR medium
skillgrade --filter=tier=hard --filter=form=refuse    # hard AND refuse
skillgrade --filter=tags=smoke --not-filter=tags=flaky
skillgrade --filter-pattern='^easy--'             # regex over task names
skillgrade --filter=tier=easy --list              # print the selection, run nothing
```

A filter on a key that no task declares is an error rather than a silent
match-everything — `--filter=teir=easy` should not quietly run the whole suite.
Filters work the same whether the tasks are inline or imported.

### Splitting eval.yaml across files

Any section can live in another file. `$import` takes a file, a directory (every
`.yaml`/`.yml` inside it, sorted), a glob, or a list of those:

```yaml
version: "1"

defaults:
  $import: shared/defaults.yaml   # merged in place — keys below win
  trials: 3

tasks:
  - $import: evals/easy/*.yaml    # one task per file, or a file holding a list
  - $import: evals/hard           # a whole directory
    trials: 10                    # applied to every task it imports
  - name: still-inline            # inline tasks keep working
    instruction: ...
    graders: [...]
```

Each imported file is a normal YAML document — a single task, a list of tasks, or
an object for a section like `defaults`. Imported files may import further files;
paths are relative to the file that contains the `$import`, and cycles are an error.

A task keeps working when you move it into its own file: **its relative paths
resolve against its own directory first, then the eval root.** So
`evals/easy/one.yaml` can say `instruction: instruction.md` for the file next to it
while still pointing `run: node graders/check.mjs` at the shared graders directory
at the root.

## Graders

### Deterministic

Runs a command and parses JSON from stdout:

```yaml
- type: deterministic
  run: bash graders/check.sh
  weight: 0.7
```

Output format:

```json
{
  "score": 0.67,
  "details": "2/3 checks passed",
  "checks": [
    {"name": "file-created", "passed": true, "message": "Output file exists"},
    {"name": "content-correct", "passed": false, "message": "Missing expected output"}
  ]
}
```

`score` (0.0–1.0) and `details` are required. `checks` is optional.

**Bash example:**

```bash
#!/bin/bash
passed=0; total=2
c1_pass=false c1_msg="File missing"
c2_pass=false c2_msg="Content wrong"

if test -f output.txt; then
  passed=$((passed + 1)); c1_pass=true; c1_msg="File exists"
fi
if grep -q "expected" output.txt 2>/dev/null; then
  passed=$((passed + 1)); c2_pass=true; c2_msg="Content correct"
fi

score=$(awk "BEGIN {printf \"%.2f\", $passed/$total}")
echo "{\"score\":$score,\"details\":\"$passed/$total passed\",\"checks\":[{\"name\":\"file\",\"passed\":$c1_pass,\"message\":\"$c1_msg\"},{\"name\":\"content\",\"passed\":$c2_pass,\"message\":\"$c2_msg\"}]}"
```

> Use `awk` for arithmetic — `bc` is not available in `node:20-slim`.

### LLM Rubric

Evaluates the agent's session transcript against qualitative criteria:

```yaml
- type: llm_rubric
  rubric: |
    Workflow Compliance (0-0.5):
    - Did the agent follow the mandatory 3-step workflow?

    Efficiency (0-0.5):
    - Completed in ≤5 commands?
  weight: 0.3
  llm_provider: gemini       # gemini (default) | anthropic | openai | jev
  llm_model: gemini-2.0-flash  # optional, auto-detected from API key
```

The `llm_provider` field selects which LLM API scores the rubric:

| Provider   | API Key Env Var     | Base URL Env Var (optional) | Default Model              |
|------------|---------------------|-----------------------------|----------------------------|
| `gemini`   | `GEMINI_API_KEY`    | -                           | Dynamically resolved latest Flash model (via API) |
| `anthropic`| `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`        | Dynamically resolved latest Haiku model (via API) |
| `openai`   | `OPENAI_API_KEY`    | `OPENAI_BASE_URL`           | Dynamically resolved latest Mini/Flash model (via API) |
| `jev`      | `JEV_API_KEY`       | `JEV_BASE_URL`              | `jev-latest` |

`ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` enable custom/self-hosted endpoints (Ollama, vLLM, etc.). They apply to both LLM grading and `skillgrade init`.

[Jev](https://docs.typesafe.ai/introduction) is a scoring model, not a chat model: it rates the session against four levels (fails, partially, mostly, fully meets the rubric) and the expected level becomes the score. It gives no written reasoning; the grader's details show the level, the probability of each level, and Jev's confidence.

### Combining Graders

```yaml
graders:
  - type: deterministic
    run: bash graders/check.sh
    weight: 0.7      # 70% — did it work?
  - type: llm_rubric
    rubric: rubrics/quality.md
    weight: 0.3      # 30% — was the approach good?
```

Final reward = `Σ (grader_score × weight) / Σ weight`

## CI Integration

Use `--runtime=local` in CI — the runner is already an ephemeral sandbox, so Docker adds overhead without benefit.

```yaml
# .github/workflows/skillgrade.yml
- run: |
    npm i -g skillgrade
    cd skills/superlint
    GEMINI_API_KEY=${{ secrets.GEMINI_API_KEY }} skillgrade --regression --ci --runtime=local
```

Exits with code 1 if pass rate falls below `--threshold` (default: 0.8).

> **Tip**: Use `docker` (the default) for local development to protect your machine. In CI, `local` is faster and simpler.

## Environment Variables

| Variable | Used by |
|----------|---------|
| `GEMINI_API_KEY` | Agent execution, LLM grading (`llm_provider: gemini`), `skillgrade init` |
| `ANTHROPIC_API_KEY` | Agent execution, LLM grading (`llm_provider: anthropic`), `skillgrade init` |
| `OPENAI_API_KEY` | Agent execution (Codex), LLM grading (`llm_provider: openai`), `skillgrade init` |
| `ANTHROPIC_BASE_URL` | LLM grading (`llm_provider: anthropic`), `skillgrade init` — custom Anthropic-compatible endpoint |
| `OPENAI_BASE_URL` | LLM grading (`llm_provider: openai`), `skillgrade init` — custom OpenAI-compatible endpoint (Ollama, vLLM, etc.) |
| `JEV_API_KEY` | LLM grading (`llm_provider: jev`) |
| `JEV_BASE_URL` | LLM grading (`llm_provider: jev`) — defaults to `https://api.typesafe.ai/v1` |
| `GEMINI_MODEL` | Override the default model used for Gemini LLM grading (defaults to dynamic API lookup; throws if resolution fails) |
| `INIT_GEMINI_MODEL` | Override the model used for Gemini in `skillgrade init` (defaults to `GEMINI_MODEL` or dynamic API lookup; throws if resolution fails) |
| `ANTHROPIC_MODEL` | Override the default model used for Anthropic LLM grading (defaults to dynamic API lookup; throws if resolution fails) |
| `INIT_ANTHROPIC_MODEL` | Override the model used for Anthropic in `skillgrade init` (defaults to `ANTHROPIC_MODEL` or dynamic API lookup; throws if resolution fails) |
| `OPENAI_MODEL` | Override the default model used for OpenAI LLM grading (defaults to dynamic API lookup; throws if resolution fails) |
| `INIT_OPENAI_MODEL` | Override the model used for OpenAI in `skillgrade init` (defaults to `OPENAI_MODEL` or dynamic API lookup; throws if resolution fails) |

Variables are also loaded from `.env` in the skill directory. Shell values override `.env`. All values are **redacted** from persisted session logs.

## Custom Command Agent

Bring your own agent. The built-in adapters (`gemini`, `claude`, `codex`, ...) cover the popular CLIs, but you can point skillgrade at **any command** — a custom script, a [deepagents](https://github.com/langchain-ai/deepagents) loop, or a small orchestrator over the Claude/OpenAI SDKs — without forking the package or implementing an ACP server.

### Quick Start

```bash
skillgrade --harness=command --command="node mycli.js"
```

Or in `eval.yaml`:

```yaml
defaults:
  harness: command
  command: "node mycli.js"
  runtime: local         # run on the host; or use docker + docker.setup to install your CLI
```

`command` can also be set per task to override the default.

### How the instruction reaches your command

The task instruction is **piped to your command's stdin** (skillgrade writes it to `/tmp/.prompt.md`, then runs `cat /tmp/.prompt.md | <command>` inside the workspace directory). If your CLI takes the prompt as an argument instead, wrap it in a one-line script that reads stdin.

Your command runs in the workspace and is free to read/edit files there — graders score the resulting workspace state (and any live checks), not your command's stdout, so any agent slots in cleanly.

### Docker vs local

- **`runtime: local`** is the simplest fit for a custom agent: your command runs on the host with your tools already installed.
- **`runtime: docker`** still works — skillgrade does **not** auto-install anything for the `command` harness, so install your CLI and dependencies via `docker.setup`:

```yaml
defaults:
  harness: command
  command: "mycli run"
  docker:
    base: node:20-slim
    setup: "npm install -g my-cli-package"
```

## OpenCode Agent

[OpenCode](https://opencode.ai/) is an AI coding agent that supports multiple AI models and specialized subagents.

### Quick Start

```bash
# Use OpenCode with default agent and model
skillgrade --harness=opencode

# Specify OpenCode agent (build|plan|explore)
skillgrade --harness=opencode --opencode-agent=build

# Specify both agent and model (provider/model format)
skillgrade --harness=opencode --opencode-agent=build --opencode-model=anthropic/claude-sonnet-4-20250514
```

### OpenCode Agents

| Agent | Description |
|-------|-------------|
| `build` | Default primary agent with full tool access |
| `plan` | Read-only planning/analysis agent |
| `explore` | Fast codebase exploration agent |

### OpenCode Models

Models are specified in `provider/model` format:

| Model | Format |
|-------|--------|
| Claude Sonnet 4 | `anthropic/claude-sonnet-4-20250514` |
| GPT 5.1 Codex | `opencode/gpt-5.1-codex` |

### CLI Options

| Flag | Description |
|------|-------------|
| `--harness=opencode` | Use the OpenCode harness |
| `--opencode-agent=NAME` | OpenCode agent (build\|plan\|explore) |
| `--opencode-model=MODEL` | OpenCode model (provider/model format) |

### How It Works

1. skillgrade invokes OpenCode CLI with `opencode run`
2. Passes instruction via temp file to avoid shell escaping issues
3. Supports both agent and model specification
4. Works with `--runtime=docker` or `--runtime=local`

## ACP Agent

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) is an open protocol that standardizes communication between AI coding agents and clients. Using an ACP-compatible agent allows you to evaluate skills without managing API keys directly.

### Quick Start

```bash
# Use Gemini CLI in ACP mode (requires gemini CLI installed)
skillgrade --harness=acp --acp-command="gemini --acp"

# Or configure in eval.yaml
```

```yaml
defaults:
  harness: acp
  acp:
    command: gemini --acp
```

### ACP-Compatible Agents

Any agent that supports the ACP protocol can be used:

| Agent | Command |
|-------|---------|
| Gemini CLI | `gemini --acp` |
| Other ACP agents | Check agent documentation |

### How It Works

1. skillgrade starts the ACP agent as a subprocess
2. Communication happens via JSON-RPC 2.0 over stdio
3. No API key required — authentication is handled by the ACP agent
4. Works best with `--runtime=local` since the ACP agent needs to be available in your environment

### CLI Options

| Flag | Description |
|------|-------------|
| `--harness=acp` | Use an ACP-compatible agent |
| `--acp-command=CMD` | Command to start the ACP agent |

The `--acp-command` can also be set in `eval.yaml` under `defaults.acp.command`.

## Best Practices

- **Grade outcomes, not steps.** Check that the file was fixed, not that the agent ran a specific command.
- **Instructions must name output files.** If the grader checks for `output.html`, the instruction must tell the agent to save as `output.html`.
- **Validate graders first.** Use `--validate` with a reference solution before running real evals.
- **Start small.** 3–5 well-designed tasks beat 50 noisy ones.

For a comprehensive guide on writing high-quality skills, check out [skills-best-practices](https://github.com/mgechev/skills-best-practices/). You can also install the skill creator skill to help author skills:

```bash
npx skills add mgechev/skills-best-practices
```

## License

MIT

---
*Inspired by [SkillsBench](https://arxiv.org/html/2602.12670v1) and [Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).*
