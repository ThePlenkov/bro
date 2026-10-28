---

title: bro review debt
description: Review debt — harvest unresolved threads on merged PRs into a ledger.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

Review bots comment, you merge, the threads rot. `bro review debt` is the
collections agency: it sweeps merged PRs, writes findings to a local
ledger, and labels each PR so nothing is scanned twice.

```text
PR merged → bro review debt collect → findings land in .agents/review-debt/
                            → PR gets debt:collected (or debt:clean)
                            → you see what's left: bro review debt prs
```

## Commands

| Command                                                                                 | What it does                                                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bro review debt collect`                                                               | Scan merged PRs missing a `debt:*` label, harvest unresolved threads, label the PR `debt:collected` or `debt:clean`               |
| `bro review debt prs`                                                                   | The queue — merged PRs still unprocessed (`--all` for everything)                                                                 |
| `bro review debt status`                                                                | Ledger stats: open/done/wontfix, by area, by author, duplicates                                                                   |
| `bro review debt stats [--by author\|source\|area]`                                     | Reviewer/source signal: findings grouped with fix% — the done share of decided rows. Which bot is worth reading, which is noise   |
| `bro review debt trend [--by author\|source\|area] [--bucket week\|day] [--since DATE]` | Burn-down — open findings per time bucket, with opened/closed deltas. `--json` is chart-ready; ungrouped renders one `all` series |
| `bro review debt list`                                                                  | Raw rows, filterable                                                                                                              |
| `bro review debt mark <pr> <state>`                                                     | Manual override — `skipped` is the human opt-out                                                                                  |
| `bro review debt set <status> --thread-id ID`                                           | Row lifecycle: `claimed` / `done --fix-pr N` / `wontfix` / `duplicate`                                                            |
| `bro review debt sync`                                                                  | Project the ledger into beads — idempotent (`thread_id` → `external_ref`), so `bd ready -l debt` is the work queue                |
| `bro review debt next [--claim] [--json]`                                               | Top open finding, priority-ranked. The agent-fix primitive                                                                        |
| `bro review debt watch [--interval SEC]`                                                | Collect on a timer (default 300s) — catches post-merge bot comments                                                               |

## Labels

| Label            | Meaning                                     |
| ---------------- | ------------------------------------------- |
| `debt:collected` | Swept, findings in the ledger               |
| `debt:clean`     | Swept, nothing found — bro won't look twice |
| `debt:skipped`   | Human opt-out — bro respects it             |

## The fix loop

```bash
bro review debt next --claim              # top finding, now claimed
# ... fix it, push, PR ...
bro review debt set done --thread-id ID --fix-pr N
bro review debt sync                      # closes the bead
```

The ledger dir is machine-local — bro adds it to `.git/info/exclude` on
first write so evidence can't be committed by accident.
