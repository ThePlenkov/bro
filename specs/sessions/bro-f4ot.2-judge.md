---
parent: bro-f4ot
scope:
  - packages/core/src/judge.ts
  - packages/judge/
  - packages/cli/src/commands/judge.ts
  - packages/act/
  - packages/cli/src/commands/drive.ts
  - skills/judge/
---

# bro-f4ot.2 — judge facade + jev connector: calibrated decisions for act triage

Parent: `bro-f4ot` (agents facade + bro fleet) → `sessions` capability.
See `bro-f4ot/spec.md` and `spec.md`.

## Problem

The act loop's cheapest decision is also its most expensive one: every
unresolved review thread asks an agent "does this block correctness, how
severe is it, fix/reply/defer?" — and the agent answers with a frontier
LLM's reasoning budget, per thread, per poll round, per fixer spawn.
`bro drive` makes the same call again when it decides whether a PR
needs a fixer at all. The judgment is real — severity-aware triage is
what keeps the act loop off the "fix everything inline" treadmill —
but it is paid for in agent tokens, is unlogged, and is uncalibrated:
nobody can say how often the triage was right, because the verdict was
never recorded.

A calibrated decision model is built for exactly this shape: typed
questions over a compact state, typed answers back, sub-second, priced
in fractions of a cent. But a decision model must not become the exit
gate — the gate is deterministic by design. The judge's place in v1 is
**shadow**: it answers, it logs, it annotates — and it never acts.
Whether it earns the right to advise is a measured question (dogfood),
not an assumed one.

## Terms

- **judge** — the `judge` facade: `decide(state, questions) → typed
  answers`. One capability, many backends (jev, llm-judge cascade).
- **verdict** — the recorded output of one `decide()` call: the
  questions asked, the answers returned, who answered, what it cost.
- **shadow mode** — the only v1 mode: verdicts are logged and rendered
  as annotation, never applied. The exit gate, thread resolution, and
  fixer spawns stay exactly as deterministic as today.
- **outcome** — what actually happened to the subject (a thread got
  fixed/replied/deferred/rejected). The agreement metric's ground
  truth, observed after the fact.
- **escalation** — a low-confidence answer re-decided by the fallback
  connector (llm-judge), marked by its decider.

## The facade — `judge` joins `FacadeMap`

`judge` is a capability on `Connector` like `tasks`/`reviews`/`specs`:
an optional member whose presence advertises the backend. Resolution
reuses the existing precedence — explicit `--connector` →
`bro.config.json` `connectors.judge` → registry order — and the
contract is named by domain semantics (`decide`, `choice`, `score`,
`noul`), never vendor API names.

```ts
/** One typed question — the three kinds jev (and the contract) speak.
 *  `choice` picks among labelled options; `score` rates on an ordered
 *  2–10 level scale; `noul` is a calibrated yes/no probability. */
type JudgeQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

/** The answer's shape is fixed by its question's type — callers branch
 *  on `type` in plain code, no parsing. `decidedBy` names the connector
 *  that produced this answer (an escalated answer says 'llm-judge'). */
type JudgeAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>
      confidence: number; decidedBy: string }
  | { type: 'score'; score: number; probabilities: Record<string, number>
      confidence: number; decidedBy: string }
  | { type: 'noul'; noul: number; decidedBy: string }

interface DecideResult {
  answers: Record<string, JudgeAnswer>  // keyed to the questions asked
  model: string                         // resolved model version
  latencyMs: number
  usage?: { inputTokens?: number; costUsd?: number }
  /** Answer keys below the configured confidence threshold AND not
   *  escalated (no fallback, or fallback also unsure) — advisory
   *  consumers render these dimmed; nobody auto-trusts them. */
  lowConfidence: string[]
}

interface JudgeFacade {
  decide(
    state: unknown,
    questions: Record<string, JudgeQuestion>
  ): Promise<DecideResult>
}
```

Contract rules:

- **Fail-open, always.** A wedged backend (network, 401, 402,
  5xx-after-retries) throws `JudgeUnavailable` — consumers treat "no
  verdict" as "no annotation", never as a gate input. A judge that can
  stall the act loop is a judge that gets turned off; it must not be
  able to.
- **`state` is the caller's payload** — string, object, or array; the
  connector serializes. Input budgets live at the backend (jev: 64k
  tokens state+questions, 32k state+longest question); the facade
  surfaces `max_tokens_exceeded` as an ordinary error — callers trim,
  they don't retry bigger.
- **One call, many questions.** Consumers batch a subject's questions
  into one `decide()` — jev evaluates them in parallel in one round
  trip; a question-per-call loop is a cost bug.
- **Confidence is per-answer.** The threshold (`judge.confidence`,
  default 0.6) is applied by the chain, not the caller: low-confidence
  answers escalate to `judge.fallback` when configured; answers that
  stay low land in `lowConfidence` marked, not hidden.
- **Model pinned.** `judge.model` pins the version (jev docs: pin in
  production so thresholds don't drift under the same inputs).

## Connectors

### `jev` — the primary

Hosted decision API. Facts pinned from
`https://jevtypesafeai.com/docs` (the bead's cited source):

```text
POST {baseUrl}/v1/decide        baseUrl default https://jevtypesafeai.com/api
Authorization: Bearer $JEV_API_KEY   (jv_live_… — env var only, never
                                      committed, never in bro.config.json)
→ { model, answers: {<q>: typed answer}, usage: {input_tokens, cost_usd, …} }
```

Error semantics the connector maps: `400` validation (our bug — throw),
`401/403` auth (throw `JudgeUnavailable` with the remediation line),
`402` insufficient credits (`JudgeUnavailable` — fail-open, same as
down), `502` upstream (bounded retry with backoff, then
`JudgeUnavailable`). Timeouts default `judge.timeoutMs` 3000 — the
decision's value is cheapness; a judge slower than the thing it
annotates is overhead, not help.

The bead notes jev also rides OrcaRouter's OpenAI-compat wrapper as
`typesafe/jev-1.13`; the **native `/v1/decide` shape is the v1
connector** (typed answers, no parsing), the OpenAI-compat path is what
`llm-judge` already is. If a deployment only has OrcaRouter access,
`connectors.judge: llm-judge` + `judge.llm.model: typesafe/jev-1.13`
covers it with no second client.

### `llm-judge` — the fallback

An OpenAI-compatible chat endpoint driven into the same `JudgeQuestion`
contract: the connector renders state + questions into one structured
prompt, maps the model's reply back onto typed answers, and reports its
own confidence (parsed or mapped — never fabricated high). Config:
`judge.llm: { baseUrl, model, apiKeyEnv }`. It exists for two jobs:
escalation on low confidence (the bead's "LLM cascade"), and as the
whole judge where jev isn't provisioned. It is slower and costlier —
its answers carry `decidedBy: 'llm-judge'` so stats can score each
backend on its own record.

### The chain

`judge.fallback` names the escalation connector. `decide()` on the
serving facade runs: primary answers → answers under
`judge.confidence` re-asked on the fallback → merge (fallback answers
keep `decidedBy` honest) → `lowConfidence` lists whatever neither
backend answered confidently. No fallback configured → low-confidence
answers just mark the list. This is facade-internal: the consumer
called one `decide()`.

## Shadow mode — the verdict journal

Every `decide()` a bro command makes is recorded — that is what shadow
means: the verdict exists durably, so it can be scored. The journal is
`<git-common-dir>/bro/judge/verdicts.jsonl`, one line per call:

```ts
interface Verdict {
  ts: string                    // ISO
  kind: string                  // 'act-thread' v1 — the consumer surface
  subject: { pr?: number; threadId?: string; headSha?: string
             commentSha?: string }       // replay dedup key
  questions: Record<string, JudgeQuestion>
  answers: Record<string, JudgeAnswer>
  model: string
  latencyMs: number
  costUsd?: number
  outcome?: string              // filled by stats once observed:
                                // 'fixed' | 'replied' | 'deferred' | 'rejected'
}
```

Append-only, one line per verdict, tmp+rename not needed (append is
atomic at this size). `subject.commentSha` dedups replays: the same
thread re-judged is a new verdict, not a duplicate to suppress — but
stats counts one verdict per (threadId, commentSha) pair when scoring
agreement.

The journal lives in the common git dir for the same reason the agents
registry and hook traces do: linked worktrees share it, nothing lands
in git, `bro sync` can ship it if evidence must move machines.

## First consumer — act triage annotation

`bro act threads` (and the drive fixer prompt's thread list) renders
judge answers beside each unresolved thread when `judge.mode: shadow`:

```text
PRRT_…  src/x.ts:42  cubic
  "…deref of possibly-null…"
  judge: blocks_correctness 0.91 · severity 3/4 (blocking) · action fix
        — decided by jev-1.13.0 (240ms, $0.0009)
```

Questions the act surface asks per thread (the v1 question set, tuned
in dogfood):

- `blocks_correctness` — **noul**: "Does this thread report an issue
  that must be fixed before merge for correctness/security reasons?"
- `severity` — **score** on 4 levels: cosmetic/docs · minor (debt
  material) · should-fix-before-merge · blocking correctness.
- `action` — **choice**: fix | reply | defer | resolve — the act plan's
  own verdict space, so agreement is measurable against the actual
  `ActThreadVerdict` outcome.

Non-negotiable: annotation is rendered, **never applied**. Thread
resolution still needs `bro act resolve/reply`, the exit gate still
reads deterministic state, `act.maxRounds` still bounds the loop.
Shadow exists to *measure* whether the judge deserves advisory weight —
a verdict applied unmeasured is an unearned gate.

## Success metrics — what dogfood must prove

From the bead, as measurable thresholds `bro judge stats` reports:

- **agreement ≥ 85%** — judge `action`/`blocks_correctness` vs recorded
  outcomes on archived review threads (merged PRs' resolved threads,
  where the outcome is known). Per-decider: jev alone, llm-judge alone,
  escalated set.
- **latency < 1s** — p50 `latencyMs` per `decide()` call (jev advertises
  70–500ms; the margin absorbs fallback escalations).
- **cost < $0.01** — mean `costUsd` per `decide()` call (jev advertises
  ~$0.001). Reported with total spend so a noisy week is visible.
- **calibration buckets** — confidence 0.5–0.6, …, 0.9–1.0 × empirical
  agreement: a judge that says 0.9 and is right 60% of the time is not
  calibrated, whatever its raw agreement.

Dogfood verdict: pass → `judge.mode` may gain `advisory` (verdicts
pre-fill the agent's act plan as suggestions, still overridable — a
separate spec); fail or inconclusive → jev stays shadow or the feature
is shelved. The judge earns advisory by measurement, not enthusiasm.

## CLI surface

```text
bro judge decide --state <file|-> --questions <file>   smoke the connector —
                                                      one call, prints answers + usage
bro judge stats [--since <iso>] [--json]               agreement matrix, calibration
                                                      buckets, latency/cost report
bro judge replay [--pr <n>… | --merged-since <iso>]    dogfood: re-judge archived
                                                      threads, write verdicts + report
```

`decide` is the connector smoke-test (does the key work, what does the
model return); `stats` reads the journal + outcomes; `replay`
reconstructs `decide()` inputs from merged PRs' threads and judges them
as they would have been judged — the accuracy report lives in the
journal and its summary on the bead.

Config section (plugin-shaped, `judge` in `bro.config.json`):

```jsonc
{
  "judge": {
    "mode": "shadow",                    // off | shadow — v1 has no acting mode
    "model": "jev-1.13.0",               // pinned
    "baseUrl": "https://jevtypesafeai.com/api",
    "apiKeyEnv": "JEV_API_KEY",
    "confidence": 0.6,                   // below → escalate / mark lowConfidence
    "fallback": "llm-judge",             // connector name; omit for none
    "timeoutMs": 3000,
    "maxDecisionsPerRun": 50,            // cost bound per command invocation
    "llm": { "baseUrl": "…", "model": "…", "apiKeyEnv": "…" }
  }
}
```

`connectors.judge: "jev"` picks the primary when several register —
same seam as `connectors.reviews`.

## Filetree

```text
packages/core/src/judge.ts            JudgeFacade contract, Verdict, JudgeUnavailable
packages/core/src/connectors.ts       FacadeMap.judge + Connector.judge?
packages/judge/src/jev.ts             jev connector — /v1/decide client + error mapping
packages/judge/src/llm-judge.ts       llm-judge connector — OpenAI-compat → typed answers
packages/judge/src/chain.ts           primary→fallback decide(), low-confidence merge
packages/judge/src/journal.ts         verdicts.jsonl append + read (common git dir)
packages/judge/src/shadow.ts          act/drive annotation wiring (read-only consumers)
packages/judge/src/stats.ts           agreement, calibration, latency/cost over journal
packages/judge/src/replay.ts          archived-thread reconstruction for dogfood
packages/cli/src/commands/judge.ts    bro judge decide|stats|replay
packages/cli/src/commands/act.ts      threads rendering gains annotation lines
skills/judge/SKILL.md                 policy only — mechanics live in the CLI
```

## Milestones

1. `bro-f4ot.2.1` this spec.
2. `bro-f4ot.2.2` connector — `JudgeFacade` + jev `/v1/decide` client,
   llm-judge fallback on low confidence, `bro judge decide` smoke path.
3. `bro-f4ot.2.3` shadow — verdict journal + act/drive thread
   annotation; nothing applied, gate unchanged.
4. `bro-f4ot.2.4` `bro judge stats` — agreement matrix, calibration
   buckets, latency/cost report over the journal.
5. `bro-f4ot.2.5` dogfood — `bro judge replay` over archived review
   threads; publish the accuracy report on the bead; flip-or-shelve
   verdict against the thresholds above.

## Risks named up front

- **The judge creeps toward the gate.** Every consumer it annotates is
  one prompt edit away from "just apply the high-confidence verdicts."
  Shadow is a boundary, not a mood: the exit gate stays deterministic,
  application needs the dogfood report *and* a follow-up spec.
- **Cost as a rate, not a price.** $0.001/decision × every thread ×
  every poll = real money at convoy scale. `maxDecisionsPerRun` bounds
  a run; verdicts dedup on (threadId, commentSha) so a re-poll re-reads
  the journal before re-paying.
- **Confidence that lies.** llm-judge self-reporting confidence is
  calibration theatre until proven — the stats buckets are the only
  evidence accepted, per-decider.
- **Secret handling.** `jv_live_` keys ride env vars only —
  `apiKeyEnv` names the variable, config never holds the value; same
  rule as every credential this repo touches.
- **Archived-thread reconstruction is lossy.** A replayed thread lacks
  the push-time diff context its original triage had — the dogfood
  report must state the reconstruction's limits so ≥85% agreement means
  what it claims.
