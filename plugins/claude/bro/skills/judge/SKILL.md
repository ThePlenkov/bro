---
name: judge
description: "Use when judging calibrated decisions for agent loops — act triage annotation, fallback escalation. Thin wrapper over the bro CLI: `bro judge decide` smokes the connector; the jev → llm-judge chain lives in packages/judge. Requires `bro` (npx -y @broject/bro@0); the default jev backend needs a TypeSafe API key, llm-judge needs its own `judge.llm` config."
---

# /judge (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

A calibrated decision judge for agent loops — typed questions
(`choice`/`score`/`noul`) over a compact state, typed answers with
confidence back, sub-second, priced in fractions of a cent. The primary
backend is **jev** — TypeSafe's System One API (`POST
{judge.baseUrl}/v1/systemone`, `Authorization: Bearer
$<judge.apiKeyEnv>` — the var named by `judge.apiKeyEnv`,
`TYPESAFE_API_KEY` by default; `TYPESAFE_BASE_URL` overrides the base);
`judge.fallback` names an escalation connector (**llm-judge** — any
OpenAI-compatible chat endpoint) re-asked on unanswered questions and
answers under `judge.confidence`.

| Command | What it does |
| ------- | ------------ |
| `bro judge decide --state <file\|-> --questions <file>` | One decide() over the resolved chain — prints answers, decidedBy, model, latency, usage. `--connector <name>` pins the primary, `--json` prints the raw DecideResult |

Config (`bro.config.json` `judge` section): `mode` (off|shadow — v1
has no acting mode), `model` (pin in production), `baseUrl`,
`apiKeyEnv` (env var NAME, never the value), `confidence` (0.6),
`fallback`, `timeoutMs` (bounds the whole chained call), `llm`
({baseUrl, model, apiKeyEnv}).

## Policy

- **Shadow is a boundary, not a mood.** The verdict journal and
  act/drive annotation land in bro-f4ot.2.3+ — when they do, verdicts
  will annotate, never act: thread resolution, the exit gate, and fixer
  spawns stay deterministic, and the judge earns advisory weight by
  measured dogfood agreement, not enthusiasm. (This milestone ships
  the connector + `bro judge decide` smoke path only — don't promise
  journaling, stats, or replay to users yet.)
- **Fail-open, always.** A wedged backend throws `JudgeUnavailable` —
  consumers treat "no verdict" as "no annotation", never a gate input.
- **One call, many questions.** Batch a subject's questions into one
  `decide()` — a question-per-call loop is a cost bug.
- **`decidedBy` is honest.** Escalated answers say `llm-judge`; stats
  (a later milestone) score each backend on its own record.
- **Keys ride env vars only.** `apiKeyEnv` names the variable; config
  never holds a key value.
