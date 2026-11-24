# Benchmark corpus (bro-l8c4f.9)

Pinned task corpus for reproducible paired bare-versus-BRO benchmarks
(`native` stays an optional third variant — spec Update 2026-11-08).

## Corpus

- Each task has a pinned `revision`, `models`, CI expectations, and
  `targets` set **before** measurement — no claims without a baseline.
- History tasks (`taskId` = bead id, e.g. `bro-rw8z3`) replay real merged
  work: `revision` is the parent of the pinned `mergeCommit`, the
  reference is the PR diff (`pr`), and the checks are the PR's tests.
  Every history task is a CLOSED bead plus a MERGED PR — verify with
  `bd show <taskId>` and `gh pr view <pr>` before adding one.

## Paired results

- `bro self benchmark run --record <file|-> [--out <path>]` validates
  externally measured rows and appends them to
  `.evidence/benchmark/paired-results.jsonl` (`--out` overrides).
  `--record` input is one JSON object, a JSON array, or JSONL; `-`
  reads stdin. Every row must name a corpus `taskId` at its pinned
  `revision` — anything else is not a paired measurement.
- Row schema: `packages/cli/schemas/benchmark/paired-results.schema.json`
  (draft-07, `additionalProperties: false`). Each line carries `variant`
  (`bare|bro|native`), `model`, `repeat` (run index ≥1 — each
  task/agent/variant runs ≥3 times), `wallMs`, `actRounds`, `toolCalls`,
  `contextPeakTokens`, `costUsd` (required but nullable — unknown is
  not 0), `tokens{input,output,cacheRead,cacheWrite}`,
  `timeToGreenMs`, `humanInterventions`, `controlPlaneCalls`,
  `duplicateWorkCount`, `abandonedWorkCount`,
  `mergedFindingsWithoutFollowup`, and `outcome` (`pass|fail|partial`).
- Bare `run` (no `--record`) still refuses to fabricate measurements —
  paired execution lands with the external arena harness.
- Regression checks for schema/structure must not require live agents,
  UI, or fault injection.
