---

name: daemon
description: "Use when the project needs a supervisor that outlives the session — 'run the review loop forever', 'keep the fleet owned', `bro fleet daemon up`. The daemon is the long-lived process owner; `bro review watch` is the bounded observer that watches it; `bro fleet serve` is the UI surface. Thin wrapper over the bro CLI — mechanics live in `packages/cli/src/commands/daemon.ts` and `drive.ts`. Requires `bro` (npx -y @broject/bro@0) and the configured review-host CLI."
---

# /daemon (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Three liveness mechanisms, one role each (spec bro-wb3yc — the target
architecture; raw `drive --every` / `loop --every` / `rig watch` still
works for compatibility but is deprecated and unrecorded,
and everything else is a pass, an observer, or a policy alias):

| Role     | Command                                                                                    | Lifetime                        |
| -------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| Owner    | `bro fleet daemon up` — spawns the recorded `daemon run` loop detached                     | long-lived, until `down`        |
| Wake     | `bro pulse <S>` — the session-owned metronome; mailbox beats are the session's wakes       | until the arming shell kills it |
| Re-entry | `bro fleet rig next` — durable state → step\|gate\|wait\|done\|blocked                     | per call — stateless            |

Bounded observers (never cadence owners): `bro review watch
[--once|--every N --for S]`, `bro review act wait [PR]`, `bro wait
external:<rig>:<id>`. (`act wait --merge/--cleanup/--bead` also acts on
settle — merges, retires the worktree, closes the bead.) `bro fleet
serve` is the UI surface — a debug surface, not orchestration.

The daemon holds `drive.lock` (one supervisor per repo) and owns the
drive pass: act gates → fixer spawns → merges. Task agents are spawned
through the registry as detached peers — killing the daemon never kills
in-flight agents, and killing a watch window never touches either.

## Commands

- `bro fleet daemon up [--every SEC]` — orchestrator-only. Spawns the
  supervisor detached, records the armer in
  `<git-common>/bro/daemon.json`, logs to `<git-common>/bro/daemon.log`.
  Idempotent: a live holder (even a raw `bro review drive --every`) reports
  `already`, never doubles.
- `bro fleet daemon status` — lock holder + armer record + log path;
  an armed `bro/drive.json` shows `· installed`.
- `bro fleet daemon down` — SIGTERM the holder, clear the record.
  **Transient under an install**: `bro review drive install` armed
  `bro/drive.json`, so the next session checkpoint rearms the
  supervisor; `bro review drive uninstall` is the disarm.
- `bro fleet daemon run` — the loop itself; spawned by `up` (or by a
  session checkpoint rearming an installed supervisor), not for direct
  use.

## Guards

- `BRO_AGENT_ID` sessions are refused at `up` — spawned workers never
  arm supervisors (same predicate as `bro review drive --every`).
- **The daemon is only as live as its binary** — it execs whatever
  `bro` resolved at `up`/rearm time and keeps running it until `down`.
  Merged changes protect the fleet only after that binary is rebuilt
  AND the supervisor restarted; `bro doctor`'s `daemon` row compares
  the running entry against the repo.
- `daemon run` inherits drive's own guard, `drive.lock` hold, and
  heartbeat emission — the watchdog reads supervisor liveness through
  them, and `bro review watch` renders it in the `daemon` section. A
  recorded-but-dead daemon lands in `attention` — the pulse's job is
  noticing, `up` is the fix.
