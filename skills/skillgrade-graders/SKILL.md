---
name: skillgrade-graders
description: Authors deterministic and LLM rubric graders for skillgrade evaluations. Use when creating scoring scripts, writing evaluation rubrics, or combining multiple graders with weighted scoring. Don't use for setting up an Eval Project, configuring defaults or search paths, or general test writing.
---

# Skillgrade Grader Authoring

## Procedures

**Step 1: Identify the Grading Strategy**
1. Determine whether the task requires objective verification (deterministic) or qualitative assessment (LLM rubric).
2. For most tasks, combine both: deterministic graders verify outcomes (weight 0.7), LLM rubrics assess approach quality (weight 0.3).

**Step 2: Write a Deterministic Grader**
1. Create a script in the `graders/` directory of the resource's eval in the Eval Project (`<eval project>/<kind>/<name>/graders/`), never inside the resource itself: graders must stay out of the agent's reach. The agent's workspace is the script's working directory.
2. The script must output a JSON object to stdout with the following structure:
   ```json
   {"score": 0.67, "details": "2/3 checks passed", "checks": [{"name": "check-name", "passed": true, "message": "Description"}]}
   ```
3. `score` (0.0–1.0) and `details` are required. `checks` is optional but recommended.
4. Read `references/grader-output-schema.md` for the full output specification.
5. Use `awk` for arithmetic in bash scripts — `bc` is not available in `node:20-slim`.
6. Reference the grader in the eval's `eval.yml`:
   ```yaml
   - type: deterministic
     run: bash graders/check.sh
     weight: 0.7
   ```

**Step 3: Write an LLM Rubric Grader**
1. Draft a rubric with explicit scoring criteria and point allocations.
2. Structure the rubric into weighted sections that sum to 1.0:
   ```
   Workflow Compliance (0-0.5):
   - Did the agent follow the mandatory workflow steps?
   Efficiency (0-0.5):
   - Completed in ≤5 commands without trial-and-error?
   ```
3. Reference the rubric in the eval's `eval.yml`:
   ```yaml
   - type: llm_rubric
     rubric: |
       [rubric text or file path]
     weight: 0.3
     llm_provider: gemini           # optional: gemini (default) | anthropic | openai | jev
     llm_model: gemini-3.5-flash    # optional model override (defaults to the latest dynamically resolved flash model)
   ```
4. For long or reusable rubrics, write a Judge: a file `llm_judges/<name>.md` in the eval's directory with optional frontmatter (`llm_provider`, `llm_model`) and the rubric as its body, and reference it by name instead of `type` and `rubric`:
   ```yaml
   - llm_judge: workflow-quality    # llm_judges/workflow-quality.md
     weight: 0.3
   ```
   A grader takes either `llm_judge` or `rubric`, not both, and must not set `llm_provider`/`llm_model` itself (the judge does; `weight` stays on the grader). A judge's LLM is layered per field: project defaults < eval `defaults` < the judge's frontmatter, with a task-level setting filling a field the judge leaves unset (and an error if the judge sets it too). A judge has no implicit provider: an unset `llm_provider` or `llm_model` fails the run before any trial, as does a missing or empty judge file.

**Step 4: Combine Multiple Graders**
1. Assign weights to each grader based on importance. Weights are normalized automatically.
2. Final reward is calculated as: `Σ (grader_score × weight) / Σ weight`.
3. Example configuration:
   ```yaml
   graders:
     - type: deterministic
       run: bash graders/check.sh
       weight: 0.7
     - type: llm_rubric
       llm_judge: quality
       weight: 0.3
   ```

**Step 5: Validate Graders**
1. Create a reference solution script that produces the expected output, and point the task at it with `solution: solution/solve.sh` (relative to the eval's directory).
2. Run `skillgrade --validate` to verify graders score the reference solution correctly.
3. Test only deterministic graders: `skillgrade --grader=deterministic` (skips LLM calls, faster iteration).
4. Test only LLM rubric graders: `skillgrade --grader=llm_rubric`.
5. Run a specific eval with a specific grader type: `skillgrade --eval=my-eval --grader=deterministic`.
6. If a grader returns unexpected scores, inspect the script output and adjust scoring logic.

## Error Handling
* If a deterministic grader outputs non-JSON, ensure all `echo`/`console.log` statements except the final JSON result are redirected to stderr.
* If an LLM rubric grader returns 0.00 with a missing API key message, set the appropriate key for your LLM provider: `GEMINI_API_KEY` (llm_provider: gemini), `ANTHROPIC_API_KEY` (llm_provider: anthropic), `OPENAI_API_KEY` (llm_provider: openai), or `JEV_API_KEY` (llm_provider: jev).
* To use a custom/self-hosted LLM endpoint, set `ANTHROPIC_BASE_URL` (for llm_provider: anthropic) or `OPENAI_BASE_URL` (for llm_provider: openai) — e.g. for Ollama or vLLM.
* If scores are inconsistent across trials, reduce rubric ambiguity by adding concrete examples of passing and failing behavior.
