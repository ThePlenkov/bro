---
name: notify
description: "Use when a background worker, watcher, or fixer must reach live sessions mid-turn — 'notify me when done', mailbox events, child→parent signaling. Thin wrapper over the bro CLI: `bro notify <text>` drops an atomic event; the notify connector's postTool probe delivers unseen drops into session context. Requires `bro` (npx -y @broject/bro@0)."
---

# /notify (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

The session mailbox — `<git-common-dir>/bro/notify/` inside a repo
(shared across linked worktrees via the common git dir), the XDG state
dir (`$XDG_STATE_HOME`, default `~/.local/state`) outside one.
`bro notify <text>` writes one atomic drop (tmp+rename); the notify
connector's `postTool` probe delivers it into session context —
real-time child→parent events with no tokens spent in a wait loop.

| Command | What it does |
| ------- | ------------ |
| `bro notify <text>` | Drop an event into the mailbox — delivered to every session's next postTool probe |
| `bro notify -- <text>` | Same, with the text taken verbatim — needed when it contains option-looking words like `--help` |

## Policy

- **Delivery is pull-based.** A drop never wakes a sleeping session —
  it lands in context on the session's next tool call (the postTool
  probe). Reaching an idle parent needs its own tool cadence (a
  bare-sleep holder), not a louder drop.
- **Write, don't wait.** A worker that finished early, a watcher that
  saw a transition, a fixer that needs attention — `bro notify` the
  event and get on with it; never poll the parent for attention.
- **Events, not streams.** Each drop should be self-contained — the
  drain renders it verbatim into context. A dropped `bro watch`
  snapshot is one event; so is a one-line `step X merged`.
- **Once per session, not once total.** The mailbox is broadcast: a
  drop reaches every live session exactly once (per-session `.seen`
  cursor) and expires after ~1h. Writing an event your own session
  ends up seeing is normal — the echo is delivery confirmation, not a
  lost message.
- **Fire-and-forget is honest.** If the event needs an answer, say
  what you need in the drop — the mailbox has no reply channel.
