# bro-w4a45 — /fleet: the real dashboard

## Problem

`bro serve` hosts `/fleet` plus `/api/v1/{snapshot,agents,health}`, but
the page renders only the snapshot's molecule-shaped rows. The agents
plane is rich — provider/model provenance, state, exit cause, worktree,
log — and never reaches a face. Queue depth, supervision, and the
mailbox have no read plane at all: the rig's actual work is invisible
("state exists but no face").

## Design

`/fleet` polls five GET planes, one per state domain, and every plane
degrades inside its own section — a 500 leaves the section on its last
good frame, never blanks the board.

- `GET /api/v1/agents` — the agents board: per-backend registry agents
  (rich `AgentInfo`), fleet occupancy, armed session-quota lanes
  (`bro agents status --json` parity) plus `discovered[]` — session-plane
  rows the registry never spawned (interactive sessions, foreign spawns,
  acp workers a legacy path skipped registering). Discovery rows carry
  `{kind, pid, name, worker, agentId}`; the `agentId` badge correlates a
  worker session to its registry agent so the board folds the session
  into the agent's row instead of counting the same work twice.
- `GET /api/v1/queue` — `bro status`'s beads sections: claimed
  (in-progress) rows + ready depth.
- `GET /api/v1/ticks` — supervision: the heartbeat file's last-tick
  summary, the drive supervisor's singleton lock (pid + liveness + lock
  age — the hold is heartbeated, so a stale mtime IS a stale supervisor),
  and pending watch markers with pid liveness and marker kind.
- `GET /api/v1/mailbox` — `{drops}`: the pending-drop tail, newest
  first. `peekMailbox` is read-only by contract — no seen cursor moves,
  no expiry reaps; a tail reports mailbox state, not one consumer's
  share.
- `/api/v1/snapshot` — unchanged sections, plus structured gate detail
  on `WatchPrGate` (mergeable, mergeState, openThreads, ciPending,
  ciFailing, reviewersPending, sastPending) populated on successful
  probes so the PR board renders columns instead of prose.

Sections: attention → agents (the union table: registry agents, legacy
loop-run records, discovered sessions) → queue → gates (the PR board) →
ticks → mailbox → fleet → molecules.

## Plan

- [x] `peekMailbox` in core/notify.ts — the read-only tail
- [x] `SessionPlane.listLive` + the devin implementation — `{pid, name,
      worker, agentId}` per live session
- [x] `GET /api/v1/{queue,ticks,mailbox}` + the agents board payload
- [x] structured `WatchPrGate` fields on the snapshot
- [x] the /fleet dashboard — union agents table, queue, PR gate board,
      ticks, mailbox tail, per-plane last-good frames
- [x] coverage: route tests, `collectTicks`, `peekMailbox`,
      `listDevinSessions`, `discoverSessions`
