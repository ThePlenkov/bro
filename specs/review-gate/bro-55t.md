# bro-55t — debt trends: burn-down over time

## Problem

`bro debt status` answers "how much is open now" and `bro debt stats`
answers "whose findings get fixed". Neither answers "are we winning" —
the ledger holds the data (append-only harvest snapshots + `fixed_at`
stamps) but nothing reconstructs the series.

## Design

New subcommand in the same family as `stats`:

```text
bro debt trend [--by author|source|area] [--bucket week|day]
               [--since DATE] [--json]
```

- `packages/debt/src/trend.ts` — pure `buildTrend(records, bounds, opts)`,
  same group keys and fallback conventions as `groupStats`.
- Per-thread open interval reconstructed as `[firstSeen, closedAt)`:
  - `firstSeen` = earliest `harvested_at` across the append-only harvest
    snapshots containing the thread (the merged row carries the *latest*
    harvest time — wrong edge for "debt incurred"). New store export
    `readThreadBounds` returns first/last observation per `thread_id`.
  - `closedAt` = `fixed_at` when stamped; for a decided row without a
    stamp (pre-existing `duplicate` overlays), the last harvest
    observation — it was still open when last seen; else `null` → open
    through `now`. `open`/`claimed`/unknown statuses are undecided, same
    convention as `stats` fixRate.
- `applyDebtVerdicts` stamps `fixed_at` on `duplicate` too — a duplicate
  leaves the open pool like done/wontfix; unstamped it would ride the
  open line forever.
- `upsertRecords` clears `fix_pr`/`fixed_at` when the effective status
  isn't terminal — a reharvested duplicate reopens and must not carry a
  stale close stamp (the non-reopen branch only ever yields open/claimed).
- Buckets: UTC day or ISO week (Mon-start), labeled by bucket-start date
  `YYYY-MM-DD`. Default range: earliest `firstSeen` → current bucket;
  `--since` drops earlier buckets.
- Row per (bucket × group), dense (zero-filled): `bucket`, `key`
  (`all` when ungrouped), `opened`, `closed`, `open` — open counted at
  `min(bucketEnd, now)` so the current bucket is a live count.
- Output is TSV + `--json`, same contract as `stats`. No charting —
  the site dashboard (bro-xk0) consumes `--json`.

## Out of scope / approximations

- Overlay history is single-value — a done→reopen→done cycle collapses
  to the latest stamps. Documented, not event-sourced.
- Unparseable timestamps: a missing open edge is treated as "open since
  before the first bucket" (conservative — debt stays visible); a missing
  close edge as "still open".

## Plan

- [ ] `trend.ts` — `buildTrend` + bucket math; `groupKey` shared w/ stats
- [ ] `store.ts` — `readThreadBounds`; `fixed_at` on duplicate verdicts;
      clear `fix_pr`/`fixed_at` on non-terminal merge
- [ ] `index.ts` exports; cli `debt trend` + usage line
- [ ] `trend.test.ts` + `store.test.ts`/`stats.test.ts` additions
- [ ] docs: site `commands/debt.md`, `skills/debt/SKILL.md` (+ regen)
