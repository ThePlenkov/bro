---
title: Integrations
description: gh, beads, agent clients, hooks — what bro plugs into.
---

## GitHub (`gh`)

All review data comes through the authenticated `gh` CLI — check runs,
commit statuses, review threads (GraphQL), labels, merges. No tokens to
configure; if `gh` works, bro works.

## Beads (`bd`)

beads is the default memory: debt rows project into `bd` as labeled
beads, drill frames are beads, retros and wtfs are beads.
`bd ready -l debt` is the work queue; `discovered-from` links keep
provenance. Opt out per repo with `"stores": ["jsonl"]` — the JSONL
ledger keeps the receipts either way.

## Agent clients

One repo ships adapters for each client — generated from the same skills
and hooks by `scripts/gen-plugins.ts`:

| Client | Package |
| ------ | ------- |
| Devin | `plugins/devin/bro` |
| Claude Code | `plugins/claude/bro` |
| Codex | `plugins/codex/bro` |

### Hooks

Every adapter wires `hooks/run.sh`:

- **Session start / post-compaction** — rehydrates state (open drill
  frames, pending debt)
- **Stop gate** — blocks once while a drill frame is open or review
  threads are unresolved; a repeated stop is let through — gates, not
  loops
- **Self-approve** — `bro` and `bd` commands run without prompting

Local dist → `bro` on PATH → major-pinned `npx` fallback; always
fail-open so a broken bro never wedges a session.

## The data ref

`bro sync` pushes `.agents/` and the ledger to `refs/bro/data` — git
memory that travels with the repo but never appears in a PR diff or
branch list.
