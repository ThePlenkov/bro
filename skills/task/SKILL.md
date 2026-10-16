---
name: task
description: "Use when a runbook, hook, or agent needs to create/update/read beads without naming the backend — `bro task new|desc|show|list|claim|close|note` is the thin facade over the configured task store."
---

# /task (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro task` is the backend-neutral surface for bead work — the store it
reads is the same one `bro next`, `bro work enter`, and the SDD gate
use, so a `bro task new` row is claimable and spec-checkable like any
`bd`-created bead.

- `bro task new <title> [-d desc]` — prints the new id; capture it for
  the later `desc`/`claim` calls.
- `bro task desc <id> 'spec: specs/<id>.md'` — the `spec:` line in the
  description is what the SDD gate reads.
- `bro task show <id>` / `bro task list [--ready]` — orient without a
  second CLI; `--json` for agents.
- `bro task close <id> [reason]` — the honest end; a claimed-but-open
  bead left behind is orphaned work.

Dogfood scenarios and client-facing runbooks spell commands
`npx bro …` — this facade exists so the runbook never names `bd` (the
out-of-the-box proof is: one binary, no second CLI to install).
