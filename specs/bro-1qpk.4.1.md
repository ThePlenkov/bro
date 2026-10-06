---
parent: bro-1qpk.4
---

# bro-1qpk.4.1 — opencode v2 `setup(ctx)` port (dual-export module)

## Problem

The adapter loads on V1 only. V2 decodes `{id, setup|effect}` and skips
`server()`-only modules — bro is absent on opencode v2.

## Design

`export default { id: 'bro', server: BroPlugin, setup: BroSetup }` in
`packages/cli/src/opencode.ts` — the documented dual entrypoint. V2
shapes are declared structurally (standalone module, no
`@opencode/plugin` import); the bro-side contract stays `bro hooks
<event>` + control JSON, async + fail-open everywhere.

### Hook port

| v2 surface | bro event | Notes |
| ---------- | --------- | ----- |
| `ctx.session.hook("context")` | `session-start`/`post-compaction` | cached hydration → `event.system.push({type:'text',text})` |
| `ctx.session.hook("compaction")` | `pre-compact` | context → `event.system.push` |
| `ctx.session.hook("prompt")` | `prompt-submit` | context appended to `event.prompt.text` |
| `ctx.tool.hook("execute.after")` | `post-tool` | `event.status` success → nudge appended to `event.result` |
| `ctx.permission.hook("evaluate")` | `permission` | `approve` → `event.effect='allow'` |
| `ctx.event.subscribe({signal})` | bus | `session.created/compacted/deleted/idle`, `message.updated` |
| `ctx.session.prompt`/`synthetic` | `stop` re-prompt | replaces V1 `client.session.promptAsync` |

Stop-gate state (`gated`, `clean`, `live`, rehydration cache) is
per-module state, shared by both `server()` and `setup()` closures —
same file, same semantics, V2 keeps the clean-turn predicate and the
one-shot re-prompt.

### Acceptance

- `plugin.id === 'bro'`, `typeof plugin.server === 'function'`,
  `typeof plugin.setup === 'function'`
- V2 setup wires every row in the table; each degrades to no-op when
  the bro command resolves null (fail-open)
- `npm test` green; `plugins/opencode/bro/bro.ts` regenerated
- README states V1+V2 support (drops the bro-ot80 caveat)
