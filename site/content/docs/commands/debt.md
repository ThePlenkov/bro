---
title: bro debt
description: Review debt — harvest unresolved threads on merged PRs into a ledger.
---

Review bots comment, you merge, the threads rot. `bro debt` is the
collections agency: it sweeps merged PRs, writes findings to a local
ledger, and labels each PR so nothing is scanned twice.

```text
PR merged → bro debt collect → findings land in .agents/review-debt/
                            → PR gets debt:collected (or debt:clean)
                            → you see what's left: bro debt prs
```

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro debt collect` | Scan merged PRs missing a `debt:*` label, harvest unresolved threads, label the PR `debt:collected` or `debt:clean` |
| `bro debt prs` | The queue — merged PRs still unprocessed (`--all` for everything) |
| `bro debt status` | Ledger stats: open/done/wontfix, by area, by author, duplicates |
| `bro debt list` | Raw rows, filterable |
| `bro debt mark <pr> <state>` | Manual override — `skipped` is the human opt-out |
| `bro debt set <status> --thread-id ID` | Row lifecycle: `claimed` / `done --fix-pr N` / `wontfix` / `duplicate` |
| `bro debt sync` | Project the ledger into beads — idempotent (`thread_id` → `external_ref`), so `bd ready -l debt` is the work queue |
| `bro debt next [--claim] [--json]` | Top open finding, priority-ranked. The agent-fix primitive |
| `bro debt watch [--interval SEC]` | Collect on a timer (default 300s) — catches post-merge bot comments |

## Labels

| Label | Meaning |
| ----- | ------- |
| `debt:collected` | Swept, findings in the ledger |
| `debt:clean` | Swept, nothing found — bro won't look twice |
| `debt:skipped` | Human opt-out — bro respects it |

## The fix loop

```bash
bro debt next --claim              # top finding, now claimed
# ... fix it, push, PR ...
bro debt set done --thread-id ID --fix-pr N
bro debt sync                      # closes the bead
```

The ledger dir is machine-local — bro adds it to `.git/info/exclude` on
first write so evidence can't be committed by accident.
