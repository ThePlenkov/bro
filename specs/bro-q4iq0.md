# bro-q4iq0 — a blocked act-wait verdict surfaces as a finding

## Problem

`bro act wait` settles BLOCKED by printing the gate's blockers and
exiting non-zero. When the wait ran detached (`act rearm` respawn,
setsid, a shell that outlived its turn), nothing reads that output —
the verdict dies with the watching shell and the PR sits blocked until
someone re-probes it by hand. Retro bro-gk49e: the watcher's BLOCKED
exit (8 threads + 2 SAST) arrived after the arming turn ended and sat
unprocessed until the user pinged.

Sibling bro-yb4nn made the act skill treat a BLOCKED exit as a work
list; this bead is the event→finding mechanics: the verdict must land
in the channels a session rehydrates from even when no session was
mid-turn to read the exit.

## Design

Two surfaces, each an existing channel, no new machinery:

- **Mailbox event** (`bro notify` channel — the named ask). On a
  blocked settle `cmdWait` publishes through the `events` facade:
  `topic: 'act'`, `kind: 'block'`, `key: 'act-wait-<pr>'` (keyed so a
  re-armed wait that blocks again supersedes its own stale drop),
  `source: 'act-wait'`, `ref` = the PR URL, broadcast (no `to` — every
  live session is a valid reader). The payload names the blockers and
  points at `bro act threads <pr>`. The notify connector's drain
  delivers it to live sessions mid-turn, and — new here — at
  `sessionStart` too, so a pending drop rehydrates at the literal next
  session start, the same probe slot the goal reminder uses. The drop
  TTL (1h) bounds delivery: past it the mailbox copy expires, which the
  marker below covers.
- **Verdict marker** — a settled wait leaves no watch marker today
  (`watchEnd` removes it — a kept promise). On a blocked settle the
  wait instead leaves a *verdict* marker `<pr>-blocked-<pid>-<n>.json`
  in `<git-common>/bro/watches/` carrying `verdict: 'blocked'` and the
  blocker list. The filename's `blocked` kind segment keeps it out of
  `deadWatchPlan`/`act rearm` (a settled wait is not a promise to
  resurrect — rewatching a blocked gate re-settles instantly), and
  `merge: false` in the record means ANY live same-PR watch covers it
  (`covers()` hides it, the covering watch's `watchEnd` sweeps it — the
  re-arm *is* the answer to the verdict). It never counts as live in
  `listWatches`/`hasLiveWatch`, so a verdict can never satisfy the stop
  gate's "watched" check. The act connector's `sessionStart`
  (`watchLines`) flags it with the blockers and `bro act threads <pr>`,
  claimed by the same atomic `watchRetire` as stale markers and
  re-flagged while the claim could have been lost — the verdict nags
  until covered, settled, or aged out (the existing marker TTL).

Ordering in `cmdWait`: `waitForGate`'s `finally` runs `watchEnd` first
(the live promise is kept, its marker goes), then the verdict marker is
written — a dead marker can never be misread as a live wait.

Both writes are best-effort: a verdict record must never turn the
exit-code contract into a failure, and `bro act wait` outside a repo
(there is none — `resolvePr` needs one, but the pattern holds) or with
an unwritable common dir still exits with the verdict.

`waitForGate` and the loop's `driveGate` are untouched: the loop parks
its verdict on the bead (`noteBead`), which is already a durable
finding.

## Non-goals

- Timeout settles stay silent (marker retired on exit, `timed_out` is
  "still pending — re-arm", not a finding) — existing skill policy.
- Fetch-exhaustion throws — an error, not a verdict.
- `bro drive`/loop verdicts — they already own beads/fixers.
- No debt-ledger row (the bead's "(or a debt row)" alternative — the
  marker + mailbox pair covers the same ground without minting a bead
  per blocked settle; `bro drive` owns the fixer-bead escalation).

## Validation

- `pending-watch.test.ts`: verdict marker writes/lists dead, excluded
  from rearm plans, hidden while a same-PR live watch covers it, swept
  by the covering watch's `watchEnd`, parses through `readMarker`.
- `notify.test.ts`: `sessionStart` drains pending drops like postTool.
- `act-wait.e2e.test.ts` (fake review host): blocked settle → exit 1 +
  mailbox drop `{topic:'act', kind:'block', key:'act-wait-<pr>'}` naming
  the blockers + a `-blocked-` verdict marker; green settle → neither.
- `bro spec check bro-q4iq0` passes (this file).
- `npm run build`, `npm run typecheck`, `npm test`, `check:plugins`,
  `check:embedded`.
