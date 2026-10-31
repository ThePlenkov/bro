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

- **Task corpus**: define a corpus of tasks under `dogfood/benchmark/`
  (or extend existing dogfood scenarios with benchmark metadata)
  with pinned revisions, models, and CI expectations. Each task is a
  reproducible unit with a known starting state and success criteria.
- **Paired runs**: run the same corpus against (a) native automation
  baseline (configurable per provider) and (b) BRO, recording runs in a
  paired manner tied by task id and revision.
- **Metrics schema**: write results as JSONL with a stable schema
  capturing `taskId`, `revision`, `runId`, `variant` (`native|bro`),
  `model`, `startedAt`, `finishedAt`, `timeToGreenMs`, `humanInterventions`,
  `controlPlaneCalls`, `tokens{input,output,cacheRead,cacheWrite}`,
  `duplicateWorkCount`, `abandonedWorkCount`, `mergedFindingsWithoutFollowup`,
  `outcome` (`pass|fail|partial`), and `notes`.
- **Targets first**: allow specifying target outcomes before running
  measurements; do not claim savings without a baseline.
- **Integration**: extend `bro self dogfood` (or add `bro self benchmark`)
  to run paired benchmarks, collect metrics via existing OTEL/journal
  where possible, and emit paired results. Preserve grouped CLI and
  flat aliases, single portable skills tree, existing facades. No
  breaking redesign.
- **Regressions**: add regression checks for schema/structure without
  requiring live agents/UI/fault injection in tests.

## Acceptance

- Task corpus published with pinned revisions and model/CI pins.
- JSONL schema published and used for paired results.
- Paired native-vs-BRO results recorded with targets set before
  measurements; claims about economy are not made without baseline.
- `npm run build && npm run typecheck && npm test` pass.
