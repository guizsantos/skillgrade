---
name: superlint
description: The mandatory workflow for fixing code quality issues with our internal SuperLint tool. Use when a task asks for code to meet corporate coding standards.
---

# SuperLint Proprietary Workflow

This skill describes the mandatory standard operating procedure for using our internal **SuperLint** tool. Use this when tasks require fixing code quality issues according to corporate standards.

## 1. Description
SuperLint is a multi-stage validation tool, shipped in the project as `./bin/superlint`. Standard ESLint or Prettier commands will NOT work.

## 2. Mandatory Workflow

To fix a file using SuperLint, you MUST follow these steps in order:

1.  **Check**: Run `./bin/superlint check` to generate a report.
2.  **Fix**: Run `./bin/superlint fix --target <filename>` to apply automated corrections.
3.  **Verify**: Run `./bin/superlint verify` to finalize the changes and generate the `.superlint-passed` metadata file.

> [!IMPORTANT]
> The verifier will fail if `.superlint-passed` is missing, even if the code looks correct.

## 3. Examples

```bash
# Correct usage for app.js
./bin/superlint check
./bin/superlint fix --target app.js
./bin/superlint verify
```
