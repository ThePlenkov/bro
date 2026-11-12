---
template: brotocol/spec@2
id: AGT-8
title: omp — extension surface, the only native stop block, mode bridges
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/omp/
  - packages/agent-plugins/omp/
aliases:
  - omp
---

# AGT-8 — omp: extension surface, the only native stop block, mode bridges

## Problem

omp is pi's successor and the host where bro's contract reaches its
fullest expression short of opencode: it is the **only host with a
native `decision:block` stop slot** (`session_stop` re-fires with
`stop_hook_active: true`, mapped straight into bro's one-shot rule),
a real pre-tool guard, a TUI board, and — uniquely — **mode bridges**:
omp's native Plan/Goal/Vibe/Prewalk/Advisor modes keep their own
semantics while bro supplies the durable state they cannot have.
The spec pins the extension contract and the bridge mapping — the
bridge is the contract's first "host-native features bro rides
instead of replacing" case.

## Design

### Surface: `extension`, async, generated bundle + companion files

`plugins/omp/bro/` ships `bro.ts` (generated from
`packages/agent-plugins/omp/src/omp.ts` via adapter-core +
bundle-adapter), `modes.ts` (the bridge mapping),
`hooks/pre/permission.ts` (the pre-tool guard as its own extension
file — the matrix's `via:` cell), `package.json`, `WATCHDOG.md`
(bro's review priorities for omp's Advisor mode). Install:
`omp plugin install ./plugins/omp/bro` (full plugin package) or
`bro plugins install omp` (loose extension file into
`~/.omp/agent/extensions/` or `.omp/extensions/`).

### Event mapping (HOOK_MATRIX `omp` row)

| bro event | omp native | effects |
| --------- | ---------- | ------- |
| session-start | `session_start` | context, notify |
| pre-compact | `session_before_compact` | context |
| post-compaction | `session_compact` | context |
| prompt-submit | `before_agent_start` | context |
| post-tool | `tool_result` | context, observe — outcome `synthesized` |
| stop | `session_stop` | **block**, context — `stopRefusal: 'block'` |
| pre-tool | `tool_call` (via `hooks/pre/permission.ts`) | block |
| permission | — | **deliberate**: unimplemented — the guard hook covers force-push only, never the host's approval plane |

`nativeOnly`: `turn_end`, `session_shutdown`, `plan_review_requested`,
`goal_updated`, `before_subagent_spawn`.

### The mode bridges (contract's native-leverage case study)

omp already has modes that overlap bro's concepts by name. The
bridge rule — **bro supplies state, omp keeps semantics** — is the
general pattern for "host has a native feature bro also does":

| omp mode | what bro adds (never reimplements) |
| -------- | ---------------------------------- |
| Plan | the bead and spec the plan must answer, plus claims in flight |
| Goal | the bead the objective belongs to, and the judge that says "met" |
| Vibe | the claims — who owns which bead, so two workers never edit one |
| Prewalk | the provider routing that says which model is fast *here* |
| Advisor | `WATCHDOG.md` — bro's review priorities + the debt ledger |

`modes.ts` is the machine form; this table is its spec rendering.
A future host with native planning/goals modes inherits the same
rule: bro plugs state into the host's mode, never shadows it.

### The native stop block

`session_stop` accepts `{decision:"block", reason}` and re-fires
with `stop_hook_active: true` — bro's block maps straight on and
the flag maps straight back, so the one-shot rule is enforced by the
host itself. omp and the manifest hosts (Claude/Codex/Devin) are the
three `stopRefusal: 'block'` cells; everyone else reprompts or
notifies. The matrix records which — enforcement parity is never
claimed where the host cannot enforce.

### Native functions leveraged

- **TUI board** — `ctx.ui.setWidget`/`setStatus` on session start,
  turn end, post-gate refresh (same driver path as pi).
- **`/bro` command + `bro_status` tool** — identical contract to
  pi's; the shared driver emits the same shapes.
- **Pre-tool guard as separate file** — `tool_call` can only block;
  bro wires it *only* for the force-push veto (a safety surface,
  not the input-override lane pi refuses to fake). `via:` in the
  matrix names the module.
- **WATCHDOG.md** — Advisor mode reads bro's review priorities as a
  host-native doc part.

## Requirements

- **R1** — `session_stop` block + `stop_hook_active` round-trip
  stays exact — the only true enforcement cell in the extension
  world; regressing it to reprompt silently downgrades the contract.
- **R2** — Mode bridges stay additive: bro never registers a
  competing Plan/Goal/Vibe — `modes.ts` maps state into omp's
  modes, full stop.
- **R3** — `tool_call` stays block-only-for-force-push; no
  input-override pretense (same honesty rule as pi's unwired cell,
  different resolution: wire the one thing the slot can honestly do).
- **R4** — `permission` stays unimplemented — the host's approval
  plane is the user's; the guard covers repo safety only.
- **R5** — `plugins/omp/bro/` generated artifacts stay generated;
  `check:plugins` clean.

## Verify

- `host-matrix.test.ts` omp row green — the only extension row with
  `stopRefusal: 'block'` and a `via:` pre-tool cell.
- Adapter unit tests (`packages/agent-plugins/omp/src/*.test.ts`)
  + `check:plugins`.
- Live: omp session shows board widget, native `session_stop` block
  fires once on an armed claim (verifiable in omp's own UI — a real
  block, not a reprompt), `/bro` and `bro_status` work, mode bridges
  inject claims/specs into Plan/Goal sessions.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: extension surface, native
  stop block, mode bridges as the native-leverage pattern, guard-only
  pre-tool.
