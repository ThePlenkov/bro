---
name: sync
description: "Use when the user invokes /sync or asks to publish/restore bro artifacts (review-debt ledger, evidence packs) across machines or agents. Thin wrapper over `bro work sync` — mechanics live in the CLI."
---

# /sync (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Artifact sync keeps git-memory artifacts — the review-debt ledger, drill
evidence, future plugin state — on a standalone data ref
(`refs/bro/data`, outside `refs/heads`), so they never appear in MR
diffs or reviewer context. Writes are plumbing-only: the worktree and
the user's index are never touched.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro work sync` | Commit untracked+ignored files under `.agents/` + the debt dir to the data ref, push to `sync.remote` — then run `bd sync` for beads state |
| `bro work sync --pull` | Fetch the data ref and materialize its files into the worktree — the fresh-clone restore path; also runs `bd sync` |

## Policy

- **Opt-in**: add `"gitref"` to `stores` in `bro.config.json` — then every
  `bro review debt` mutation auto-syncs. `sync.ref` / `sync.remote` override the
  ref and remote names.
- Tracked content can never leak: the synced set is `ls-files -o -i
  --exclude-standard` — ignored-and-untracked files only.
- Diverged replicas merge at tree level: `.jsonl` unions by line, every
  other conflict resolves to the local copy (regenerated artifacts are
  safe to clobber; the JSONL holds real history).
- Push is best-effort: failures warn, never fail the command — offline
  must not block local work. `--pull` treats an absent remote ref as
  "nothing to pull" and still runs `bd sync`; it exits nonzero only when
  the remote can't be reached or store replication fails.
- The ref is NOT a branch: `git branch` stays clean, and nobody can
  accidentally check it out or merge it into code.
- **Beads state rides its own transport.** Drill frames, wtfs, retros and
  the ready queue live in the local Dolt DB — `bro work sync` orchestrates
  `bd sync` (beads' pull+merge+push cycle) so one command moves
  everything. `sync.beads: false` opts out; a missing `bd` or `.beads` is
  skipped silently, a `bd sync` failure warns without breaking artifact
  sync.
