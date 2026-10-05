---
parent: bro-1qpk.3
---

# bro-1qpk.3.2 — pi extension skeleton: widget board + /bro + hooks mapping

## Problem

The pi adapter (spec bro-1qpk.3) needs the extension module itself:
a single jiti-loadable .ts file that maps pi's lifecycle events onto
`bro hooks <event>`, paints the board widget, and exposes `/bro` +
the `bro_status` tool — without holding bro policy in the adapter.

## Design

`packages/cli/src/pi.ts` — self-contained (node builtins only;
the standalone copy can hold no relative import), generated verbatim
to `plugins/pi/bro/bro.ts` by `npm run gen:plugins`. Structural pi
API types are declared locally, never imported — same convention as
opencode.ts.

- **hooks** — the event map from the parent spec; each event is one
  async `bro hooks <event>` spawn with the payload on stdin; the
  control object on stdout is translated into pi result slots
  (custom_message entries, `{continue:true}` for the stop gate,
  content append for post-tool).
- **board** — `bro status --json` → `ctx.ui.setWidget('bro', …,
  {placement:'aboveEditor'})` + `setStatus('bro', …)` crumb;
  refreshed on session_start, turn_end, agent_settled.
- **`/bro`** — bare repaints; `/bro <args>` runs the CLI and drops
  stdout into the transcript as a visible custom message.
- **`bro_status` tool** — the board JSON, model-callable.
- **ctx-stale hazard** — pi invalidates ctx on replace/reload;
  handlers snapshot cwd/sessionId synchronously, every `ctx.ui`
  touch is try/wrapped, a stale ctx degrades to "no paint".
- **fail-open** — `broEnabled()` gates on bro.config.json/.beads
  before any spawn; every failure mode resolves null.

## Plan

- [x] lifecycle wiring: session_start / session_before_compact /
      session_compact / input / before_agent_start / tool_result /
      agent_before_settle / turn_end / agent_settled /
      session_shutdown
- [x] board widget + status crumb from `bro status --json`
- [x] `/bro` command + `bro_status` tool
- [x] `adapter = {id:"bro",kind:"pi-extension"}` sentinel
- [x] gen-plugins `plugins/pi/bro/` adapter (bro.ts + README)
