---
name: sweep
description: "Use when the user invokes /sweep or asks to prune/dispose of closed beads, archive bead history, or run the harvest pipeline. Thin wrapper over `bro sweep` — mechanics live in the CLI (spec: specs/bro-pj2g.1.md)."
---

# /sweep (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro sweep` is the bead lifecycle's outflow stage: closed beads
accumulate forever, and `bd prune` alone would burn lessons nobody
harvested. Sweep gates the burn on a harvest marker.

## The contract

- A closed bead is **harvested** when it carries the `sweep:distilled`
  state label (`bd set-state <id> sweep=distilled`). The marker is the
  gate's only input — no heuristics, no second channel.
- `bro sweep distill` materializes the work instead of judging it:
  beads already cited as learn evidence auto-mark; the rest pour as an
  agent molecule (one step per bead — `bro convoy run` / `bro agents
  up` executes them).
- `bro sweep run` refuses while unharvested closed beads are older than
  `sweep.olderThanDays` (default 30). `--force` is the explicit
  override — the refusal is the feature, so use it only when the burn
  is intended. A closed bead with no `closed_at` also blocks: a row
  that can't be dated can't be proven safe.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro sweep status` | Read-only: harvested/unharvested counts, age vs `olderThanDays`, the would-burn set |
| `bro sweep distill [--dry-run]` | Auto-mark learn-cited beads; pour an agent molecule for the rest |
| `bro sweep run [--dry-run] [--force] [--no-flatten]` | Gate → archive → sync-verify → `bd prune --older-than` → `bd flatten` |

## Pipeline stages (run)

1. **Gate** — unharvested beads past `olderThanDays` block the run.
2. **Archive** — `bd export` JSONL + a per-bead `provenance log` dump
   (`bd prune` deletes provenance rows with the bead — the dump is the
   only place the bead→SHA/PR bindings survive).
3. **Sync-verify** — the archive must commit to `refs/bro/data` and be
   present in the ref tree, or run stops before pruning. `sweep.dir`
   must resolve inside the synced set (`.agents/` or the debt dir) —
   anywhere else warns in `status` and refuses in `run`.
4. **Prune** — `bd prune --older-than <N>d --force`. bd's protections
   apply unchanged: pinned, open, ephemeral, and open-bead-cited rows
   skip.
5. **Flatten** — `bd flatten` squashes Dolt history + full GC (the
   space reclaim). `sweep.flatten: false` or `--no-flatten` skips it.

## Policy

- Wire `bro sweep run` into loop end-of-queue or scheduled flows — the
  gate makes unconditional invocation safe.
- `BRO_SWEEP_DIR` overrides `sweep.dir`; keep it inside `.agents/` or
  archives stop syncing and `run` refuses.
- Memories never leave the local store (`bd export` excludes them) —
  the archive is issue content + provenance, nothing sensitive.
- `bd set-state` leaves one residue event bead per mark; those are
  ephemeral-class and outside `bd prune` scope — accepted, not a bug.
