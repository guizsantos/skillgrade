# Angular Modern APIs Example

An advanced Eval Project for one Skill: static analysis grading and a reusable Judge.

## Structure

```
angular-modern/
├── skills/
│   └── angular-modern-apis/
│       └── SKILL.md                         # Angular modern APIs skill (the resource)
└── evals/                                   # The Eval Project: run skillgrade from here
    ├── eval-project.yml
    └── skills/
        └── angular-modern-apis/             # named after the skill it evaluates
            ├── eval.yml
            ├── graders/check-modern-apis.js # static analysis grader
            ├── llm_judges/migration-quality.md  # reusable rubric
            ├── solution/solve.sh            # reference solution for --validate
            └── workspace/
                └── modernize-component/     # named after the task
                    └── src/app/user-profile.component.ts   # Legacy component to modernize
```

## What's tested

The agent must modernize an Angular component from legacy APIs to modern ones:

| Check | Legacy | Modern |
|-------|--------|--------|
| Inputs | `@Input()` | `input()` / `input.required()` |
| Outputs | `@Output()` + EventEmitter | `output()` |
| DI | Constructor injection | `inject()` |
| Control flow | `*ngIf` / `*ngFor` | `@if` / `@for` |
| Imports | CommonModule | Not needed |

## Graders

- **Deterministic (70%)**: a Node.js grader that reads the component source and uses regex-based static analysis to check 5 patterns. Each check contributes 0.2 to the score, enabling partial credit.
- **LLM Judge (30%)**: `llm_judge: migration-quality` names the file `llm_judges/migration-quality.md`, whose text is the rubric (correctness, completeness, code quality). A Judge keeps the rubric out of the YAML and can be reused by several tasks.

```yaml
graders:
  - type: deterministic
    run: node graders/check-modern-apis.js
    weight: 0.7
  - llm_judge: migration-quality
    weight: 0.3
```

A grader that needs dependencies can install them during the image build with `setup:`, for example
`setup: npm install typescript ts-node @types/node` for a TypeScript grader run by `npx ts-node`.

## Run

```bash
cd evals
GEMINI_API_KEY=your-key skillgrade --smoke
```

Check the deterministic grader against the reference solution, with no agent and no LLM:

```bash
skillgrade --validate --grader=deterministic --runtime=local
```
