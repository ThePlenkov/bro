# bro-pj2g.1 — bro sweep: gated disposal lifecycle for closed beads (distill → archive → prune)

## Problem

The bead lifecycle has every stage except outflow:

```text
inflow:    PRs ──[debt collect]──→ beads            (exists)
execution: beads ──[next/loop]──→ closed            (exists)
distill:   wtf ──[retro]──→ prevention beads        (exists, trigger-based)
outflow:   closed ──[sweep]──→ memory+archive→del   (this spec)
```

Closed beads accumulate forever. They bloat `bd export` output and slow
queries, yet nothing decides when deletion is *safe*: `bd prune` is a
raw verb — run it today and every lesson still sitting in a closed bead
is silently gone. Sweep is the missing stage: harvest what is worth
keeping, snapshot the rest, then prune behind an exit gate that refuses
to burn unharvested work.

## Design

Three subcommands plus a `sweep` config section, following the
plugin-shape convention (command + skill + config section).

### Harvest marker — `sweep` state dimension

A closed bead is *harvested* when it carries the state label
`sweep:distilled`, written via `bd set-state <id> sweep=distilled`
(creates a provenance event + dimension label; `bd state <id> sweep`
reads it back, `bd list` filters on the `sweep:distilled` label). The
marker is the gate's only input — sweep itself never writes it; the
agent that ran the distillation does, one `set-state` per source bead.
Prune deletes the label with the bead, which is correct: the
certification's job ends at deletion.

### `bro sweep status` — the report

Read-only. Over closed non-ephemeral beads: counts split
harvested/unharvested, age distribution against `sweep.olderThanDays`,
and the would-burn set — exactly what `run` would pass to `bd prune`.
Answers "what does sweep think is garbage, and what is it still
protecting?" without mutating anything.

### `bro sweep distill` — materialize harvest work, don't judge

Distillation is agent judgment — which observations deserve `bd
remember` (persistent memory, injected at `bd prime`, survives prune)
and which deserve a prevention/retro bead via the existing `sink:`
route — so the command does not judge inline. It materializes the work:
the unharvested closed set becomes a molecule whose steps an agent
executes (convoy/`bro agents up`), ending each with
`bd set-state <id> sweep=distilled`. `bro learn capture` stays the
distill engine for drill/retro/act/mol artifacts — sweep's set is
closed beads with no structured artifact, i.e. judgment, not parsing.
`--dry-run` prints the set it would materialize.

### `bro sweep run` — the gated pipeline

Ordered stages, each logged; `--dry-run` reports every stage and writes
nothing:

1. **Gate** — compute unharvested closed beads older than
   `sweep.olderThanDays` (default 30d). Non-empty → refuse, list them,
   exit non-zero. `--force` overrides explicitly, never silently: the
   refusal is the feature.
2. **Archive** — `bd export` snapshot written to
   `<sweep.dir>/<utc-timestamp>.jsonl` (default `.agents/sweep/`, a new
   `.gitignore` entry alongside `.agents/review-debt/`). Ignored +
   untracked is the transport contract: `bro sync` commits it to
   `refs/bro/data` automatically — same git-memory channel as the
   review-debt ledger and drill evidence, outside `refs/heads`, never in
   MR diffs. Memories stay excluded (bd default — they may carry
   sensitive context and survive in their own store anyway).
3. **Prune** — `bd prune --older-than <N>d --force`. bd's own
   protections apply unchanged: pinned beads, open/in-progress,
   ephemeral, and any closed bead cited by an open bead's description,
   notes, or comments are skipped — the ADR-trail safety net needs no
   reimplementation.
4. **Flatten** — `bd flatten`: squash Dolt history to one commit + full
   GC, the actual space reclaim after row deletes. Irreversible and
   slow on big stores, so it is a real stage with an escape:
   `sweep.flatten` (default `true`) or `--no-flatten` when the run is
   about correctness, not size.

`run` is designed to be wired into `bro loop` end-of-queue and
scheduled flows — the gate makes it safe to invoke unconditionally.

### Config

```json
"sweep": { "olderThanDays": 30, "dir": ".agents/sweep", "flatten": true }
```

`olderThanDays` feeds both the gate and `bd prune --older-than` so the
two can never disagree. `BRO_SWEEP_DIR` env wins over `dir`, mirroring
`BRO_DEBT_DIR`.

## Out of scope / approximations

- **Provenance retention is unverified.** `bd prune --help` lists
  issues/dependencies/labels/events/comments as deleted — provenance
  rows are not named. If they die with the bead, the JSONL archive
  covers issue content but not the bead→SHA/PR bindings; a
  `bd provenance log` dump joins the archive then. Verified in the
  plan, decided there — not specced blind.
- **`bd set-state` writes an event bead per call** — distill marks
  leave residue event beads behind. They are outside `bd prune`'s
  scope (ephemeral-class → `bd purge`); accepted, not solved.
- **`bd audit` / `audit.enabled`** — `bd audit` exists as an
  append-only JSONL interaction log; whether a config gate exists and
  whether sweep should enable it per-repo for SFT capture is open —
  not in v1.
- **Distill quality** is the executing agent's judgment, not the
  command's — sweep owns the set membership and the marker contract,
  nothing more.

## Plan

- [ ] verify: does `bd prune` drop `bd provenance` rows bound to
      pruned beads? (test bead → `provenance record` → prune →
      `provenance by-ref`); if yes, archive gains a provenance dump
- [ ] `packages/core/src/config.ts`: `sweepSection` —
      `olderThanDays`, `dir` (`BRO_SWEEP_DIR` env wins), `flatten`
- [ ] `packages/cli/src/commands/sweep.ts`: `status`, `distill`
      (`--dry-run`), `run` (`--dry-run`, `--force`, `--no-flatten`) —
      prune/flatten/remember/provenance via the existing `bd` wrapper
- [ ] plugin registry entry in `plugins.ts` (name, summary, config
      key, skill) + `bro plugins` visibility
- [ ] `.gitignore`: `.agents/sweep/` next to `.agents/review-debt/`
- [ ] `skills/sweep/SKILL.md` — thin policy wrapper (gate semantics,
      distill-is-a-convoy, marker contract)
- [ ] tests: `sweep.test.ts` — gate refuse/pass, dry-run purity,
      marker set membership, config normalization
- [ ] `npm test` (exact CI command), typecheck, commit + push +
      `gh pr create`
