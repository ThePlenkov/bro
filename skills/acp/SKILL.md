---

name: acp
description: "Use when an ACP client (Zed, JetBrains, Neovim, or any `* acp` agent binary) should reach bro's surface or sit behind bro's hook seam — bare `bro acp` is bro-as-agent (CLI contract as slash commands, free-form prompts routed to the configured provider); `bro acp proxy -- <agent cmd>` is the cascading edge: verbatim forwarding plus session context on the first prompt. Thin wrapper over the bro CLI — mechanics live in the CLI."
---

# /acp (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

## Agent mode — `bro acp` (spec bro-tegz2)

Bare `bro acp` IS the agent — the client's "custom agent" argv is just
`bro acp`; no client-side plugin, no `* acp` naming convention.

- The CLI contract (`bro contract dump --json`) is announced per
  session as `available_commands` — `/act status`, `/next`, `/drill`,
  the whole non-hidden surface minus commands that can never be a turn
  (protocol servers, daemons, watchers). A leading `/name args…`
  prompt runs the real `bro` child inside `session/new`'s `cwd` and
  streams stdout back as chunks; failures report in-band.
- Free-form prompts forward to the configured downstream provider and
  stream its updates verbatim. Provider selection is `fleet.routing`
  class → chain head: `--class <name>` picks a lane (default
  `default`), `--provider <name>` pins an entry (exclusive), and with
  no routing table the first `acp` entry answers. The head must be an
  `acp`-type entry — a wrong kind is a config error, never a silent
  re-route.
- Cancel dies the running turn (SIGTERM to a slash child, or the
  downstream's own `session/cancel`); a slash command's stdout never
  crosses after its cancel.

The generic stdio-facade-over-a-provider surface is `brouter acp`
(spec bro-te3yf) — this mode is bro's own identity: its commands, its
seam, its routing.

## Proxy mode — `bro acp proxy -- <agent cmd>` (specs bro-rs8sp.md, bro-bhyo1.md)

The client spawns bro as the agent, bro spawns the real agent, and
every JSON-RPC message crosses untouched — requests, notifications,
`_`-methods, `_meta`, and error envelopes, verbatim in both
directions. The one rewrite is the seam: the session's first
`session/prompt` gets ONE prepended text block carrying the same
session-start + prompt-submit context `bro hooks` emits, probed inside
`session/new`'s cwd. Later prompts carry prompt-submit context only.

## Command

| Command                                         | What it does                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro acp [--provider <name> \| --class <name>]` | Agent mode — bro IS the agent. Slash commands from the CLI contract run locally; free-form prompts forward to the routed provider. Exit 0 = client closed the wire; 1 = downstream died or config error; 2 = usage                                  |
| `bro acp proxy -- <agent cmd…>`                 | Foreground proxy — stdin/stdout IS the upstream wire. `--` is mandatory; the tail is exec'd directly (no shell), env `BRO_HOOKS=0` so the downstream tree never re-runs hooks. Exit 0 = client ended the wire; 1 = downstream died first; 2 = usage |

## Wiring a client

Point the client's "custom agent" at bro the same way it would name
any ACP server — agent mode needs no downstream in argv:

- **agent mode**: `bro acp` (or `bro acp --class work`) — bro's slash
  surface plus the routed provider behind free-form prompts.
- **kilo via the cascade**: `bro acp proxy -- kilo acp`.
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
  guards, no gate (the spawned agent already runs with it, which is
  why the child env pins it).
- Permission policy (bro-9qopj) is a separate bead — permission
  requests forward verbatim today.

## Telemetry

- `acp.proxy.session` / `acp.proxy.turn` otel spans wrap each session
  and prompt; `session/update` feeds `agentTurnPlane` (`by: 'acp proxy'`).
- An unbadged run (no `BRO_AGENT_ID` — a human driving the proxy)
  still journals: `<git-common>/bro/proxy/acp-<session>.events.jsonl`.
