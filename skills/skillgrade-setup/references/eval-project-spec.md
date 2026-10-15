# Eval Project Specification

An **Eval Project** is a directory of evals kept apart from the resources it evaluates, so nothing in it (graders,
`expected`, solutions, judges) can reach the agent under test. Run `skillgrade` from that directory.

```
<eval project>/
├── eval-project.yml                  # defaults, variables, search_paths
├── skills/<name>/                    # one directory per resource, named after it:
│   ├── eval.yml                      #   the eval: its tasks
│   ├── graders/                      #   scripts that `run:` calls
│   ├── llm_judges/<judge>.md         #   reusable rubrics (`llm_judge: <judge>`)
│   ├── solution/                     #   reference solutions for --validate
│   └── workspace/<task>/             #   the files a task starts with
├── agents/<name>/                    # same layout, for Agent Definitions
├── instructions/<name>/              # ... for Project Instructions
└── prompts/<name>/                   # ... for Prompts
```

A resource with no eval directory is untested. An eval directory whose resource is not found in `search_paths` is an error.
The legacy single-file `eval.yaml` (with `skill:` and `workspace:` file mappings) is gone: a directory that still has one is rejected.

## eval-project.yml

| Key | Required | Description |
|-----|----------|-------------|
| `search_paths` | Yes | Where each kind is found: `skills`, `agents`, `instructions`, `prompts`, each a list of directories relative to this file. A resource's kind is the key it was found under. |
| `defaults` | No | Settings for every task (below). An eval's own `defaults:` win over these. |
| `variables` | No | Project-wide Prompt variables (a map). A task's own `variables:` win. |

```yaml
defaults:
  harness: claude-code
  runtime: docker
  trials: 5
search_paths:
  skills: ["../skills"]
  agents: ["../agents"]
  instructions: ["../instructions"]
  prompts: ["../prompts"]
variables:
  product: Acme Reports
```

## Resource kinds and names

| Kind (`search_paths` key) | A resource is | Name | Delivered to the agent as |
|---|---|---|---|
| Skill (`skills`) | a directory with `SKILL.md` | the directory's name | a skill the harness discovers |
| Agent Definition (`agents`) | one file, `<name>.md` | the file's name without `.md` | the top-level agent, or Project Instructions (see below) |
| Project Instructions (`instructions`) | a directory with `AGENTS.md` | the directory's name | `AGENTS.md` copied to the harness's own file name (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`) |
| Prompt (`prompts`) | one file, `<name>.md` | the file's name without `.md` | what the agent is asked, rendered with variables |

**Naming rule.** A resource is named by its directory (or file), and its frontmatter `name:` is required and must equal that
name; a missing or different name fails loudly before any trial. Names are unique within a kind, not across kinds.
Project Instructions have no frontmatter: the file the agent sees is exactly the file graded, and the name is the directory's.

## defaults

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `harness` | string | `gemini-cli` (or auto-detected from the API key) | The agent CLI under test: `gemini-cli`, `claude-code`, `codex`, `acp`, `opencode`, or `command` |
| `model` | string | harness default | Model the harness answers with (`gemini-cli`, `claude-code`, `codex`, `opencode`) |
| `command` | string | none | Command to run when `harness` is `command` (e.g. `node mycli.js`). Required for the `command` harness. |
| `runtime` | string | `docker` | Where trials run: `docker` or `local` |
| `trials` | number | 5 | Number of evaluation trials |
| `timeout` | number | 300 | Seconds before agent timeout |
| `threshold` | number | 0.8 | Pass rate threshold for `--ci` mode |
| `llm_model` | string | latest, resolved via the provider's API | Default LLM model for rubric graders. Also overridable with `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `GEMINI_MODEL`. |
| `llm_provider` | string | `gemini` | Default LLM API for rubric graders (`gemini`, `anthropic`, `openai`, or `jev`) |
| `docker.base` | string | `node:20-slim` | Base Docker image |
| `docker.setup` | string | none | Additional commands run during image build |
| `environment.cpus` / `environment.memory_mb` | number | 2 / 2048 | Container limits |
| `acp.command` / `acp.env` | string / object | none | Command (and environment) to start an ACP-compatible agent |

## eval.yml

`tasks:` is the only required key (`defaults:` is also read, and `$import` can pull any section from other files). There is no
`skill:` key and no `workspace:` file mapping: the resource is the directory the eval sits in.

### tasks

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | string | Yes | Unique task identifier; a plain name, because it is also the name of the task's `workspace/` folder |
| `instruction` | string | Yes, except for a Prompt | What the agent should accomplish. Supports file references. For a Prompt it is optional and follows the rendered Prompt. |
| `variables` | object | No | The values of a Prompt's `{{placeholders}}`, over the project-wide ones |
| `workspace` | list | No | Task references whose workspaces this task starts from: `- task: name[@resource]` |
| `graders` | list | Yes | One or more grader definitions |
| `solution` | string | No | Reference solution script (relative to the eval directory), used by `--validate` |
| `expected` | any | No | The answer key. Reaches graders (`SKILLGRADE_INPUT`), never the agent. |
| `metadata` | object | No | Labels for `--filter`, recorded with the results |
| `harness`, `model`, `command`, `runtime`, `trials`, `timeout`, `llm_model`, `llm_provider`, `docker`, `environment` | | No | Per-task overrides of `defaults` |

### Task workspace

A task's workspace is the folder named after it under the eval's `workspace/`: `workspace/<task name>/` is copied into the agent's working
directory (modes are kept, so an executable stays executable). No folder means an empty workspace. Nothing else of the eval is ever
copied in; graders reach the workspace only after the agent has exited.

### Task references

`workspace: [{task: ref}]` starts a task from other tasks' workspaces, copied in order, then the task's own folder on top.

Borrowing is recursive: each referenced task contributes its own effective workspace (what it borrows, depth-first in declared order, then its folder). Each reference is resolved from the eval that declares it. A folder reached more than once is copied only at its first place in that order. Cycles, including a task borrowing itself, are rejected before any trial with the cycle's path.

| Reference | Resolves to |
|-----------|-------------|
| `name` | a task of the same eval only. Unknown names error with `"name" not defined in "resource"` and, if another resource has it, a hint such as `did you mean name@skills:other?` |
| `name@resource` | a task of the resource named `resource`, anywhere in the project, when that name is unique. Ambiguous across kinds: an error asking for the full form. |
| `name@kind:resource` | the full form, with `kind` one of `skills`, `agents`, `instructions`, `prompts` |

References of every task are checked before any trial, selected or not.

### grader entries

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `type` | string | Yes (unless `llm_judge`) | `deterministic` or `llm_rubric` |
| `run` | string | Deterministic only | Command to execute, e.g. `bash graders/check.sh`; `graders/` of the eval is staged for it |
| `setup` | string | No | Install command for grader dependencies (Docker image build) |
| `rubric` | string | LLM only | Evaluation rubric text, or a file path |
| `llm_judge` | string | No | The name of a Judge: the file `llm_judges/<name>.md` of this eval's directory. It is the rubric, so give either `llm_judge` or `rubric`; `type` may be left out. |
| `llm_provider` | string | No | LLM API that scores the rubric: `gemini` (default), `anthropic`, `openai`, or `jev` |
| `llm_model` | string | No | LLM model override. Highest precedence. |
| `weight` | number | No | Grader weight (default: 1) |

**Judge file format.** `llm_judges/<name>.md` is plain text: its whole content, trimmed, is the rubric given to the LLM (no frontmatter
convention, and no variables). The name must be a plain name (letters, digits, `_`, `-`, `.`). A missing or empty file fails before any trial.

### File references

String values (`instruction`, `rubric`, `run`) support file references: if the value is one line and a file of that path exists
(relative to the eval directory), its contents are read:

```yaml
instruction: instructions/fix-linting.md
rubric: rubrics/workflow-quality.md
```

## Prompts

A Prompt file is frontmatter (`name:` required) and a body with `{{variable}}` placeholders (`{{ variable }}` also works; names are
letters, digits, `_`, `-`). Before any trial each task's Prompt is rendered with the project's `variables:` under the task's own
`variables:`; the result is what the agent is asked. A value that is an object or list is inserted as JSON. A placeholder with no value
stops the run, naming it. There are no loops or conditionals.

## Harness delivery of an Agent Definition

| Harness | `agent_invocation` | Where it goes | Keys it acts on (besides `name`) |
|---------|--------------------|---------------|----------------------------------|
| `claude-code` | `subagent` | `.claude/agents/<name>.md`, run with `--agent <name>` | `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks` |
| `opencode` | `subagent` | `.opencode/agents/<name>.md`, run with `--agent <name>` | `description`, `mode`, `model`, `temperature`, `top_p`, `steps`, `tools`, `permission` |
| `codex` | `project_instruction` | `AGENTS.md` (the prompt only, without frontmatter) | `description` |
| `gemini-cli` | `project_instruction` | `GEMINI.md` | `description` |
| `acp`, `command` | `project_instruction` | `AGENTS.md` | `description` |

`subagent` always means the definition ran as the top-level agent; it never means the model chose to delegate.

**Harness compatibility.** Before any trial, an Agent Definition's frontmatter keys are compared with the harness's keys above. Unsupported
keys stop the run: `Running eval for X in harness H with a, b keys unsupported; run with --force to continue`. With `--force` the run goes
ahead and every Trial Record is `harness_compatibility: degraded`, listing the keys in `ignored_keys`; otherwise it is `full`.
Skills, Project Instructions and Prompts are never gated.

## Results

Each task writes a report (`<task>_<timestamp>.json`) and appends its Trial Records to the run's file, both in
`<output>/<resource name>/results/` (`--output`, default `$TMPDIR/skillgrade`):

```
<output>/<resource name>/results/<run_id>.trials.jsonl
```

`run_id` is the UTC start time and the short HEAD commit (`20260101T120000Z-abc1234`; `nogit` outside a repo).

### Trial Record (stable contract, `schema_version` 1)

One JSON object per line, one line per trial, self-sufficient: aggregates (mean, pass@k, pass^k) are computed from records, per harness, LLM
and check, never stored in their place. A record holds facts only, never session logs or agent output. Consumers must ignore fields they do not know.
`schema_version` is bumped only when a field is removed, renamed or changes meaning.

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | number | `1` |
| `trial_record_id` | string | `<run_id>/<resource_kind>/<resource_name>/<eval>/<trial>`: deterministic, so re-publishing is idempotent |
| `run_id` | string | Groups every record of one invocation |
| `resource_kind` | string | `skill`, `agent`, `instructions` or `prompt` |
| `resource_name` | string | The resource's name |
| `version_hash` | string or null | The last commit that touched the resource (null outside git) |
| `eval_commit` | string or null | The last commit that touched the eval |
| `eval` | string | The task name |
| `trial` | number | Trial index, from 0 |
| `harness` | string | `claude-code`, `gemini-cli`, `codex`, `opencode`, `acp` or `command` |
| `harness_version` | string | The harness CLI's version, or `unknown` when it cannot be read (other harnesses, or Docker) |
| `llm` | string | The model the harness was told to use (`--model` or `model:`), else `harness-default` |
| `agent_invocation` | string or null | `subagent` or `project_instruction` for an Agent Definition; `null` for a Skill, Project Instructions or a Prompt |
| `harness_compatibility` | string | `full` or `degraded` |
| `ignored_keys` | string[] | Present only when `degraded`: the keys the harness ignored |
| `checks` | object[] | `{check, score, weight}` per grader; `check` is `<grader type>-<n>`, e.g. `deterministic-0`, `llm_rubric-1` |
| `overall_score` | number | The trial's weighted reward, 0 to 1 |
| `date` | string | ISO 8601 UTC |

```json
{"schema_version":1,"trial_record_id":"20260101T120000Z-abc1234/agent/release-notes-writer/write-notes/0","run_id":"20260101T120000Z-abc1234","resource_kind":"agent","resource_name":"release-notes-writer","version_hash":"9f2c...","eval_commit":"9f2c...","eval":"write-notes","trial":0,"harness":"claude-code","harness_version":"2.1.0","llm":"harness-default","agent_invocation":"subagent","harness_compatibility":"full","checks":[{"check":"deterministic-0","score":1,"weight":0.7},{"check":"llm_rubric-0","score":0.8,"weight":0.3}],"overall_score":0.94,"date":"2026-01-01T12:00:00.000Z"}
```
