---
title: Events — notify, mailbox, bus
description: The events facade — a session mailbox by default, a local event broker behind it.
---

Everything event-shaped in bro goes through one `events` facade.
`bro notify` writes there; the notify connector's postTool probe drains
drops into session context, so a watcher, fixer, or convoy worker
reaches a live session mid-turn instead of the recipient burning tokens
in a wait loop.

The default backend is the **mailbox** — plain files, no broker, no
config, no daemon. `"connectors": { "events": "bus" }` routes the same
writes through the local broker instead.

## The mailbox — `bro notify`

One atomic drop (tmp+rename) per event into
`<git-common-dir>/bro/notify/` inside a repo — shared across linked
worktrees via the common git dir — or the XDG state dir
(`$XDG_STATE_HOME`, default `~/.local/state`) outside one.

| Command | What it does |
| ------- | ------------ |
| `bro notify <text>` | Drop one event — delivered to every session's next postTool probe |
| `bro notify -- <text>` | Verbatim text — needed when it contains option-looking words like `--help` |
| `bro notify --to <agentId\|sessionId\|orchestrator> <text>` | Addressed drop for exactly one consumer — `orchestrator` names the session owning agents; absent means broadcast |
| `--kind note\|info\|ask\|result\|block` | A label, never a grant — a `block` or `ask` carries no approval or scope with it |
| `--in-reply-to <ref>` | The drop, bead, or step this answers |
| `--key <k>` | Coalesce — a pending same-key drop from this source is superseded by the newer one |

Delivery is pull-based: a drop never wakes a sleeping session — it lands
in context on the next tool call. Broadcast drops stay for every session
until the drop TTL reaps them; addressed drops expire on read
(single-consumer). Each drop should be self-contained — the drain
renders it verbatim.

## The broker — `bro bus`

A local event broker in `@broject/core` — topics, filters, seq cursors.
`status` deliberately exits 0 when the broker is down: nobody started
one is a normal state, not a fault.

| Command | What it does |
| ------- | ------------ |
| `bro bus serve [--json]` | Run the broker (SIGINT/SIGTERM to stop) |
| `bro bus publish --topic T --kind K [--key K] [--source S] [--to ADDR] [--cause C] [--ref R] [--payload JSON] [--json]` | Publish one event and exit — connect, write, close. `--to` addresses one recipient (`orchestrator` works here too); absent means broadcast |
| `bro bus subscribe [--topic T]… [--kind K]… [--to ADDR] [--since N] [--json]` | Stream matching events until interrupted; `--since N` replays from a seq cursor — a cursor outside the window reports a gap |
| `bro bus status [--json]` | Liveness and counters |

## Policy

- **Write, don't wait.** A finished worker, a watcher that saw a
  transition, a fixer that needs attention — drop the event and get on
  with it; never poll the parent.
- **Once per session, not once total.** The mailbox is broadcast with a
  per-session `.seen` cursor — a drop reaches every live session exactly
  once.
- **`bro watch --notify`** drops the initial snapshot and gate
  transitions into the mailbox — see
  [Fleet & supervision](/docs/commands/fleet).
