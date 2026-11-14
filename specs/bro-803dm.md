# bro-803dm — dead-loop detection gate in `bro hooks`

## Problem

Every agent can wedge the same way: re-issue the identical tool call
forever — same command, same edit, same failing probe — and every call
"succeeds" while nothing progresses. The turn burns budget silently
until someone notices. Some hosts detect this natively; many do not,
and bro cannot rely on the host's mercy: the plugin contract already
routes every host's tool events through `bro hooks`, so the hook plane
is the one place the guarantee can live for ALL agents uniformly.

The serve lanes already refuse dead loops at the LLM-proxy plane
(`bro-b961a` — session/prompt attempt counters, circuit breakers).
That plane sees conversations, not tool calls. This spec covers the
missing plane: **the agent's own tool-call stream**, observed by
`post-tool`/`pre-tool` hooks.

## Contract

Two stages, gates-not-loops like the rest of the hook plane:

1. **Detection (post-tool).** `journalTrace` already appends
   `{ts, tool, command?, paths?, ok}` per event to
   `trace/<session>.jsonl`. After the append, `deadLoopPostTool`
   scans the trailing run: `DEAD_LOOP_REPEAT` (4) consecutive
   identical signatures at the tail arms the gate. The signature is
   `tool|detail` — `command` whitespace-collapsed for exec-family,
   sorted `paths` for edit/write, stable `tool_input` stringify for
   the rest (400-char cap). On arming it writes
   `trace/<session>.deadloop.json` `{signature, count, ts}` and adds
   one advisory `additionalContext` line naming the repeat count —
   once per detection cycle, not every call.

   The live payload must match the journaled signature — repeats
   written by something else are not this session's loop.

2. **Veto (pre-tool).** `deadLoopPreTool` runs before connector
   verdicts: a fresh marker (TTL `DEAD_LOOP_TTL_MS` = 15min) whose
   signature equals the incoming call's emits the host's block shape
   (`decision:block`, codex `permissionDecision:deny`) with a reason
   naming the count and telling the agent to change approach. Any
   other signature passes untouched — the gate closes on the loop
   itself, never on the session.

## Invariants

- **Signature-scoped** — only the exact repeated call is vetoed;
  different tools/args/sessions are unaffected (e2e-pinned).
- **TTL'd** — `DEAD_LOOP_TTL_MS`; an agent that changed approach and
  returns later gets a fresh detection cycle, not a permanent ban.
- **Observe-mode passive** — detection/veto live in the active
  pipeline only; observe sessions still journal (telemetry) but never
  arm or veto.
- **Fail-open** — torn journal, missing marker dir, unreadable state:
  no opinion, hook exits 0. A wedged `git rev-parse` costs the
  detection, never the session.
- **No probe spend on veto** — the pre-tool check is pure file IO
  before `preToolVerdicts`, so a looped call is refused without
  paying connector probes.
- **Marker placement** — `trace/<session>.deadloop.json` lives inside
  the `trace/` subdir, so `readArmed`'s `<session>.*` aspect scan
  never sees it (same rule as the `.jsonl` journals).

## Native correlation

Hosts with their own loop detection operate at the model/prompt
layer; this gate is deterministic signature-matching at the tool-call
layer — complementary, never shadowing. No per-host opt-out: the
veto only fires on exact repeats, which no healthy flow produces.

## Scenarios

- **S11 dead-loop gate** (AGT-1 catalog): N≥4 identical post-tool
  signatures → warning context + marker; next identical pre-tool →
  block; different signature/session → pass; observe → silent.
  Verified: `deadloop.test.ts` (6 unit) + `hooks.e2e.test.ts`
  dead-loop describe (3 real-CLI legs).

## Changelog

- 2026-11-14 — v1: gate shipped — `commands/deadloop.ts` leaf module,
  post-tool detect + pre-tool veto wired into `emitPostTool`/
  `emitPreTool`, observe-mode gating, codex deny shape. Unit + e2e
  coverage; AGT-1 S11.
