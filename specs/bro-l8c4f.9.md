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
- **Paired runs**: run the same corpus against (a) bare agent baseline
  and (b) BRO (native automation is an optional third variant), recording runs in a
  paired manner tied by task id and revision via `bro self dogfood benchmark run`
  (and flat alias `bro self benchmark run`).
- **Metrics schema**: publish a stable JSON Schema at
  `packages/cli/schemas/benchmark/paired-results.schema.json` (draft-07)
  and write JSONL results validated by it. Each line captures `taskId`,
  `revision`, `runId`, `variant` (`bare|bro|native`), `model`, `startedAt`,
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

## Update 2026-11-08 — the lift question and the harness (bro-0ykhg)

The point to prove is narrower than "native automation vs bro": **one
prompt, a bare agent with nothing installed, and the same agent with bro**
(plugin + hooks + skills + CLI) — compared on the result first, then on
execution, cost and context.

- **Variants**: `bare` (the agent as installed — no bro plugin, no hooks,
  no `AGENTS.md` bro block, no `bro` on PATH) and `bro` (the portable
  plugin installed the way a user installs it). `native` (Claude monitor,
  Codex exec) stays a third, optional variant.
- **Harness — reuse, don't rebuild**: `@sverka/arena` (sverka specs 41/42)
  already runs one prompt against one agent under plugin combos over ACP,
  with deterministic `checks`, a blind judge, traces, tokens, tool calls
  and timing — TypeScript, the same ACP seam bro's providers speak. bro
  contributes the corpus, the `bro` plugin combo and the outcome fields
  below; arena gains the missing adapters (it ships `devin` only). Those
  adapters are sverka's code: requested through `bro request sverka`,
  never patched in place. Python harnesses (Terminal-Bench/Harbor, Inspect,
  SWE-bench) are task SOURCES, not the harness.
- **Result first**: `outcome` is decided by deterministic checks (tests,
  `bro review act status` green on the PR) before the judge; the judge only
  scores what checks cannot see. The harness runs the act check externally
  after each trial; it does not install bro or expose it to the bare agent.
- **Metrics added to the schema**: extend the draft-07 schema above before
  emitting new rows: `variant` allows `bare|bro|native`; `costUsd` is a
  required non-negative number or null (unknown is not 0),
  `contextPeakTokens`, `toolCalls`, `actRounds`, and `wallMs` are required
  non-negative integers, and `repeat` is a required integer ≥1 (run index).
  Keep `additionalProperties: false`; no ad-hoc fields bypass validation.
  Each (task, agent, variant) runs ≥3 times; reports carry the
  spread, not one number.
- **Corpus from history**: a closed bead + its merged PR is a task with a
  known starting revision, a reference diff and tests as checks. The corpus
  must include multi-step tasks that end at a green PR — bro's overhead
  (hooks, skill text) is real on one-shot tasks, and the report states the
  task length at which `bro` starts winning, or that it does not.

This update supersedes the native-baseline requirement above; `native`
is optional. Acceptance requires one published paired `bare` vs `bro` run on ≥5 history
tasks × ≥3 repeats for at least two agents (one Claude Code, one
opencode/kilo), with targets set before the run.

## Acceptance

- Task corpus published with pinned revisions and model/CI pins.
- JSONL schema published and used for paired results.
- Paired bare-vs-bro results on ≥5 history tasks × ≥3 repeats for at least
  two agents (Claude Code and opencode/kilo), with targets set before
  measurement; native is optional and claims require the paired baseline.
- Schema fixtures accept bare/bro/native and all declared metrics, reject
  unknown fields or invalid ranges, and preserve null unknown cost.
- `npm run build && npm run typecheck && npm test` pass.
