# Examples

Each example is an [Eval Project](../README.md#the-eval-project): a directory with `eval-project.yml` and one
`<kind>/<name>/` directory per resource it evaluates, kept apart from the resources themselves. Run `skillgrade`
from the example's `evals/` directory.

| Example | Kinds | Shows |
|---------|-------|-------|
| [superlint](superlint/) | Skill | The simplest project: a task workspace, a script grader, an inline rubric, a reference solution |
| [angular-modern](angular-modern/) | Skill | A static analysis grader with partial credit, and a reusable Judge (`llm_judge`) |
| [platform](platform/) | Skill, Agent Definition, Project Instructions, Prompt | All four kinds in one project: search paths, naming, task references, Prompt variables, `agent_invocation` and `harness_compatibility` |

Every example can be checked without an agent or an LLM, against its reference solutions:

```bash
cd examples/<example>/evals
skillgrade --validate --grader=deterministic --runtime=local
```
