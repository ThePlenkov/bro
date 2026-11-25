# bro-ixs2g — background work is the agent's native non-blocking task

## Problem

`bro act wait`, `bro flow loop`, and fleet spawns supervise themselves with
detached processes (`spawn(..., { detached: true })` in act-wait.ts,
`cmdLoop`'s spawn, convoy/land watchers). A detached process is invisible
to the agent that armed it: no completion event reaches the session, the
host's task UI shows nothing, and a crashed watcher is indistinguishable
from a long one until `fleet resume` sweeps the marker. The agent either
polls blindly (wasted turns) or forgets the work exists (dropped gates).

Meanwhile every host bro runs inside already owns a non-blocking task
substrate: omp extensions live in-process and can hold timers plus steer
the session (`sendMessage … deliverAs: 'steer'`), pi/opencode carry their
own wake paths, and `bro exec` (bro-84zrj) already proves the connector
report-back seam. Supervision belongs there — the host that can wake the
agent is the host that should own the wait.

## Contract

1. **Host-native by default.** When bro arms a wait inside a session whose
   host can supervise, the wait is registered with the host substrate —
   omp: an extension-held poll timer whose completion steer-carries the
   verdict into the session; other hosts: their equivalent wake. The
   agent sees its background work as a task it owns, and completion wakes
   the session with the verdict in context.
2. **Detached stays the escape hatch.** Bare shells, cron-adjacent usage,
   and hosts without a supervision seam keep today's detached spawn —
   explicitly chosen (`--detached`) or fallen back to with a stderr note
   naming why. Never silent: which substrate owns the wait is part of the
   arming output.
3. **One negotiation seam.** act-wait/loop/land do not grow per-host
   branches. A single supervision facade (`supervise(spec) →
   { substrate: 'host' | 'detached', handle }`) decides: probe the session
   environment for a host capability marker, register host-native when
   present, fall back otherwise. Host adapters implement the capability
   side; the CLI implements the fallback once.
4. **The marker contract is unchanged.** Whatever the substrate, the wait
   still writes/updates the same watch markers `fleet resume` and
   `act rearm` read — host-native supervision is a better wake, not a
   parallel ledger.

## Phases (implementation beads)

- **P1 — the seam.** `supervise()` facade in @broject/core: capability
  probe (env markers the adapters export), substrate decision, detached
  fallback extracted verbatim from act-wait.ts. act-wait rewired onto it —
  behavior identical where no host capability exists.
- **P2 — omp-native supervision.** The omp adapter holds a poll timer per
  armed wait (in-process, off the event-loop-critical path); on settle it
  `sendMessage`s the verdict with `deliverAs: 'steer'` so completion wakes
  and proceeds the agent. Capability marker exported into the session env
  so P1's probe can see it.
- **P3 — loop and land.** `bro flow loop`'s per-bead supervision and
  act-land's settle watcher move onto the facade. Fleet spawns stay
  detached by design (they ARE the work, not the supervision of it).

## Non-goals

- No pty/output-forwarding changes — supervision is wake semantics, not
  output plumbing.
- No removal of the detached path — it remains the contract for
  session-less arming.
- Fleet worker spawns are out of scope: a spawned agent is not
  supervision, it is the labor.
