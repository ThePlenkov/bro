# bro-f6zp — janitor: retention and reaping for agent state

## Problem

Nobody reaps the state bro accumulates under `<git-common>/bro/`.
Evidence on 2026-10-04: `bro/notify` held 83 orphaned `.seen-<session>`
cursors for sessions that no longer exist, agent homes
(`bro/agents/<agentId>.{prompt.md,log,exit}`) have no reaper at all — the
only unlink in agent-connectors is the `.work` marker, and it exists for
respawn races, not retention — and nothing bounds the append-only logs:
a 13-day-old session trace journal held 21864 nodes and still grows.
The counter-example that proves the shape: the mailbox itself reaps
correctly (drops expire, drained notes unlink) — per-note lifecycle is
solved, per-session and per-agent lifecycle is not.

## Design

The janitor is a **function, not a process** — `runJanitor(dir)` in
`@broject/core`, invoked as a side effect of `bro watch`'s tick (the
existing cadence; no new daemon, no cron) and reported by `bro doctor`
as a dry-run probe. It walks `<git-common>/bro/` and returns a report —
a silent janitor is indistinguishable from a broken one, so every reap
and truncation is counted and the watch tick prints what it removed.

Reap rules (bead RULES, made concrete):

1. **Lifetime follows the registry entry.** An `agents.json` entry that
   recorded its death (`stopped === true` or `exitStatus` set) and aged
   past `DEAD_RETENTION_MS` (7d — long enough for `bro agents status` /
   fleet views to keep reporting the death) is removed under the same
   registry lock; its `agents/<agentId>.*` files go with it — the
   `<agentId>.*` naming already makes that a single unlink set, no new
   bookkeeping. `agents/<id>.*` files whose id no registry entry points
   at are reaped unconditionally — the entry IS the lifetime proof, a
   file without one is debris.
2. **Cap by size regardless of liveness.** `hooks/trace/*.jsonl`,
   `agents/*.log`, `judge/*.jsonl` truncate to the newest whole-line
   tail past `LOG_MAX_BYTES` (1 MiB → keep 512 KiB). Rewrite is in-place
   (read tail, write at 0, `ftruncate`) — a spawned agent holds its
   `.log` fd open, and tmp+rename would strand its output on a dead
   inode. `act-checks.jsonl` is exempt — it self-caps (bro-8xv6).
3. **Session-scoped state needs an owner or an expiry.** A session's
   footprint is its hooks markers `<sid>.<aspect>` — registry-present
   while ANY marker could still arm a gate (`markerLive` on the marker
   TTL: owner pid alive, or ownerless mtime inside `MARKER_TTL_MS` —
   reaping uses the armed-state bar, not the 24h detection one, since
   deleting a marker disarms a stop gate). A session with no present
   marker is dead; its state reaps when its worktree is also gone — no
   `.work` marker detail line resolving to an existing absolute path
   (the conjunctive clause keeps a dead-owned marker whose checkout
   still exists, since a session resume on that tree re-uses it).
   Reaped per dead session: all `hooks/<sid>.*`, `hinted/<sid>.*`,
   `fired/<sid>`, and `notify/.seen-<sid>`. Unverifiable sessions get
   expiry instead:
   markerless cursors reap past a day of drain-idleness (a live
   session's postTool rewrites its cursor constantly; a cursor
   untouched for a day belongs to nobody — reaping loses nothing, the
   drops it dedups die in an hour anyway), and every marker / hinted /
   fired / trace / cursor file reaps past `MARKER_TTL_MS` (7d) as the
   absolute floor. Trace journals reap on TTL/size only — never on
   session death; they are the postmortem record `bro learn` reads.
4. **A lock older than the agent it guards is garbage.** `*.lock` files
   under `bro/` whose `<pid>:<rand>` token names a dead pid unlink —
   the filelock already steals them on acquire, the janitor reaps the
   file itself. Lock-adjacent debris (`<lock>.<pid>.<rand>.tmp` staged
   tokens, `<lock>.cap-*` captured instances, mailbox `.*.tmp` drops)
   reaps past a one-minute floor; expired `*.txt` drops reap without
   waiting for a drain.
5. **The janitor prints what it removed.** `bro watch` folds a
   `janitor: …` line into attention (and a `janitor` field into
   `--json`) only when it did work; `bro doctor` reports pending debris
   from a dry run — read-only stays read-only.

Every unlink revalidates just before `rmSync` (a marker re-armed or an
agent file recreated between scan and delete is a live file, not
debris), and registry mutation runs inside `agents.json.lock` — the
same lock spawns and `.work` arms hold — so a respawn mid-sweep keeps
its identity.

## Out of scope / approximations

- **The bus** (bro-2hno) — per-consumer cursors become a broker seq in
  memory; the janitor still reaps today's file debris and stays correct
  after it lands.
- **Sockets** — none exist under `bro/` today; dead-pid locks are the
  actionable half of rule 4. A `.sock` file is reaped only by the
  generic TTL floor if one ever appears — a listening socket re-binds
  on reconnect anyway.
- **`watches/`** — pending-watch markers already self-prune on read
  (dead pid, TTL, retire residue); not the janitor's job.
- **`agents.json.lock` while scanning markers** — the sweep takes the
  shared occupancy lock so a `.work` arm cannot interleave between the
  dead-verdict and the unlink (same reasoning as armSession's lock).
- **Retention is fixed, not configured** — 7d retention, 24h session
  liveness, 1 MiB log cap mirror the existing marker/cursor/ledger
  constants; a knob belongs in a `janitor` config section when someone
  needs one, not preemptively.
