---
name: conventional-commits
description: Writes commit messages in the Conventional Commits format. Use when asked to write or reword a commit message for a change.
---

# Conventional Commits

Write the commit message as `<type>(<scope>): <summary>`.

1. `type` is one of `feat`, `fix`, `docs`, `refactor`, `test` or `chore`.
2. `scope` is the module the change touches, in lowercase. It may be left out.
3. `summary` is imperative, lowercase, without a trailing period, and the whole first line is at most 72 characters.
4. Add a body only when the change needs an explanation, after a blank line.
