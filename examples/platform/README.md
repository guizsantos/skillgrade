# Platform Example

One Eval Project holding a resource of each of the four kinds, so you can see how each is
laid out, evaluated and delivered to the agent.

## Structure

```
platform/
├── skills/conventional-commits/SKILL.md      # a Skill: a directory led by SKILL.md
├── agents/release-notes-writer.md            # an Agent Definition: one file
├── instructions/team-conventions/AGENTS.md   # Project Instructions
├── prompts/release-summary.md                # a Prompt, with {{variables}}
└── evals/                                    # The Eval Project: run skillgrade from here
    ├── eval-project.yml                      # defaults, variables, search_paths for all four kinds
    ├── skills/conventional-commits/          # <kind>/<resource name>/
    │   ├── eval.yml
    │   ├── solution/solve.sh
    │   └── workspace/write-commit-message/changes.diff
    ├── agents/release-notes-writer/
    │   ├── eval.yml                          # the second task borrows the first one's workspace
    │   ├── solution/
    │   └── workspace/write-notes/changes.txt
    ├── instructions/team-conventions/
    │   ├── eval.yml
    │   └── solution/solve.sh
    └── prompts/release-summary/
        ├── eval.yml                          # per-task `variables:` and `expected:`
        ├── graders/check-summary.js
        └── solution/
```

## What each one shows

| Kind | Resource | How it reaches the agent | `agent_invocation` |
|------|----------|--------------------------|--------------------|
| Skill | `conventional-commits` | discovered by the harness from its skills directory | `null` |
| Agent Definition | `release-notes-writer` | run as the top-level agent (`claude-code`, `opencode`), else its prompt becomes Project Instructions | `subagent` or `project_instruction` |
| Project Instructions | `team-conventions` | `AGENTS.md` copied into the workspace under the harness's own file name (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`) | `null` |
| Prompt | `release-summary` | rendered with the task's variables, then given to the agent as what it is asked | `null` |

- **Names.** A resource is named by its directory (a one-file resource, by its file name without `.md`), and its
  frontmatter `name:` must be the same. Project Instructions have no frontmatter.
- **Task references.** `one-line-notes` in the agent's eval starts from the workspace of `write-notes` with
  `workspace: [{task: write-notes}]`, instead of repeating `changes.txt`.
- **Variables.** `{{product}}` comes from `variables:` in `eval-project.yml`; `{{version}}` and `{{audience}}` from each
  task, which can also override a project-wide value (`for-customers` does).
- **Compatibility.** `release-notes-writer.md` has a `tools:` key. `claude-code` supports it, so the default run is
  `harness_compatibility: full`. On a harness that does not (`codex`, `gemini-cli`, `acp`, `command`) the run stops
  before any trial, naming the key, unless you pass `--force`; every Trial Record is then `degraded` and lists `tools` under
  `ignored_keys`.

## Run

```bash
cd evals
ANTHROPIC_API_KEY=your-key skillgrade --smoke
```

Check every deterministic grader against its reference solution, with no agent and no LLM:

```bash
skillgrade --validate --grader=deterministic --runtime=local
```

Each trial appends a Trial Record to `<output>/<resource>/results/<run_id>.trials.jsonl`, with `resource_kind`,
`agent_invocation` and `harness_compatibility` set as above.
