# bro-l8c4f.3 — down says stopped only when the worker is dead

Parent audit: bro-l8c4f (stop-truthfulness), evidence at rev
674e3be — `stopAgent`/`cmdDown` in `agents.ts` and the native
connector's bounded kill-wait in `agent-connectors.ts`.

## Problem

`stop()` is a request, not a result. The native connector SIGTERMs the
wrapper's process group, waits up to 2 s, and returns either way.
`stopAgent` then reports `stopped: true` from the fact that `stop()`
ran — it never re-checks the worker. Two ways that announces a live
worker as dead:

1. **TERM-resistant leader** — the wrapper ignores the signal, the
   bounded wait expires, and `down` still prints `stopped <id>` while
   `DELETE /api/v1/agents/<ref>` answers `200 {stopped: true}`.
2. **wrapper dies, descendant survives** — `stop()`'s liveness guard
   checks the wrapper pid only. A TERM-resistant child (signal ignored
   before exec, inherited through fork/exec) keeps running while the
   wrapper is gone; the `stopped` marker lands, the registry says
   stopped, and a respawn gets a green light to race a live writer.

The acceptance: no successful `stopped`/HTTP success for a
TERM-resistant worker; a wrapper that dies before its descendant must
not make the step safe to respawn; a repeated `down` stays idempotent;
a racing replacement never receives a foreign signal; the operator sees
the timeout instead of silence.

## Design

### The verdict is probed after the stop (stopAgent)

`stopAgent` keeps its pre-stop read (terminal detection, the respawn
note — unchanged), then after `await conn.stop(id)` re-reads
`conn.status(id)` — unless the pre-stop state was already terminal
(there was nothing live to verify; those paths behave exactly as
before).

`StopOutcome` gains one field and `stopped` becomes its projection:

```ts
verdict?: 'stopped' | 'still-running' | 'unverified'
// stopped: verdict === undefined || verdict === 'stopped'
```

The ladder (one probe):

| post-stop read                  | verdict       |
| ------------------------------- | ------------- |
| `AgentNotFound` (gone — the desired end state) | `stopped` |
| `exited`, `stopped`             | `stopped`     |
| `running`, `spawned`            | `still-running` |
| `lost`, `blocked` (no death record) | `unverified` |
| any other probe error (the backend cannot answer) | `unverified` |

### Both surfaces tell it

- `bro fleet agents down <target>` (`cmdDown`): `still-running` and
  `unverified` end in `die()` — an `error:` line naming the worker, the
  observed state and "not safe to respawn", exit 1. The
  `stopped <id> (…)` line prints only for `stopped`.
- `DELETE /api/v1/agents/<ref>` (`routeAgentDelete`): a non-terminal
  outcome with verdict `still-running`/`unverified` answers **409**
  `{error, agent, stopped: false, verdict, respawned?}` instead of 200.
  Miss (404), degraded-miss (503), terminal (200 `terminal: true`) and
  a connector that returns no verdict are unchanged.

### The native connector verifies the unit, not the wrapper

The wait loop and the registry-lock skip-patch guard in native
`stop()` become `pidAlive(wrapper) || groupMemberAlive(wrapper)`:

- `groupMemberAlive(pgid)` gates on `kill(-pgid, 0)` — no such group
  (ESRCH) is dead without touching /proc; EPERM is a live group we
  cannot signal;
- a live group still counts the unreaped wrapper's own zombie, so the
  members are read from `/proc/<pid>/stat`: a non-zombie process whose
  pgrp (field 5, the split `procStat` already uses) equals `pgid`;
- no readable `/proc` reads as **alive** — fail-open, the rule
  `pidAlive` documents: never a false "the unit is dead".

Consequences: a live leader waits out the bounded 2 s and skips the
patch (status stays `running` → verdict `still-running`); a dead
wrapper with a live descendant also skips the patch (status reads
`lost` → verdict `unverified` — no `stopped` marker ever lands, the
entry stays unconfirmed instead of respawnable-as-stopped); a unit
that is actually gone gets the marker → `stopped` → verdict
`stopped`.

Signals are unchanged: the TERM still targets the wrapper's own group
(identity-checked by pidStart), and the lock re-verify still refuses a
respawned entry — the racing replacement receives no foreign signal.
A second `down` on a `lost` entry is the terminal "nothing to stop"
path: idempotent, no new kill beyond `stop()`'s own bound.

### Scope

- Only the native connector gets the group probe — it is the audit's
  subject and the `sh -c` wrapper's own shape. tmux, docker and
  gascity already wait on their own unit (session/container/city)
  before patching; their truth now flows through the same verdict.
- No SIGKILL escalation for a TERM-resistant worker — a bounded,
  visible refusal (exit 1 / 409) is this change's contract; escalation
  is a separate design decision.

## Verify

- `packages/cli/src/commands/agents.test.ts` (`bro agents down`):
  - **live worker → not stopped**: `trap "" TERM; sleep 30` (wrapper
    ignores TERM) — `down` exits 1, stderr says the worker is still
    running after SIGTERM, stdout carries no `stopped <id>` line, no
    `stopped` marker lands in the registry;
  - **dead worker → stopped**: the ordinary TERM'd spawn still exits 0
    with `stopped <id>` (the existing idempotency test, unchanged);
  - **wrapper dead, descendant alive**: `(trap "" TERM; exec sleep 30)
    & wait $!` — `down` exits 1 as `unconfirmed`/unverified, the
    `stopped` marker is not written, and `fixture.restore()`'s group
    SIGKILL reaps the survivor;
  - the flaky-pid fake (bro-8ltl): a status that still reads `running`
    after `stop()` exits 1 — its respawn note stays asserted.
- `packages/cli/src/commands/serve.test.ts`: `deps.stop` returning
  `verdict: 'still-running'` and `'unverified'` → 409 with
  `stopped: false` and the verdict; the existing 200/404/503 rows keep
  their shape.
- Commands (from `packages/cli`):
  `XDG_CONFIG_HOME=/tmp/opencode/empty-config npx tsx --test
  src/commands/agents.test.ts src/commands/serve.test.ts
  src/agent-connectors.test.ts` and `npx tsc --noEmit`.
