---
name: debt
description: "Use when the user invokes /debt or asks about review debt on merged PRs. Thin wrapper over the bro CLI — all mechanics live in `bro debt *` commands; this skill carries policy only. Requires `bro` (npx -y @theplenkov/bro@0) and gh."
---

# /debt (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement what `bro debt` already does.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0` (major-pinned). Requires
`gh` auth.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro debt collect [filters]` | Scan merged PRs **without** a `debt:*` label → collect unresolved threads → write `harvests/*.jsonl` + project into beads → label `debt:collected` / `debt:clean` |
| `bro debt status` | Ledger summary + unprocessed merged-PR count |
| `bro debt prs` | Merged PRs still unprocessed — the work queue (`--all`: full matrix) |
| `bro debt list` | Ledger rows (`--status`, `--area`, `--author`, `--priority`, `--pr`) |
| `bro debt mark <pr> <state>` | `collected` / `clean` / `skipped` / `none` — manual override |
| `bro debt set <status> --thread-id ID` | Ledger status: `claimed` / `done --fix-pr N` / `wontfix` / `duplicate` — feeds `bro debt sync` |
| `bro debt sync` | Project the ledger into beads — `bd ready -l debt` becomes the work queue |

## Policy

- **`debt:*` labels are the PR-level source of truth** for "processed".
  `skipped` is a human opt-out and always wins over machine labels.
- **beads is a default store.** collect auto-`bd init --stealth`s a repo
  missing `.beads` (nothing lands in git) and keeps the ledger dir out of
  git via `.git/info/exclude`. `"stores": ["jsonl"]` in bro.config.json is
  the opt-out.
- **Label after the file lands.** In CI pipelines run
  `collect --no-label`, land `harvests/*.jsonl`, then `bro debt mark`.
- **Collect, don't fix.** Triage → backlog, fixes → the fix loop. bro-debt
  never edits product code or resolves threads on source PRs.
- `--reharvest` bypasses the label skip for one run.
