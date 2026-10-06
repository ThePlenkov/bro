---
name: query
description: "Use when writing or running a `kind = \"query\"` plan — cross-provider GraphQL fan-out over bro connectors (github/gitlab/atlassian), one merged JSON answer. Thin wrapper over `bro query` — mechanics live in the CLI (spec: specs/bro-14h8.1.md)."
---

# /query (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

A `query` plan is a TOML list of independent GraphQL steps. `bro run`
fans them out over connectors under a concurrency cap and prints one
merged JSON document keyed by step `id` — declaration order, never
completion order. `bro query <file>` is the same pipeline in one step;
`bro plan validate <file>` checks without executing.

## The contract

- `provider` names a **connector** (the data plane: `github`,
  `gitlab`, `atlassian`, …) — never a `providers[]` entry; that
  registry is the *model* plane. Absent → `connectors.queries` pin →
  auto-detect.
- **Read-only.** `mutation`/`subscription` documents are rejected at
  validate time — v1 has no write path, and the keyword sniff
  over-rejects by design (a field literally named `mutation` can't be
  expressed; that's the safe direction).
- **No secrets in plans.** `env` is a *literal* overlay — a token value
  written there is committed as text. Auth always comes from the
  spawned CLI's own login (`gh auth`, `glab auth`, `atlassian auth`) or
  the operator's inherited `process.env`. Endpoint-redirecting vars
  (`ATLASSIAN_API_URL`) are rejected outright — they could exfiltrate
  an inherited `Authorization` header; operators pin endpoints via the
  `query.env` config section instead.
- `vars` are scalars (string/number/bool) for `github`/`gitlab` —
  serialized as `-f k=v` CLI fields. `atlassian` takes the table as the
  JSON `variables` body verbatim.
- A failed step records `{ provider, error }` (transport) or
  `{ provider, data?, errors? }` (GraphQL response) and never aborts
  siblings. Any failure → exit 1; results still print.
- Output is **raw** — no item normalization in v1. If you need
  title/status/url rows, write the jq yourself or file the follow-up.

## Plan shape

```toml
kind = "query"
version = 1
concurrency = 4        # optional; config default is query.concurrency

[[steps]]
id = "gh-prs"
provider = "github"
graphql = """
query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 20, states: OPEN) { nodes { number title url } }
  }
}
"""
[steps.vars]
owner = "theplenkov"
name = "bro"
```

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro query <plan.toml>` | validate + run; merged JSON on stdout, exit 1 on any step failure |
| `bro run <plan.toml>` | same execution via the `kind` router |
| `bro plan validate <plan.toml>` | schema + read-only gate only |

## Config

```jsonc
{ "query": { "concurrency": 4, "env": { "GITLAB_HOST": "gl.corp.example" } } }
```

`query.env` applies under every step's `env` — it is where endpoint
pins belong, including the ones plans are forbidden to carry.

## Policy

- Prefer one plan over N serial `gh api` calls — the fan-out is the
  point, and the merged document is the artifact.
- A step failure is data, not a crash: read `error`/`errors` per key,
  retry only the failed step.
