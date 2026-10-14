# Skillgrade

Evaluates how well static, text-based resources steer a coding agent: [Agent Skills](https://agentskills.io/home), Agent Definitions, Project Instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) and Prompts. Skillgrade runs the agent in a limited workspace with the resource and grades the outcome, trial after trial.

See [examples/](examples/): [superlint](examples/superlint/) (simple), [angular-modern](examples/angular-modern/) (a script grader and a reusable judge) and [platform](examples/platform/) (one resource of each of the four kinds).

![Browser Preview](https://raw.githubusercontent.com/mgechev/skillgrade/main/assets/browser-preview.png)

## Contents

- [Quick Start](#quick-start)
- [The Eval Project](#the-eval-project): layout, [search paths](#search-paths), [the four resource kinds](#the-four-resource-kinds), [the naming rule](#the-naming-rule), [task workspaces](#task-workspaces), [task references](#task-references), [judges](#judges), [Prompt variables](#prompt-variables)
- [Harnesses, `agent_invocation` and `harness_compatibility`](#harnesses-agent_invocation-and-harness_compatibility)
- [Results and Trial Records](#results-and-trial-records)
- [Browsing results](#browsing-results)
- [Presets](#presets) and [Options](#options)
- [eval.yml Reference](#evalyml-reference)
- [Graders](#graders)
- [CI Integration](#ci-integration)
- [Environment Variables](#environment-variables)
- [Custom Command Agent](#custom-command-agent), [OpenCode Agent](#opencode-agent), [ACP Agent](#acp-agent)

## Quick Start

**Prerequisites**: Node.js 20+, Docker

```bash
npm i -g skillgrade
```

**1. Initialize**: go to the directory that holds your skills (a repository with `skills/<name>/SKILL.md`, for example) and scaffold an Eval Project:

```bash
cd my-repo/
GEMINI_API_KEY=your-key skillgrade init    # or ANTHROPIC_API_KEY / OPENAI_API_KEY
# Use --force to overwrite a project that init already generated
```

Creates `evals/` with an `eval-project.yml` and one `evals/skills/<name>/eval.yml` per skill, with AI-powered tasks and graders. Without an API key, it writes a well-commented template. `init` scaffolds Skills only: add the other kinds by hand (see [the four resource kinds](#the-four-resource-kinds)), or start from [examples/platform](examples/platform/).

**2. Edit**: customize the evals for your skill (see [The Eval Project](#the-eval-project) and the [eval.yml Reference](#evalyml-reference)).

**3. Run**, from the Eval Project directory:

```bash
cd evals
GEMINI_API_KEY=your-key skillgrade --smoke
```

This runs every resource that has an eval. The harness is auto-detected from your API key: `GEMINI_API_KEY` → Gemini, `ANTHROPIC_API_KEY` → Claude, `OPENAI_API_KEY` → Codex. Override with `--harness=claude-code`.

**4. Review**:

```bash
skillgrade preview          # CLI report
skillgrade preview browser  # every resource's results → http://localhost:3847
```

Reports and Trial Records are saved to `$TMPDIR/skillgrade/<resource-name>/results/`. Override with `--output=DIR`.

## The Eval Project

An **Eval Project** is a directory of evals kept apart from the resources it evaluates. The agent only ever sees the resource and the task's workspace folder, so graders, `expected` answers, judges and solutions can never reach it.

```
my-repo/
├── skills/greeter/SKILL.md                 # the resources: wherever they already live
├── agents/reviewer.md
├── instructions/team/AGENTS.md
├── prompts/summary.md
└── evals/                                  # the Eval Project: run skillgrade from here
    ├── eval-project.yml                    # defaults, variables, search_paths
    ├── skills/greeter/                     # <kind>/<name>/: one directory per resource, named after it
    │   ├── eval.yml                        #   the tasks
    │   ├── graders/                        #   scripts that `run:` calls
    │   ├── llm_judges/politeness.md        #   reusable rubrics (`llm_judge: politeness`)
    │   ├── solution/                       #   reference solutions for --validate
    │   └── workspace/say-hello/            #   the files the task `say-hello` starts with
    ├── agents/reviewer/eval.yml
    ├── instructions/team/eval.yml
    └── prompts/summary/eval.yml
```

A resource with no `eval.yml` is untested. An eval directory whose resource is not found is an error. The old single-file `eval.yaml`, with its `skill:` key and `workspace:` file mappings, is gone, and a directory that still has one is rejected.

### Search paths

`eval-project.yml` says where each kind of resource is found, relative to the file:

```yaml
defaults:
  harness: claude-code
  runtime: docker
  trials: 5

search_paths:
  skills: ["../skills", "../vendor/shared-skills"]   # more than one place is fine
  agents: ["../agents"]
  instructions: ["../instructions"]
  prompts: ["../prompts"]

variables:                  # Prompt variables shared by every Prompt task
  product: Acme Reports
```

The key is the kind: a resource found under `search_paths.skills` is a Skill. Declare only the kinds you have. `defaults` apply to every task, and an eval's own `defaults:` win over them.

### The four resource kinds

| Kind (`search_paths` key) | A resource is | Name | What the agent gets |
|---|---|---|---|
| **Skill** (`skills`) | a directory led by `SKILL.md` | the directory's name | the skill, where the harness discovers skills |
| **Agent Definition** (`agents`) | one file, `<name>.md`, with frontmatter | the file's name without `.md` | the definition as the top-level agent, or as Project Instructions (see [below](#harnesses-agent_invocation-and-harness_compatibility)) |
| **Project Instructions** (`instructions`) | a directory with `AGENTS.md` | the directory's name | `AGENTS.md`, unchanged, under the file name its harness loads: `CLAUDE.md`, `GEMINI.md` or `AGENTS.md` |
| **Prompt** (`prompts`) | one file, `<name>.md`, with frontmatter and `{{variables}}` | the file's name without `.md` | the rendered Prompt, as what it is asked |

One example of each:

```markdown
<!-- skills/greeter/SKILL.md -->
---
name: greeter
description: Greets the user politely.
---
Greet the user by name.
```

```markdown
<!-- agents/reviewer.md -->
---
name: reviewer
description: Reviews code.
tools: Read, Grep
---
You are a terse reviewer. Answer in one line.
```

```markdown
<!-- instructions/team/AGENTS.md  (no frontmatter) -->
# House rules
Always greet.
```

```markdown
<!-- prompts/summary.md -->
---
name: summary
description: Summarize a release.
---
Summarize {{product}} {{version}} for {{audience}} in one sentence. Save it as SUMMARY.txt.
```

### The naming rule

A resource is named by its directory (a one-file resource: by its file name without `.md`). Its frontmatter `name:` is **required** and must equal that name: a missing or different name fails loudly, before any trial. Names are unique within a kind, not across kinds (a Skill and a Prompt may both be called `summary`). **Project Instructions are exempt**: they have no frontmatter, so the file the agent sees is exactly the file being graded, and the name is the directory's.

The resource's eval lives in `<kind>/<name>/` of the Eval Project, under the same name.

### Task workspaces

A task's workspace is the folder named after it under the eval's `workspace/`. `workspace/fix-linting-errors/` is copied into the agent's working directory for the task `fix-linting-errors`, with file modes kept (an executable stays executable), and no `workspace:` key is needed. No folder means an empty workspace, which suits tasks that start from scratch. Nothing else in the eval directory is copied in; graders reach the workspace only after the agent has exited. A task name is therefore a plain name, with no slashes.

### Task references

A task can start from another task's workspace instead of repeating files:

```yaml
tasks:
  - name: setup
  - name: edit-config
    workspace:
      - task: setup                  # a task of this eval
      - task: seed@skills:database   # a task of another resource
```

The listed workspaces are copied in order, then the task's own folder on top.

| Reference | Resolves to |
|-----------|-------------|
| `name` | a task of the **same eval** only. An unknown name errors with `"name" not defined in "resource"` and, when another resource has it, a hint: `did you mean one of name@skills:other?` |
| `name@resource` | a task of that resource, anywhere in the project, when the resource name is unique. If the name exists in more than one kind, it errors and asks for the full form. |
| `name@kind:resource` | the full form: `kind` is a `search_paths` key (`skills`, `agents`, `instructions`, `prompts`) |

Every task's references are checked before any trial, including tasks a `--eval` selection leaves out.

### Judges

A **judge** is a reusable LLM rubric kept next to the eval, in `llm_judges/<name>.md`, and used by name:

```yaml
graders:
  - type: deterministic
    run: bash graders/check.sh
    weight: 0.7
  - llm_judge: politeness          # the rubric is llm_judges/politeness.md
    weight: 0.3
```

```markdown
<!-- llm_judges/politeness.md: plain text, the whole file is the rubric -->
Was the reply polite? Did it greet the user by name?

Tone (0-0.5): ...
Completeness (0-0.5): ...
```

The file's whole content, trimmed, is the rubric given to the LLM (no frontmatter, no variables). The name is a plain name (letters, digits, `_`, `-`, `.`). `llm_judge` makes the grader an `llm_rubric`, so `type` can be left out and `llm_provider`, `llm_model` and `weight` work as usual; give either `llm_judge` or `rubric`, not both. A missing or empty judge file fails before any trial. Judges are per eval: they live in the resource's directory of the Eval Project, so the agent never sees them.

### Prompt variables

A Prompt body holds `{{placeholders}}` (`{{ name }}` also works; names are letters, digits, `_` and `-`). Each task supplies the values, over the project-wide `variables:` of `eval-project.yml`:

```yaml
# evals/prompts/summary/eval.yml
tasks:
  - name: for-engineers
    variables: { version: "2.1.0", audience: engineers }   # `product` comes from eval-project.yml
    expected: { version: "2.1.0" }
    graders: [...]
  - name: for-customers
    variables: { version: "3.0.0", audience: customers, product: Acme Cloud }   # overrides the project's
    graders: [...]
```

Before any trial, each selected task's Prompt is rendered, and the rendered text is what the agent is asked. A Prompt task needs no `instruction`; one given follows the rendered Prompt. A value that is an object or list is inserted as JSON. A placeholder with no value stops the run and names the Prompt, the task and the missing variable. There are no loops or conditionals.

## Harnesses, `agent_invocation` and `harness_compatibility`

A **harness** is the coding-agent CLI under test (`claude-code`, `gemini-cli`, `codex`, `opencode`, `acp` or the generic `command`). Scores are never comparable across harnesses, just as they are not across LLMs.

**Agent Definitions** run as the top-level agent wherever the harness can do that, and as Project Instructions otherwise. Every Trial Record says which, in `agent_invocation`:

| Harness | `agent_invocation` | Delivered as | Definition keys it acts on (besides `name`) |
|---------|--------------------|--------------|---------------------------------------------|
| `claude-code` | `subagent` | `.claude/agents/<name>.md`, run with `--agent <name>` | `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks` |
| `opencode` | `subagent` | `.opencode/agents/<name>.md`, run with `--agent <name>` | `description`, `mode`, `model`, `temperature`, `top_p`, `steps`, `tools`, `permission` |
| `codex` | `project_instruction` | the prompt alone, as `AGENTS.md` | `description` |
| `gemini-cli` | `project_instruction` | the prompt alone, as `GEMINI.md` | `description` |
| `acp`, `command` | `project_instruction` | the prompt alone, as `AGENTS.md` | `description` |

`subagent` always means the definition ran as the top-level agent, never that the model chose to delegate. For a Skill, Project Instructions or a Prompt there is no invocation: `agent_invocation` is `null`.

**`harness_compatibility`** is `full` or `degraded`, on every result. Before any trial, an Agent Definition's frontmatter keys are compared with the table above. A key the harness does not support would be silently ignored, so the run stops instead:

```
Running eval for reviewer in harness codex with tools keys unsupported; run with --force to continue
```

Pass **`--force`** to run anyway. Every Trial Record of that run is then `harness_compatibility: degraded` and lists the keys in `ignored_keys`, so a consumer can discount the score. A clean run is `full` and carries no `ignored_keys`. Skills, Project Instructions and Prompts are never gated. The capability table is one place in the code (`src/agents/capabilities.ts`): when a harness gains a real top-level agent flag, only its row changes.

## Results and Trial Records

A run writes, per resource, to `<output>/<resource name>/results/` (`--output`, default `$TMPDIR/skillgrade`):

- `<task>_<timestamp>.json`: a report per task, with provenance (below), every trial and grader result, and the details the viewer shows.
- `<run_id>.trials.jsonl`: **the Trial Records**, one JSON object per line, one line per trial.

**The Trial Record file is the documented result contract.** A record is self-sufficient: mean, pass@k and pass^k are always computed from records by the consumer, per harness, LLM and check, never stored in their place, so records can arrive in any order and be merged. A record holds facts about the trial only, never session logs or agent output. `run_id` is the UTC start time and the short HEAD commit (`20260101T120000Z-abc1234`; `nogit` outside a repository), shared by every resource of one invocation.

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | number | The shape of the record: `1` |
| `trial_record_id` | string | `<run_id>/<resource_kind>/<resource_name>/<eval>/<trial>`. Deterministic, so re-publishing the same record is idempotent |
| `run_id` | string | Groups every record of one invocation |
| `resource_kind` | string | `skill`, `agent`, `instructions` or `prompt` |
| `resource_name` | string | The resource's name |
| `version_hash` | string or null | The last commit that touched the resource (`null` outside git) |
| `eval_commit` | string or null | The last commit that touched the eval |
| `eval` | string | The task name |
| `trial` | number | Trial index, from 0 |
| `harness` | string | `claude-code`, `gemini-cli`, `codex`, `opencode`, `acp` or `command` |
| `harness_version` | string | The harness CLI's version (read once per run), or `unknown` when it cannot be read: a harness with no CLI of its own, or a Docker runtime |
| `llm` | string | The model the harness was told to use (`--model`, `model:`), else `harness-default` |
| `agent_invocation` | string or null | `subagent` or `project_instruction` for an Agent Definition; `null` for a Skill, Project Instructions or a Prompt |
| `harness_compatibility` | string | `full` or `degraded` |
| `ignored_keys` | string[] | Only when `degraded`: the keys the harness ignored |
| `checks` | object[] | One `{check, score, weight}` per grader. `check` is the grader type and its position among graders of that type: `deterministic-0`, `llm_rubric-0`, `llm_rubric-1` |
| `overall_score` | number | The trial's weighted reward, 0 to 1 |
| `date` | string | ISO 8601, UTC |

```json
{"schema_version":1,"trial_record_id":"20260101T120000Z-abc1234/agent/reviewer/review/0","run_id":"20260101T120000Z-abc1234","resource_kind":"agent","resource_name":"reviewer","version_hash":"9f2c1e0","eval_commit":"9f2c1e0","eval":"review","trial":0,"harness":"claude-code","harness_version":"2.1.0","llm":"harness-default","agent_invocation":"subagent","harness_compatibility":"full","checks":[{"check":"deterministic-0","score":1,"weight":0.7},{"check":"llm_rubric-0","score":0.8,"weight":0.3}],"overall_score":0.94,"date":"2026-01-01T12:00:00.000Z"}
```

**Stability.** The fields above are the contract. `schema_version` is bumped only when a field is removed, renamed or changes meaning; adding a field does not bump it, so consumers should ignore fields they do not know. Decisions behind it are in [docs/adr/0002-trial-records-are-the-contract.md](docs/adr/0002-trial-records-are-the-contract.md). Skillgrade is standalone: results can later be published to a gateway, but publishing is optional and one-way ([ADR 0001](docs/adr/0001-standalone-one-way-publishing.md)).

## Browsing results

`skillgrade preview browser [--port=3847] [--output=DIR]` serves a local site over every resource under the output directory. It re-reads the results on each page load, so a run that just finished appears when you reload. It shows:

- Each resource's current score ± 95% interval, and **Δ** against the previous resource version, with a verdict: better, worse, or within noise (two standard errors; needs ≥2 trials a side).
- The score of every commit that touched the resource, overall and per task.
- Per-check pass rates with Wilson intervals, by version.
- How many more trials would resolve the Δ.
- A **Harmonize** toggle for when tasks have unequal trial counts. It scores the same number of trials from every task: the worst ones (pessimistic) or the best ones (optimistic).
- Each run, task and trial, down to the check evidence, the agent's output, its commands, and the grader source.

**Versions are commits.** Every report records a `provenance` block:

- `run_id`, which groups the reports of one invocation.
- `commit` (HEAD).
- `skill_commit`: the last commit that touched the resource (whatever its kind).
- `eval_commit`: the last commit that touched the eval's directory or a file its `eval.yml` imports.
- `from_head` and `ignored`, when the run used `--from-head` (see below).
- `harness`, `model`, `args`, and the eval and resource paths.

Runs are compared only when their `eval_commit` and model match the latest run's. Anything else measures a different test, not a different resource.

**A run evaluates a commit.** In a git repo, `skillgrade` won't start if the run's inputs have uncommitted changes. The inputs are the resources, the Eval Project's `eval-project.yml`, the eval directories, the YAML that `eval.yml` imports, and the task workspaces. The error lists the changed paths. You can commit them, or pass `--from-head` to evaluate HEAD without them.

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

Run `skillgrade` from the Eval Project directory (the one holding `eval-project.yml`).

| Flag | Description |
|------|-------------|
| `--eval=NAME[,NAME]` | Run specific tasks by name (comma-separated), in whichever resources have them |
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
| `--force` | Run an Agent Definition even though the harness ignores some of its keys; every Trial Record is `degraded` and lists them (see [above](#harnesses-agent_invocation-and-harness_compatibility)) |
| `--ci` | CI mode: exit non-zero if below threshold |
| `--threshold=0.8` | Pass rate threshold for CI mode |
| `--preview` | Show CLI results after running |

`skillgrade init [--force]` scaffolds an Eval Project in `./evals`; `skillgrade preview [browser]` shows results.

## eval.yml Reference

`eval-project.yml` carries the `defaults:`, the `search_paths:` and the project-wide `variables:` (see [Search paths](#search-paths)); an `eval.yml` holds the tasks of one resource. The settings below are the ones `defaults:` accepts, in `eval-project.yml` (or at the top of an `eval.yml`, where they win):

```yaml
# <eval project>/eval-project.yml
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

search_paths:
  skills: ["../skills"]
```

```yaml
# <eval project>/skills/superlint/eval.yml: the resource is this directory, so no `skill:` key
tasks:
  - name: fix-linting-errors          # its workspace is workspace/fix-linting-errors/
    instruction: |
      Use the superlint tool to fix coding standard violations in app.js.

    graders:
      - type: deterministic
        setup: npm install typescript    # grader-specific deps (optional)
        run: npx ts-node graders/check.ts   # graders/ is the eval's own folder
        weight: 0.7
      - type: llm_rubric
        rubric: |
          Did the agent follow the check → fix → verify workflow?
        llm_provider: gemini             # optional: gemini (default) | anthropic | openai | jev
        llm_model: gemini-3.5-flash      # optional model override
        weight: 0.3

    solution: solution/solve.sh          # reference solution for --validate

    # Per-task overrides (optional)
    harness: claude-code
    model: claude-sonnet-5       # override the model for this task only
    llm_provider: anthropic      # override the default LLM API for llm_rubric graders
    trials: 10
    timeout: 600
```

A task takes `name`, `instruction`, `variables`, `workspace` (task references only), `graders`, `solution`, `expected`, `metadata`, and the per-task overrides `harness`, `model`, `command`, `runtime`, `trials`, `timeout`, `llm_model`, `llm_provider`, `docker`, `environment`. The same schema, key by key, is in [skills/skillgrade-setup/references/eval-project-spec.md](skills/skillgrade-setup/references/eval-project-spec.md).

**Renamed keys.** Each key now names one thing. The old names still load, with a deprecation warning:

| Old | New | What it names |
|-----|-----|---------------|
| `agent` / `--agent` | `harness` / `--harness` | the agent CLI under test; `gemini` and `claude` are now `gemini-cli` and `claude-code` |
| `provider` / `--provider` (task, defaults) | `runtime` / `--runtime` | where trials run: `docker` or `local` |
| `grader_provider`, and `provider` on a grader | `llm_provider` | the LLM API that scores an `llm_rubric` |
| `grader_model`, and `model` on a grader | `llm_model` | that API's model |

String values (`instruction`, `rubric`, `run`) support **file references**: if the value is a single line that is a path to an existing file (relative to the eval's directory), its contents are read automatically:

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

skillgrade **delivers `expected`, it never interprets it**: comparison is the
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
writes to the workspace. Because the eval lives outside the resource and only the
task's `workspace/` folder reaches the agent, answer keys in `expected`, `graders/`,
`llm_judges/` and `solution/` stay out of its reach.

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
match-everything: `--filter=teir=easy` should not quietly run the whole suite.
Filters work the same whether the tasks are inline or imported. A selection that fits
no task of one resource leaves that resource out; it is an error only when it fits none.

### Splitting eval.yml across files

Any section can live in another file. `$import` takes a file, a directory (every
`.yaml`/`.yml` inside it, sorted), a glob, or a list of those:

```yaml
defaults:
  $import: shared/defaults.yaml   # merged in place — keys below win
  trials: 3

tasks:
  - $import: tasks/easy/*.yaml    # one task per file, or a file holding a list
  - $import: tasks/hard           # a whole directory
    trials: 10                    # applied to every task it imports
  - name: still-inline            # inline tasks keep working
    instruction: ...
    graders: [...]
```

Each imported file is a normal YAML document: a single task, a list of tasks, or
an object for a section like `defaults`. Imported files may import further files;
paths are relative to the file that contains the `$import`, and cycles are an error.

A task keeps working when you move it into its own file: **its relative paths
resolve against its own directory first, then the eval's directory.** So
`tasks/easy/one.yaml` can say `instruction: instruction.md` for the file next to it
while still pointing `run: node graders/check.mjs` at the shared `graders/` of the eval.

## Graders

### Deterministic

Runs a command and parses JSON from stdout. It runs in the agent's workspace, after the agent has exited; the eval's `graders/` folder is staged next to it:

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

For a rubric you reuse or that is long, write a [judge](#judges) (`llm_judge: name`, from `llm_judges/name.md`) instead of an inline `rubric`.

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
  - llm_judge: quality
    weight: 0.3      # 30% — was the approach good? (llm_judges/quality.md)
```

Final reward = `Σ (grader_score × weight) / Σ weight`

## CI Integration

Use `--runtime=local` in CI. The runner is already an ephemeral sandbox, so Docker adds overhead without benefit.

```yaml
# .github/workflows/skillgrade.yml
- run: |
    npm i -g skillgrade
    cd evals
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

Variables are also loaded from `.env` in the Eval Project directory (and, for `skillgrade init`, the directory it runs in). Shell values override `.env`. All values are **redacted** from persisted session logs.

## Custom Command Agent

Bring your own agent. The built-in adapters (`gemini-cli`, `claude-code`, `codex`, ...) cover the popular CLIs, but you can point skillgrade at **any command**: a custom script, a [deepagents](https://github.com/langchain-ai/deepagents) loop, or a small orchestrator over the Claude/OpenAI SDKs, without forking the package or implementing an ACP server.

### Quick Start

```bash
skillgrade --harness=command --command="node mycli.js"
```

Or in `eval-project.yml`:

```yaml
defaults:
  harness: command
  command: "node mycli.js"
  runtime: local         # run on the host; or use docker + docker.setup to install your CLI
```

`command` can also be set per task to override the default.

### How the instruction reaches your command

The task instruction (for a Prompt, the rendered Prompt) is **piped to your command's stdin** (skillgrade writes it to `/tmp/.prompt.md`, then runs `cat /tmp/.prompt.md | <command>` inside the workspace directory). If your CLI takes the prompt as an argument instead, wrap it in a one-line script that reads stdin.

Your command runs in the workspace and is free to read/edit files there. Graders score the resulting workspace state (and any live checks), not your command's stdout, so any agent slots in cleanly. An Agent Definition or Project Instructions reach it as `AGENTS.md` in the workspace.

### Docker vs local

- **`runtime: local`** is the simplest fit for a custom agent: your command runs on the host with your tools already installed.
- **`runtime: docker`** still works. skillgrade does **not** auto-install anything for the `command` harness, so install your CLI and dependencies via `docker.setup`:

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

When the resource under test is an Agent Definition, OpenCode runs *that* definition as the agent (`--agent <name>`), in place of `--opencode-agent`.

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

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) is an open protocol that standardizes communication between AI coding agents and clients. Using an ACP-compatible agent allows you to evaluate resources without managing API keys directly.

### Quick Start

```bash
# Use Gemini CLI in ACP mode (requires gemini CLI installed)
skillgrade --harness=acp --acp-command="gemini --acp"

# Or configure it in eval-project.yml
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

The `--acp-command` can also be set in `eval-project.yml` under `defaults.acp.command`.

## Best Practices

- **Grade outcomes, not steps.** Check that the file was fixed, not that the agent ran a specific command.
- **Instructions must name output files.** If the grader checks for `output.html`, the instruction must tell the agent to save as `output.html`.
- **Validate graders first.** Use `--validate` with a reference solution (`solution:`) before running real evals.
- **Keep evals apart from resources.** That is what an Eval Project is for: nothing in it can leak to the agent.
- **Start small.** 3–5 well-designed tasks beat 50 noisy ones.

For a comprehensive guide on writing high-quality skills, check out [skills-best-practices](https://github.com/mgechev/skills-best-practices/). You can also install the skill creator skill to help author skills:

```bash
npx skills add mgechev/skills-best-practices
```

## License

MIT

---
*Inspired by [SkillsBench](https://arxiv.org/html/2602.12670v1) and [Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).*
