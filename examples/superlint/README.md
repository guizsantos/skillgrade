# Superlint Example

The simplest Eval Project: one Skill, one task. It shows how to evaluate a coding standards skill.

## Structure

```
superlint/
├── skills/
│   └── superlint/
│       └── SKILL.md                     # The skill being tested (the resource)
└── evals/                               # The Eval Project: run skillgrade from here
    ├── eval-project.yml                 # defaults + search_paths.skills: ["../skills"]
    └── skills/
        └── superlint/                   # named after the skill it evaluates
            ├── eval.yml                 # the tasks
            ├── graders/check.sh         # deterministic grader
            ├── solution/solve.sh        # reference solution for --validate
            └── workspace/
                └── fix-linting-errors/  # named after the task: copied into the agent's workspace
                    ├── app.js           # Broken file the agent needs to fix
                    └── bin/superlint    # Custom tool the agent must use
```

The skill and the evals are kept apart on purpose: the agent only ever sees the
skill and the task's `workspace/` folder, never `eval.yml`, the graders or the solution.

## What's tested

The agent must discover the `superlint` skill from `SKILL.md` and follow a
mandatory 3-step workflow (check → fix → verify) to fix coding standard
violations in `app.js`.

## Graders

- **Deterministic** (70%): `graders/check.sh` checks that `.superlint-passed` exists and the code was corrected
- **LLM Rubric** (30%): evaluates workflow compliance and efficiency

## Run

```bash
cd evals
GEMINI_API_KEY=your-key skillgrade --smoke
```

Check the graders against the reference solution first, with no agent and no LLM:

```bash
skillgrade --validate --grader=deterministic --runtime=local
```
