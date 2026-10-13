# Skillgrade

Evaluates how well static, text-based resources steer a coding agent, by running the agent in a limited workspace and grading the outcome. Standalone product; publishing results to a LiteLLM gateway is optional.

## Language

**Static Resource**:
Any authored, text-based artifact that steers an agent and can be evaluated by running an agent with it. Umbrella for the four kinds below.
_Avoid_: Subject, artifact

**Skill**:
A directory led by `SKILL.md` that an agent discovers and loads on demand. The original Static Resource.

**Agent Definition**:
The prompt (and its settings) that defines a custom agent inside a larger AI platform, for example a LiteLLM gateway agent. Not necessarily a markdown file. Evaluated as the top-level agent of a run.
_Avoid_: AGENT.md, AGENTS.md (those name files, not the concept)

**Project Instructions**:
A file always loaded into an agent's context for a project, such as `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.

**Prompt**:
A reusable prompt template held by a platform, with variables. A task supplies the variable values (`variables:`, over the project-wide ones in the Project File), the expected results and the graders. The rendered Prompt is what the agent is asked; a Prompt task's own `instruction` is optional and follows it.

**Harness**:
The coding-agent CLI or runtime that runs a trial (Claude Code, Codex, Gemini CLI, opencode, ...). Scores are never comparable across Harnesses, just as they are not across LLMs.
_Avoid_: agent (reserved for Agent Definition)

**Agent Invocation**:
How a Harness is given an Agent Definition: `subagent` (the Harness's native mechanism) or `project_instruction` (fallback when the Harness has none). Recorded with every result.

**Trial Record**:
One trial's facts, self-sufficient for aggregation: Static Resource identity and version hash, Harness and version, LLM, Agent Invocation, per-check scores, overall score, date. Aggregates (mean, pass@k, pass^k) are computed from Trial Records, never stored in place of them, so records can arrive in any order.

**Eval Project**:
A directory of evals kept apart from the Static Resources it evaluates, so nothing in it can reach the agent. Holds `eval-project.yml` plus one `<kind>/<name>/` directory per resource, named after the resource it evaluates.

**Project File**:
`eval-project.yml`: sets defaults, project-wide variables and, under `search_paths`, where each Static Resource kind is found (`search_paths.skills: ["../skills"]`). A resource's kind is whichever search path it was found in.

**Harness Compatibility**:
`full` or `degraded`, recorded on every result. `degraded` means the Static Resource carries settings the Harness does not support (listed in the result); such a run stops early unless `--force` is given.
_Avoid_: unsupported features

**Eval**:
The `eval.yml` in a resource's directory of the Eval Project, holding its tasks. A resource with no Eval is untested.

**Task**:
One scenario in an Eval, with expected results, graders and a solution. Its workspace is the folder named after it under the Eval's `workspace/`, so the name is never repeated in YAML. No folder means an empty workspace. A task can reuse another's workspace with `workspace: [{task: name[@resource]}]`. `expected` and `solution` stay in YAML and only graders see them.

**Judge**:
A reusable LLM-grader definition under `llm_judges/`, referenced from a grader by name (`llm_judge: judge-name`).

**Resource Name**:
The directory name of a Static Resource (for a Prompt, its file name without `.md`). Its frontmatter `name:` is required and must equal it; a missing or different name fails loudly. Names are unique within a kind, not across kinds. Project Instructions are exempt: they carry no frontmatter, and their name is the directory name only.

**Task Reference**:
`task: name` resolves only within the same Eval, and an unknown name errors with a project-wide "did you mean `name@skills:other`?" hint. `task: name@resource` resolves across the whole project when `resource` is unique, and errors when it is ambiguous across kinds. The full form is `task: name@kind:resource`.

**Gateway Resource**:
The record in the LiteLLM gateway that corresponds to a Static Resource, and that Trial Records are published to. Matched by name; zero or multiple matches fail loudly.

## Relationships

- A **Static Resource** is exactly one of: **Skill**, **Agent Definition**, **Project Instructions**, **Prompt**.
- Trial Records flow one way: skillgrade publishes them to a **Gateway Resource**; it never reads Static Resources back from the gateway.
- Only a Static Resource with a **Gateway Resource** is published. Project Instructions have none today, so they are evaluated and reported locally only.
- A Static Resource can carry settings its **Harness** does not support. Running it anyway requires `--force` and marks the result.
