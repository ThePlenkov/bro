---
parent: project
---

# bro-1qpk.3 — pi extension adapter: bro lifecycle + board on pi's extension API

## Problem

pi (earendil-works/pi-coding-agent) loads in-process TypeScript
extensions via jiti — no shell-hook manifest like Claude/Devin, no
hook-bus plugin object like opencode. Without an adapter, bro's
session mechanics (rehydration, prompt-submit nudges, post-tool
arming, the stop gate) and the live board don't exist inside a pi
session; a thin client shelling out per event is the only
alternative, which is N spawns per tick.

## Design

One self-contained module `packages/cli/src/pi.ts` (node builtins
only — pi loads the raw .ts, no build step) materialized verbatim to
`plugins/pi/bro/bro.ts` by gen-plugins, exactly like the opencode
adapter. No bro policy lives in the extension: every lifecycle event
is one `bro hooks <event>` call with the payload on stdin, and the
control object on stdout is translated into pi's own result slots.

### Capability → pi surface mapping

| pi surface | bro event / read | Contract |
| ---------- | ---------------- | -------- |
| `session_start` | `hooks session-start` | Prime hydration + paint board |
| `session_before_compact` | `hooks pre-compact` | Carry context into the post-compaction inject |
| `session_compact` | `hooks post-compaction` | Re-prime hydration, refresh board |
| `input` | `hooks prompt-submit` | Nudge rides the next before_agent_start inject |
| `before_agent_start` | — | Inject cached hydration once, hidden `custom_message` (display:false) |
| `tool_result` | `hooks post-tool` | Arming + nudges; nudge appended to content |
| `agent_before_settle` | `hooks stop` | Real gate: block → continue + blocker as a visible entry, once per session |
| `turn_end` / `agent_settled` | `bro status --json` | Board refresh triggers |
| `session_shutdown` | — | Clear widget/status |
| `pi.registerCommand('bro')` | `bro <args>` passthrough | Bare = repaint; args = run CLI, output → transcript |
| `pi.registerTool('bro_status')` | `bro status --json` | Board JSON as a model-callable read |

`tool_call` is deliberately unwired: it can only block, and bro's
`permission` plane answers approve/ask — neither maps to a block.
The guard plane slots in here when it lands.

### The board

`bro status --json` (child .3.1) is the single aggregated read —
beads in-progress, ready count, fleet agents, drill frame, branch /
dirty — rendered via `ctx.ui.setWidget` (lines above the editor) +
`ctx.ui.setStatus` (footer crumb). One spawn per refresh, never N.

### CLI resolution + failure contract

Sibling dist → checkout walk-up → `bro` on PATH passing the
`bro hooks` probe → `npx -y --prefer-offline @broject/bro@<ver>` —
the same ladder as opencode.ts (duplicated deliberately: the
materialized module is standalone and can hold no relative import).
Fail-open everywhere: a missing CLI, a non-bro directory, a spawn
error, or a timeout yields no widget / no context — never a throw
into pi. pi invalidates ctx on session replace/reload, so handlers
snapshot cwd/sessionId synchronously and every `ctx.ui` touch is
wrapped.

### Install paths

- Global: `$PI_CODING_AGENT_DIR/extensions/bro.ts` (default
  `~/.pi/agent/extensions/`)
- Local: `<repo>/.pi/extensions/bro.ts`
- Wired through `bro plugins install|uninstall|list pi` — the
  adapter carries the `adapter = {id:"bro",kind:"pi-extension"}`
  sentinel so install refuses foreign files at the slot.

## Plan

- [x] bro-1qpk.3.1 — `bro status --json` aggregated board read
- [x] bro-1qpk.3.2 — pi extension: board widget + /bro + hooks map
- [x] `bro plugins install pi` targets + pi artifact ladder +
      `isBroAdapter` sentinel for the pi kind
- [x] gen-plugins adapter entry + README; tsdown entry + package
      `./pi` export
