# bro-cqjd0 — the bus says when a foreign push lands on your branch

## Problem

A session that owns a PR can have that PR's branch rewritten by someone
else. On 2026-10-20 a review bot (`kiloconnect[bot]`) pushed a commit
onto `fix/codescene-app-is-the-gate` while the opencode session was
editing it; the session found out from a non-fast-forward rejection on
its next push, and had to merge the bot's broken version back by hand.

The bus already knows everything needed to warn the session:

- the session's own markers name the PRs it armed (the `.act` marker's
  `#<pr>` detail lines);
- the drive's pass fetches every open PR's head SHA;
- the events facade can address a drop to one session.

What is missing is the *comparison* — the bus never says "your PR moved".

## Design

### The head memory

The drive keeps the last head SHA it saw per PR:
`<git-common>/bro/drive/heads/<repo>-<pr>.json` = `{ sha, at }`.

Not the act-state cache: that TTL is 30s (one poll window) while the
drive ticks every 300s — a comparison against it would never have both
sides. The drive's own file is the only memory that spans a tick.

### The armed sessions

`liveWorkEntries(hooksDir, ['.act'])` gives every live session marker's
detail lines; a `#<pr>` detail names the PR that session armed. The
session id is the marker file's name minus the `.act` suffix.

The detail extraction is currently wrong: `armDetail` takes the FIRST
number in the command, so `bro act wait --interval 60` arms the detail
`#60` — a poll interval, not a PR. The extraction must name a PR only
when the command names one (`bro act <verb> <pr>`), and otherwise leave
the detail empty.

### The event

On a tick where a PR's head SHA differs from the memory:

- the memory is rewritten with the new SHA (the change is now the
  baseline);
- for every live session that armed that PR, the bus publishes an
  ADDRESSED event (`to: <sessionId>`), keyed per PR+SHA so a repeat of
  the same head coalesces.

The payload names the PR, the old and the new head, and says plainly
that the bus does not know whether the push was the session's own: the
session knows what it pushed, the bus only knows the branch moved.

The bus REPORTS; it does not coordinate. Nothing is blocked, no marker
is written, no branch is protected — the session decides what to do
about a branch that moved.

### Fail-open throughout

A missing memory (first sight of the PR) is not a change. An unreadable
marker, an unwritable memory file, a failed publish — none of them fail
the drive's pass. The signal is an advisory, never a gate.

## Verify

- `packages/cli/src/commands/hooks.test.ts` — the `act` detail names a
  PR only when the command names one; a poll interval is not a PR.
- `packages/cli/src/commands/foreign-push.test.ts` — the head memory
  round-trips; the first sight is not a change; a moved head is; the
  armed sessions come from the live `.act` markers; the event is
  addressed and keyed per PR+SHA.
- `packages/cli/src/commands/drive.test.ts` — a pass over a PR whose head
  moved publishes the addressed event; a pass over a PR whose head held
  publishes nothing; an unwritable memory fails open.
