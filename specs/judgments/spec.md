---
parent: project
scope:
  - packages/core/src/judge.ts
  - packages/core/src/providers.ts
  - packages/judge/
  - packages/providers/
  - packages/cli/src/commands/judge.ts
  - skills/judge/
  - skills/typesafe-ai/
---

# judgments — calibrated typed decisions as infrastructure

The cross-cutting layer that gives every bro facade a sub-second,
calibrated, cheap judgment primitive: **state + typed questions →
typed answers + confidence**, journaled and provably measured.

Capability spec — owns the *layer contract*; leaf specs own
implementations (`specs/sessions/bro-f4ot.2-judge.md` judge facade,
`specs/bro-ribc.1.md` provider facade, `specs/bro-9rls.1.md` planes).

## Why a judgment layer exists

Agent systems make hundreds of small decisions — *does this thread
block? is this step done? which failure class is this exit? should
this tool call run?* Today each is paid for in frontier-LLM tokens,
is uncalibrated (nobody knows how often it was right), and is too slow
to live inside hot paths (per-tool-call, per-session-start,
per-review-thread).

A decision model inverts the economics: ~0.5s, ~400 tokens, fractions
of a cent, calibrated probabilities. That puts semantic judgment
*inside* paths where an LLM call was unthinkable and a regex was
wrong. Verified live: real typed verdicts from
`typesafe/jev-1.13-20260917` at 493ms / 370 input tokens.

## The primitive

```text
{state, questions:{<id>: {type, instructions, criteria}}}
        → POST {baseUrl}/v1/systemone (or equivalent transport)
        → {answers:{<id>: {type, value, probabilities, confidence}},
           model, usage}
```

Three question types: `noul` (P(yes)), `choice` (pick + distribution
over a criteria map), `score` (weighted position on ordered levels).
Answers carry `confidence` — the second axis: **what** to do vs
**whether to trust the answer**. Code owns the workflow; the model
supplies narrow judgments. See `skills/typesafe-ai/` for question
design (one narrow coherent judgment per question; ask independent
questions together — one call, parallel answers).

## Layer map

```text
consumers (own question sets + thresholds, never the transport)
  act threads · drive fixer · guard (tool_call) · stop-gate
  fleet taxonomy · learn relevance · bead triage/dedup · judge CLI
        ↓ judgeFacade(dir).decide(state, questions)
judge facade (packages/judge)
  chain: primary → fallback escalation on low confidence
  journal: <git-common>/bro/judge/verdicts.jsonl (append-only,
           shared across linked worktrees)
  proseDecide: prompt-and-parse for prose-grade providers,
               answers stamped :prose — never the calibrated bucket
        ↓ named provider from the user-owned registry
provider registry (packages/core/providers.ts + packages/providers/)
  systemone    → typed, no spawn   (native wire contract)
  acp          → auto: typed on systemone-family models, prose else
  openai-compat→ prose (chat completions shape)
  cli          → prose (process execution)
```

Rules that keep the layer honest:

- **Consumers never name transports.** They name a provider from the
  user's registry (`judge.provider`, `agents.*.provider`); the registry
  resolves kind → wire client. Model pins live in config, never in
  connector names (`systemone` is the protocol; `jev-*` is a model).
- **Provenance is mechanical.** Every answer is stamped `decidedBy`
  (`provider:<name>`, `:prose` flag for uncalibrated paths) and the
  DecideResult carries the served model id.
- **Fail-open, never gate.** `JudgeUnavailable` (transport, auth,
  drift, deadline) is annotation loss, never a gate input; config
  bugs are plain errors naming the FIELD, never the secret value.
- **`isSystemoneFamily` is version-anchored** — `jev-<version|latest>`
  ids only, so a router product (`*-router` ids routing to arbitrary
  upstreams) can never bind the typed surface.

## Consumer map — where judgments land

| Consumer | Verdict | Status |
| -------- | ------- | ------ |
| `bro act threads`, drive fixer | per-thread severity/blocking annotation | **live, shadow** |
| guard (`bro-nkn6`) | `allow\|deny\|ask` per tool_call + injection screen | spec'd |
| stop-gate | `done?` noul over diff+tests at Stop | roadmap |
| fleet (7xgk) | exit taxonomy: `rate_limited\|crash\|task_fail\|infra` | roadmap |
| session-start | intent route + learn-lesson relevance filter | roadmap |
| bead ops | dedup noul, epic choice on create | roadmap |
| `bro judge decide` | smoke surface for the whole chain | **live** |

Each consumer owns its question wording and its thresholds — the
facade never decides policy, only fidelity and provenance.

## The trust ladder — how a judgment earns the right to act

```text
off → shadow → (stats + replay prove it) → advisory → enforce
```

- **shadow** (v1's only acting-adjacent mode): verdicts annotate and
  journal; `act threads`/`drive` render a `judge:` line per subject.
  Nothing acts on them.
- **`bro judge replay`** re-judges archived threads from merged PRs
  where the outcome is recoverable from the record → labeled
  train/test data without human tagging. Idempotent per subject.
- **`bro judge stats`** scores the journal: agreement matrix,
  per-decider accuracy, calibration buckets, p50/p95 latency, mean
  cost per provider+model. Dogfood bar: ≥85% agreement, p50<1s,
  mean <$0.01/call.
- **advisory/enforce** are future modes, enabled per-consumer —
  a consumer flips to acting only for the question shapes its stats
  proved, never wholesale.

## Secrets and wire safety

- `apiKeyEnv` names an env var (SCREAMING_SNAKE validated — a pasted
  value drops the entry); `apiKeyCommand` runs a secret-store lookup
  (`secret-tool`, `pass`, `op`, `keyctl`) and wins over env — the key
  lives in the OS keyring, never in env, config, logs, or
  `/proc/*/environ`. `sk-*`/`Bearer` literals inside the command drop
  the entry; the lookup shares the call's deadline and execs without
  a shell.
- ACP commands and key commands tokenize via `splitShellWords` and
  exec directly — config text can never re-parse into a program.
- Typed answers are validated against the asked questions:
  off-criteria choices, wrong answer types, out-of-range values, and
  prototype-polluting qids are contract drift → fail-open.
- `systemone` baseUrl is operator-owned — the same wire contract can
  front any System One-speaking endpoint (direct api.typesafe.ai or
  a gateway passthrough like orcarouter's `/v1/systemone`).

## Design invariants

1. The question set belongs to the consumer; the typed contract
   belongs to the layer; the model choice belongs to the operator.
2. A verdict is evidence, not authority — until stats promote it.
3. Latency is the feature: a judgment that can't answer inside its
   deadline must lose to no judgment at all (fail-open).
4. Calibration is the product: prose paths are marked `:prose` and
   never counted against the typed agreement set.

## Leaf specs

- `specs/sessions/bro-f4ot.2-judge.md` — judge facade, chain,
  journal, shadow semantics, replay/stats
- `specs/bro-ribc.1.md` — provider facade: registry, kinds, surfaces
- `specs/bro-9rls.1.md` — planes: facade projections to transports
  (judge plane included)
- `specs/bro-nkn6*.md` — guard facade consumer
- `specs/bro-7xgk.*` — fleet budget/failure taxonomy consumer
