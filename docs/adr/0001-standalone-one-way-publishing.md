# Skillgrade is standalone; publishing to a gateway is one-way and optional

Skillgrade works with no database or gateway. Results can optionally be published to a LiteLLM gateway so people and LLMs browsing Gateway Resources can see how well tested each one is. Publishing only ever writes results to a Gateway Resource; skillgrade never reads Static Resources back from the gateway, and a database connection is never required.

Aggregating and displaying results inside LiteLLM is a separate change to LiteLLM's own repository. Stock LiteLLM only stores arbitrary JSON on resources and its UI renders none of it, so this is the only route that avoids a stopgap write that LiteLLM would later change.

## Considered options

- Pull Static Resources from the gateway and evaluate them: rejected, it makes the gateway the source of truth and conflicts with git provenance (`--from-head`).
- Write straight to LiteLLM's Postgres: rejected, it couples skillgrade to LiteLLM's schema and skips its validation and reload.
- Ship a push against stock LiteLLM now (namespaced metadata key): deferred, it would write somewhere the LiteLLM change is likely to move.
