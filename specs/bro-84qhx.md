# bro-84qhx — sessionMode: agent-native permission mode for ACP sessions

## Problem

ACP agents ask `session/request_permission` per tool call. Headless
surfaces deny by design — a judge call has no user to ask. An
interactive conductor-hosted session stalls identically: every request
is auto-denied, so the spawned agent cannot exec anything. `autoApprove`
answers each request with the allow option — per-request, and only on
the worker argv. Nothing lets the operator pin the agent's own session
mode — the posture that stops the request from firing at all — from
config.

## Design

`providers.<name>.sessionMode` (string) on `type: acp` entries. `acpOp`
applies it right after the model pin, on whichever surface the agent
advertises in `session/new`:

- `modes` present → `session/set_mode` with the configured modeId —
  the dedicated method `devin acp` serves (its trace log shows the
  `set_session_mode` span). A mode absent from `availableModes` is a
  config error naming what IS advertised.
- else a `category: 'mode'` configOption → `session/set_config_option`
  (the newer selector surface — by category, never a hardcoded
  configId).
- neither surface advertised → `AcpConfigError` — refusing to run an
  unpinned session.

- Unset → the agent's default mode stands; nothing is sent.
- A peer refusal of `set_mode`/`set_config_option` → `AcpConfigError`;
  a cancel or dropped transport → availability (rides the
  `JudgeUnavailable` mapping).
- The agent reporting a different current value than asked → config
  error — a silently unpinned session would run with permissions the
  operator never granted.

`applySessionMode` is exported so the pooled/conductor session path
(`acpOpen` in the serve branch) reuses the same entry field and wire
shape instead of copying it.

The layer split stays as specced in bro-5hx1.1 / bro-xh5jg:
`autoApprove` answers each `session/request_permission` (headless
worker argv); `sessionMode` sets the session posture (conductor-hosted
interactive sessions). The judge's default-deny handler is unchanged —
a `sessionMode` pin is an explicit operator opt-in on the provider
entry, and the deny handler still stands if the agent asks anyway.

## Plan

- [x] `packages/core/src/providers.ts` — `sessionMode?: string` on the
      acp entry + registry `optional`
- [x] `packages/providers/src/acp.ts` — `applySessionMode` (exported),
      called in `acpOp` between the model pin and the prompt
- [x] `packages/providers/src/testkit.ts` — fake agent learns `modes`
      advertisement + `session/set_mode` recording
- [x] `packages/providers/src/acp.test.ts` — mode rides `set_mode`
      when advertised, else `set_config_option`; unset = untouched;
      unadvertised/unknown mode = config error, no prompt sent

## Acceptance

- `providers.<name>.sessionMode: 'bypass'` produces `session/set_mode
  {modeId: 'bypass'}` (or the `category: 'mode'` configOption set)
  before the first prompt — verified by the testkit fake; a conductor
  session on that entry never emits `session/request_permission` for
  allowed tool calls.
- A mode the agent doesn't advertise fails fast as a config error,
  never a silent unpinned session.
- Judge default-deny behavior is unchanged when `sessionMode` is unset.
