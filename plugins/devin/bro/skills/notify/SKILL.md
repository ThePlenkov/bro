---
name: notify
description: "Use when a background worker, watcher, or fixer must reach the parent session mid-turn — 'notify me when done', mailbox events, child→parent signaling. Thin wrapper over the bro CLI: `bro notify <text>` drops an atomic event; the notify connector's postTool probe drains the mailbox into session context. Requires `bro` (npx -y @broject/bro@0)."
---

# /notify (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

The session mailbox — `<git-common-dir>/bro/notify/` inside a repo
(shared across linked worktrees via the common git dir),
`$XDG_STATE_HOME/bro/notify/` outside one. `bro notify <text>` writes
one atomic drop (tmp+rename); the notify connector's `postTool` probe
drains it into the receiving session's context — real-time
child→parent events with no tokens spent in a wait loop.

| Command | What it does |
| ------- | ------------ |
| `bro notify <text>` | Drop an event into the mailbox — delivered to the next session whose postTool probe fires |

## Policy

- **Write, don't wait.** A worker that finished early, a watcher that
  saw a transition, a fixer that needs attention — `bro notify` the
  event and get on with it; never poll the parent for attention.
- **Events, not streams.** Each drop should be self-contained — the
  drain renders it verbatim into context. A dropped `bro watch`
  snapshot is one event; so is a one-line `step X merged`.
- **Delivered once, to whoever drains first.** Consuming deletes the
  drop — don't write into the mailbox expecting a *specific* session
  to see it; the repo mailbox is shared.
- **Fire-and-forget is honest.** If the event needs an answer, say
  what you need in the drop — the mailbox has no reply channel.
