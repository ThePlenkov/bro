---
scope:
  - packages/cli/src/commands/watch-heartbeat.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/commands/status.ts
  - packages/cli/src/commands/hooks.ts
  - skills/watch/SKILL.md
---

# bro-dxoa5 — durable heartbeat file: overnight state is a file read, not an inference

## Problem

The installed heartbeat (`bro watch install` — systemd/cron, spec
bro-7xgk.5) runs `bro watch --once --notify` on a timer. Its only
persisted output is a mailbox drop under `<git-common>/bro/notify/` —
and drops expire after `DROP_TTL_MS` (1h): the janitor that rides each
tick reaps them, and a drain skips them. Nothing else survives.

So an idle-looking rig is indistinguishable from a dead one once the
last hour has passed. Retro bro-l63ji: the user read the rig as idle
overnight — "bro! ты не работал ночью!" — though it merged two PRs and
stayed alive. The state a morning session could consult simply did not
exist: overnight state was *inferred* from whether the mayor session
happened to be polled (the mailbox drains on a session's own tool
calls), not read from anywhere.

## Design

Every `bro watch` tick writes the snapshot to a durable file,
`<git-common>/bro/heartbeat.json` — the last known state, one atomic
tmp+rename per tick, the same repo-shared location as `agents.json`
(worktrees share the common dir, so one repo has one heartbeat).
Outside a repo there is no file (same rule as the mailbox). Write
failures warn on stderr — the heartbeat is best-effort and never dies
on its own artifact.

The file is the heartbeat, not an event: it holds the full
`WatchSnapshot` (`{ts, attention, mols, gates, fleet, loop}`) and is
overwritten, never appended — "what did the rig last see" is exactly
one read. The mailbox stays the event channel; the file is the state
channel. The janitor never reaps it (its sweeps are scoped to
sessions/notify/agents/hooks/locks/logs) — it ages only by going
stale.

Two readers make it observable instead of inferred:

- `bro status` gains a `watch` row — `watch: heartbeat 4m ago — quiet`
  (or `— N attention`); an absent or unreadable file omits the row,
  per the board's empty-sections contract. `--json` carries
  `watch: {ts, ageMs, attention} | null`.
- Session-start context gains a `watch heartbeat: last tick <age> ago`
  line — a resuming session's `bro state` reports rig liveness even
  with an empty mailbox (Cursor's prompt-submit hydrate path gets the
  same line).

A fresh file means the heartbeat is alive; a stale one means it died
— the file's own age is the signal. No verdict threshold: a manual
`bro watch` is also a heartbeat, so "freshness" belongs to the reader.

## Plan

1. `commands/watch-heartbeat.ts` (new): `heartbeatFile`,
   `writeHeartbeat`, `readHeartbeat`, `heartbeatAge`, `heartbeatLine` —
   a small standalone module so the hooks/status hot paths never import
   the watch plane tree.
2. `watch.ts`: write the file on every tick — same best-effort +
   stderr-warn contract as the mailbox drop.
3. `status.ts`: `watch` field + render row.
4. `hooks.ts`: `watch heartbeat:` line in `emitSessionContext` and the
   prompt-submit hydrate path.
5. Docs: `skills/watch/SKILL.md` row + policy line (then
   `npm run gen:plugins`), README watch row,
   `site/content/docs/commands/fleet.md` table.
6. Tests (`watch-heartbeat.test.ts`, `status.test.ts`): write/read
   round-trip, tmp+rename leaves no residue, no-repo null, corrupt
   file null, status row present/absent, `heartbeatLine` text.
7. `npm test` (exact CI command).
