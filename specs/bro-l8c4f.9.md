---

parent: bro-l8c4f
scope:
- packages/cli/src/commands/dogfood.ts
- packages/cli/src/commands/dogfood.test.ts
- skills/dogfood/SKILL.md
- dogfood/
- docs/

---

# bro-l8c4f.9 — workflow outcome benchmark against native automation baseline

Parent: `bro-l8c4f` (principal audit 2026-10-18 — outcome-benchmark).

## Problem

The principal audit calls for a reproducible paired benchmark comparing
native agent automation (Claude monitor/scheduled tasks, Codex exec/JSONL)
against BRO on identical tasks/model/CI, measuring workflow outcomes:
time-to-green, human interventions, control-plane calls/tokens,
duplicate/abandoned work, merged findings without follow-up. Today there
is no structured way to collect a task corpus, fix revisions/model pins,
record paired runs with a stable JSONL schema, or set target outcomes
before measurement. The dogfood machinery exists but is scenario-driven
for correctness, not outcome benchmarking.

## Design

- **Task corpus**: publish a pinned corpus at `dogfood/benchmark/corpus.json`
  with `pinned: true`, global `ci.required`, and each task carrying
  `taskId`, `revision` (commit SHA), `models[]`, task `ci.required`,
  `successCriteria[]`, and `targets{timeToGreenMs,humanInterventions,controlPlaneCalls,tokens{input,output,cacheRead,cacheWrite},duplicateWorkCount,abandonedWorkCount,mergedFindingsWithoutFollowup}`.
  Each task is a reproducible unit with a known starting state and
  success criteria.
- **Paired runs**: run the same corpus against (a) native automation
  baseline (configurable per provider) and (b) BRO, recording runs in a
  paired manner tied by task id and revision via `bro self dogfood benchmark run`
  (and flat alias `bro self benchmark run`).
- **Metrics schema**: publish a stable JSON Schema at
  `packages/cli/schemas/benchmark/paired-results.schema.json` (draft-07)
  and write JSONL results validated by it. Each line captures `taskId`,
  `revision`, `runId`, `variant` (`native|bro`), `model`, `startedAt`,
  `finishedAt` (ISO 8601 date-time), `timeToGreenMs` (integer ≥0),
  `humanInterventions` (integer ≥0), `controlPlaneCalls` (integer ≥0),
  `tokens{input,output,cacheRead,cacheWrite}` (integers ≥0, all required),
  `duplicateWorkCount` (integer ≥0), `abandonedWorkCount` (integer ≥0),
  `mergedFindingsWithoutFollowup` (integer ≥0), `outcome` (`pass|fail|partial`),
  and optional `notes`. `additionalProperties: false`.
- **Targets first**: targets are loaded from the corpus (and overridable via
  `--targets <path>`) before measurement; paired results are recorded with
  targets present; do not claim savings without a baseline.
- **Integration**: extend `bro self dogfood` and add `bro self benchmark`
  with subcommands `corpus` and `run` (`--targets`, `--out`), collect
  metrics via existing OTEL/journal infrastructure where possible, and
  emit paired JSONL results to `.evidence/benchmark/paired-results.jsonl`
  by default. Preserve grouped CLI and flat aliases, single portable
  skills tree, existing facades. No breaking redesign.
- **Regressions**: add regression checks for schema/structure without
  requiring live agents/UI/fault injection in tests (`packages/cli/src/commands/dogfood.test.ts`).

## Acceptance

- Task corpus published with pinned revisions and model/CI pins.
- JSONL schema published and used for paired results.
- Paired native-vs-BRO results recorded with targets set before
  measurements; claims about economy are not made without baseline.
- `npm run build && npm run typecheck && npm test` pass.
