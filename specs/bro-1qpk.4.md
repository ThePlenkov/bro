---
parent: project
---

# bro-1qpk.4 — DEEP opencode integration: full plugin surface, v2-targeted

## Problem

`packages/cli/src/opencode.ts` speaks the V1 plugin API only: a default
export `{id, server}` whose `server()` returns a hooks object. OpenCode
v2's loader decodes `{id, setup|effect}` and rejects V1 implementations
outright — the module loads nowhere on v2. Beyond loading, the V1 hook
set is shallow: no pre-execution guard (V1 `permission.ask` can only
approve, never deny), no model-callable tools, no commands, no TUI
surface, no shell env. bro's full contract — the blocking guard, fleet
UX, read planes as tools, agent-shell provenance — does not exist inside
opencode.

## Design

One module keeps serving both majors: the default export gains a V2
`setup(ctx)` beside the existing V1 `server()` — the documented dual
entrypoint (`V1 calls server()`, `V2 reads id + setup()`, ignoring the
other side). `Plugin.define` is not imported: the materialized module is
standalone (node builtins only, verbatim copy to `plugins/opencode/bro/`),
so the `{id, setup}` shape is declared structurally, same discipline the
V1 hooks already use. The bro-side contract is unchanged — every surface
still funnels through `bro hooks <event>` / read-verb spawns; no policy
moves into the plugin.

### Capability → opencode v2 surface mapping

| v2 surface (`ctx`) | bro event / read | Contract |
| ------------------ | ---------------- | -------- |
| `session.hook("context")` | `hooks session-start` / `post-compaction` | Hydration pushed onto `event.system` per model request (cached per session, primed on `session.created`) |
| `session.hook("compaction")` | `hooks pre-compact` | bro context appended into `event.system`; summary left to opencode |
| `session.hook("prompt")` | `hooks prompt-submit` | additionalContext appended to `event.prompt.text` |
| `tool.hook("execute.after")` | `hooks post-tool` | nudge appended to `event.result` content |
| `tool.hook("execute.before")` | `hooks pre-tool` (new) | `{decision:"block",reason}` → throw; `args` override mutates `event.input` |
| `permission.hook("evaluate")` | `hooks permission` | `approve` → `effect="allow"`; `block`/`deny` → `effect="deny"` + `message` — the deny V1 could never send |
| `event.subscribe()` | event bus | `session.created/compacted/deleted/idle`, `message.updated` — same switches as V1 `event()` |
| `session.idle` + `session.prompt`/`synthetic` | `hooks stop` | One-shot re-prompt gate, same clean-turn predicate as V1 |
| `shell.hook("create.before")` | — | `BRO_SESSION_ID`/`BRO_AGENT_ID` provenance into `event.env` |
| `tool.transform` | `bro status/act/convoy/debt/fleet` reads | bro read-verbs as namespaced model tools (JSON Schema) |
| `command.transform` | `bro <args>` | `/bro-*` commands prompting the session with CLI output |
| `mcp.transform` | `bro serve` | mount the facade plane as a remote MCP server |
| `storage` | — | gated/live session sets survive a plugin reload |

### The TUI module

Terminal UI is a second entrypoint on `@opencode/plugin/tui`, not the
server ctx: `packages/cli/src/opencode-tui.ts` →
`plugins/opencode/bro/cli.ts`. `keymap.layer` carries `/bro` palette +
slash commands, `data.on`/`data.listen` surfaces gate events as
`ui.toast.show`, and `bro status --json` feeds a status read. It shares
the CLI-resolution ladder (extracted per module — standalone artifact
rule) and the same fail-open contract.

### V1 → V2 migration notes

- Hook shapes are re-declared, not ported 1:1 — V2 payload names differ
  (`PermissionRequest`/`reply` vs `Permission`/`status`; `effect` on
  evaluate; `event.result` on tool.execute.after). Tests pin the V2
  shapes we depend on.
- `permission.ask` (V1) ran before the prompt and could only approve;
  `permission.hook("evaluate")` (V2) runs after configured rules and may
  deny. The `permission` event's contract widens to `decision:
  approve|deny` — `deny` is new emit surface in `hooks.ts`.
- `chat.message`/`system.transform` become `session.hook("prompt")`/
  `("context")` — hydration rides the model-request hook, which fires
  for continuations too, so the per-session cache is load-bearing.
- Install targets unchanged: V2 discovers `.opencode/plugins/` AND
  `.opencode/plugin/`, global stays `~/.config/opencode/plugins/`.
  `opencode.json`'s `plugin` → `plugins` rename is the user's migration,
  not ours — `bro plugins install` writes files, not config.
- The `isBroAdapter` sentinel already matches `{id:"bro",server:…}`;
  `setup` joins the marker set so a V2-only file is still recognized.

## Plan

- [ ] bro-1qpk.4.1 — V2 `setup(ctx)` port: dual-export module, all
      existing mappings re-wired onto session/tool/permission/event
      surfaces, README drops the V1-only caveat
- [ ] bro-1qpk.4.2 — deep hooks: `pre-tool` guard event (mutate/throw),
      permission `deny`, `shell create.before` env provenance,
      `ctx.storage`-backed gate state
- [ ] bro-1qpk.4.3 — tool/command/MCP transforms: bro read-verbs as
      model tools, `/bro-*` commands, `bro serve` as MCP
- [ ] bro-1qpk.4.4 — TUI module `opencode-tui.ts`: `/bro` keymap layer,
      gate toasts, status read; gen-plugins + install targets
