---
parent: bro-1qpk.4
---

# bro-1qpk.4.2 — deep hooks: pre-tool guard, permission deny, shell env

## Problem

V1 wired only `tool.execute.after` (post-mortem) and `permission.ask`
(approve-only). V2 adds the two surfaces bro's guard plane wants:
`ctx.tool.hook("execute.before")` — mutate input or THROW to block — and
`ctx.permission.hook("evaluate")` — `effect: deny` with a message. Shell
provenance (`BRO_SESSION_ID`, `BRO_AGENT_ID`) has no carrier either.

## Design

### `pre-tool` hook event (new, `bro hooks pre-tool`)

New dispatch case in `commands/hooks.ts`: payload `{session_id,
tool_name, tool_input}`. Emits the same control JSON:

- `{decision:"block", reason}` — the adapter throws `reason` into
  opencode → the tool call never runs (the guard V1 couldn't express)
- `{tool_input}` in hookSpecificOutput args override — adapter merges
  onto `event.input` (arg mutation)
- context output — prepended on `execute.after` when the tool later
  completes? No: pre-tool context is dropped (the model can't act on
  context attached to a call that hasn't happened); mutation + block
  only.

Default emit for a repo without a guard configured is silence →
no-op; the hook is opt-in like every other.

### Permission deny

`hooks permission` control widens: `decision: deny` (new emit; the
adapter maps it to `event.effect='deny'` + `event.message=reason`).
V1 `permission.ask` keeps translating only `approve` — `deny` under V1
would mask the ask entirely, so it stays unmapped there.

### Shell env

`ctx.shell.hook("create.before")`: sets `BRO_SESSION_ID` (from the
creating session when the event carries one) and `BRO_AGENT_ID=opencode`
on `event.env`. Static provenance — no probe, no new bro event.

### Acceptance

- `pre-tool` in the dispatch switch + `block` → adapter throw, args
  override → `event.input` merge
- `permission` `decision:'deny'` → `effect='deny'` + message (V2 only)
- `create.before` sets both env vars without clobbering existing values
- tests pin the throw and the deny path
