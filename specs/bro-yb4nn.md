# bro-yb4nn — act skill: first poll line is not the verdict

## Problem

Retro bro-gk49e (from wtf bro-9wkla): an agent opened PR #365, armed the
watchers, and reported done on the strength of the first poll line —
`reviewers_pending` was still >0. The watcher's BLOCKED exit (8 review
threads + 2 SAST) then arrived as an event after the turn ended and sat
unprocessed until the user pinged.

The skill's prose rules existed but did not bind at the decision point:
"a watcher exit is a state to inspect, not silence" enumerates
`timed_out` → re-arm and died-marker → `act rearm`, but never says what
a BLOCKED exit *is* — a named work list — nor that arming the watcher
plus reading its first line is not the gate settling.

## Design

Policy-only change to `skills/act/SKILL.md` (sink: agentic-documents) —
no CLI mechanics change; `bro act status`/`wait` already compute the
gate, count `reviewers_pending`, and name blockers on a BLOCKED exit.

Strengthen the "pushed PR is merged, watched, or handed off" bullet with
three bindings:

1. **'Watcher armed' is never the end state** — the first poll line is a
   coverage snapshot (proof the watch runs), not the verdict. The
   verdict is the watcher's exit, and a gate showing
   `reviewers_pending>0` is unsettled — a pending reviewer may still
   post findings.
2. **A non-zero BLOCKED exit is a work list, not a notification** — the
   blockers it names are the next loop iteration: `bro act threads`,
   then fix/reply/defer/resolve each, push, re-arm
   `bro act wait --merge`. A BLOCKED event surfacing after the arming
   turn ended is live work for the next turn, not stale mail.
3. **The loop exits on OK or named blockers** — keep driving until the
   gate reports OK, or the status reply names each standing blocker and
   its owner (handoff, human-wait). A report that idles past
   `reviewers_pending>0` or a named blocker is the failure this spec
   exists to prevent.

## Non-goals

- Changing `bro act status`/`wait` exit codes, output, or marker
  mechanics — the gate as code already reports `reviewers_pending` and
  names blockers.
- bro-q4iq0 (a blocked act-wait verdict surfacing as a finding, not only
  an exit code) — sibling bead owns the event→finding mechanics; this
  bead is prose policy only.

## Validation

- `bro spec check bro-yb4nn` passes (this file).
- `npm run build`, `check:plugins`, `check:embedded` — embedded snapshot
  regenerates from `skills/` unchanged in structure.
- Diff review: the three bindings above land in the act skill bullet.
