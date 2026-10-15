# CI Integration Example

Run skillgrade from the Eval Project directory (the one with `eval-project.yml`).

## GitHub Actions Workflow

```yaml
name: Skill Evaluation
on:
  push:
    branches: [main]
  pull_request:

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install skillgrade
        run: npm i -g skillgrade

      - name: Run evaluations
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          cd evals
          skillgrade --regression --ci --runtime=local --output=skillgrade-results
```

## Key Flags for CI

| Flag | Description |
|------|-------------|
| `--ci` | Exit non-zero if pass rate is below threshold |
| `--threshold=0.8` | Set the pass rate threshold (default: 0.8) |
| `--regression` | Run 30 trials for high-confidence detection |
| `--runtime=local` | Run trials on the runner; no Docker image build |
| `--force` | Run an Agent Definition even though the harness ignores some of its keys (results are marked `degraded`) |
| `--output=DIR` | Save reports and Trial Records to a specific directory for artifact upload |

## Uploading Reports and Trial Records as Artifacts

Each resource's results, including its `<run_id>.trials.jsonl` Trial Records, are under `<output>/<resource name>/results/`.

```yaml
      - name: Upload eval results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: skillgrade-results
          path: evals/skillgrade-results/
```
