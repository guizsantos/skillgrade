# Trial Records, not summaries, are the published contract

Skillgrade emits one Trial Record per trial: resource identity and version, Harness and version, LLM, agent invocation, harness compatibility, per-check scores, overall score and date. Aggregates (mean, pass@k, pass^k) are always computed from Trial Records by the consumer, per Harness, LLM and check.

Pushing a precomputed `pass_rate` would be simpler, but it cannot be merged or re-sliced: results land in any order, from different Harnesses and LLMs, and a stored summary is wrong the moment a new trial arrives. Each record has a deterministic id (run id, eval, trial index) so re-publishing is idempotent. Session logs and outputs are excluded: they are large and may be sensitive.
