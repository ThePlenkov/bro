---
name: acp
description: "Use when an ACP client (Zed, JetBrains, Neovim, devin acp, kilo acp) should sit behind bro's hook seam instead of talking to the agent directly — `bro acp proxy -- <agent cmd>` is the cascading edge: verbatim forwarding plus session context on the first prompt. Thin wrapper over the bro CLI — mechanics live in the CLI."
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

| Command | What it does |
| ------- | ------------ |
| `bro acp proxy -- <agent cmd…>` | Foreground proxy — stdin/stdout IS the upstream wire. `--` is mandatory; the tail is exec'd directly (no shell), env `BRO_HOOKS=0` so the downstream tree never re-runs hooks. Exit 0 = client ended the wire; 1 = downstream died first; 2 = usage |

## Wiring a client

Point the client's "custom agent" at bro the same way it would name any
ACP server:

- **devin**: `devin acp` is itself an agent — `bro acp proxy -- devin acp`
  chains bro in front of it for a Devin-driven session.
- **kilo**: `bro acp proxy -- kilo acp`.
- **Zed / JetBrains / Neovim**: add bro as an external agent with the
  same argv shape — the client's own config syntax for a stdio ACP
  server.

Run the proxy inside the repo you want context from — actually, run it
anywhere: the seam probes `session/new`'s `cwd`, not the proxy's own,
so a session opened in another repo gets THAT repo's context or
nothing (fail-open, same as the hook).

## What crosses the seam — and what doesn't

- Session context collects in-process (the hook collectors as a
  library — no `bro hooks` subprocess), once per session, on the first
  prompt only. A `session/cancel` landing while the seam collects
  answers the held prompt `stopReason:'cancelled'` — the wire never
  shows a prompt after its cancel.
- `session/update` chunks never pay probe cost — the seam maps to
  wire-level events, not deltas.
- Permission policy (`bro-9qopj`), tool-call guards and the stop gate
  (`bro-u2eps`), and agent mode (`bro-tegz2`) are separate beads —
  permission requests forward verbatim today.

## Telemetry

- `acp.proxy.session` / `acp.proxy.turn` otel spans wrap each session
  and prompt; `session/update` feeds `agentTurnPlane` (`by: 'acp proxy'`).
- An unbadged run (no `BRO_AGENT_ID` — a human driving the proxy)
  still journals: `<git-common>/bro/proxy/acp-<session>.events.jsonl`.
