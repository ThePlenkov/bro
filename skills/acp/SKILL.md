---

name: acp
description: "Use when an ACP client (Zed, JetBrains, Neovim, or any `* acp` agent binary) should sit behind bro's hook seam instead of talking to the agent directly — `bro acp proxy -- <agent cmd>` is the cascading edge: verbatim forwarding plus session context on the first prompt. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /acp (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

`bro acp proxy -- <agent cmd>` puts bro on the ACP wire (specs
bro-rs8sp.md, bro-bhyo1.md): the client spawns bro as the agent, bro
spawns the real agent, and every JSON-RPC message crosses untouched —
requests, notifications, `_`-methods, `_meta`, and error envelopes,
verbatim in both directions. The one rewrite is the seam: the session's
first `session/prompt` gets ONE prepended text block carrying the same
session-start + prompt-submit context `bro hooks` emits, probed inside
`session/new`'s cwd. Later prompts carry prompt-submit context only.

## Command

| Command                         | What it does                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro acp proxy -- <agent cmd…>` | Foreground proxy — stdin/stdout IS the upstream wire. `--` is mandatory; the tail is exec'd directly (no shell), env `BRO_HOOKS=0` so the downstream tree never re-runs hooks. Exit 0 = client ended the wire; 1 = downstream died first; 2 = usage |

## Wiring a client

Point the client's "custom agent" at bro the same way it would name any
ACP server:

- **kilo**: `bro acp proxy -- kilo acp`.
- **Zed / JetBrains / Neovim**: add bro as an external agent with the
  same argv shape — the client's own config syntax for a stdio ACP
  server.

Run the proxy anywhere — the seam probes `session/new`'s `cwd`, not
the proxy's own, so a session opened in another repo gets THAT repo's
context or nothing (fail-open, same as the hook).

## What crosses the seam — and what doesn't

- Session context collects in-process (the hook collectors as a
  library — no `bro hooks` subprocess), once per session, on the first
  prompt only. A `session/cancel` landing while the seam collects
  answers the held prompt `stopReason:'cancelled'` — the wire never
  shows a prompt after its cancel.
- `tool_call` updates run the post-tool hook in-process too (spec
  bro-u2eps): the session-marker arming and post-tool guard defs
  `bro hooks` runs per tool call — no run.sh subprocess per call.
  Guard `say` lines and gate hints buffer onto the next crossed
  `session/prompt` as prepended text — never a fabricated wire
  message.
- The turn end is the stop gate: a `session/prompt` response held by
  an armed blocking contribution gets exactly ONE follow-up prompt
  carrying the gate's message, and the gate turn's own end passes
  unconditionally — gates, not loops.
- `BRO_HOOKS=0` makes the proxy a pure transport — no arming, no
  guards, no gate, no permission policy (the spawned agent already
  runs with it, which is why the child env pins it).
- `session/request_permission` runs the same policy the
  PermissionRequest hook does (spec bro-9qopj): session-cap refusals
  and connector `preTool` blocks deny (reject_once, or `cancelled`
  when no reject is offered), bro/bd self-tool commands approve
  (allow_once), everything else forwards to the client verbatim and
  the client's own answer relays back. Guard `warn` verdicts ride the
  next prompt as advisory text. Every decision journals —
  `kind:'permission'` rows with `decidedBy:'proxy'|'client'` in the
  session's events archive (`<git-common>/bro/proxy/` unbadged).
- Agent mode (`bro-tegz2`) is a separate bead.

## Telemetry

- `acp.proxy.session` / `acp.proxy.turn` otel spans wrap each session
  and prompt; `session/update` feeds `agentTurnPlane` (`by: 'acp proxy'`).
- An unbadged run (no `BRO_AGENT_ID` — a human driving the proxy)
  still journals: `<git-common>/bro/proxy/acp-<session>.events.jsonl`.
