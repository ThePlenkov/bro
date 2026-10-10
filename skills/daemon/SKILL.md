---
name: daemon
description: "Use when the project needs a supervisor that outlives the session — 'run the review loop forever', 'keep the fleet owned', `bro daemon up`. The daemon is the long-lived process owner; `bro watch` is the bounded observer that watches it; `bro serve` is the UI surface. Thin wrapper over the bro CLI — mechanics live in `packages/cli/src/commands/daemon.ts` and `drive.ts`. Requires `bro` (npx -y @broject/bro@0) and the configured review-host CLI."
---

# /daemon (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

The three process roles, never conflated:

| Role | Command | Lifetime |
| ---- | ------- | -------- |
| Owner | `bro daemon up` — spawns `daemon run` (the `bro drive --every` loop) detached | long-lived, until `down` |
| Observer | `bro watch --every N --for S` | bounded window, dies on its own |
| UI | `bro serve` | a debug surface, not orchestration |

The daemon holds `drive.lock` (one supervisor per repo) and owns the
drive pass: act gates → fixer spawns → merges. Task agents are spawned
through the registry as detached peers — killing the daemon never kills
in-flight agents, and killing a watch window never touches either.

## Commands

- `bro daemon up [--every SEC]` — orchestrator-only. Spawns the
  supervisor detached, records the armer in
  `<git-common>/bro/daemon.json`, logs to `<git-common>/bro/daemon.log`.
  Idempotent: a live holder (even a raw `bro drive --every`) reports
  `already`, never doubles.
- `bro daemon status` — lock holder + armer record + log path.
- `bro daemon down` — SIGTERM the holder, clear the record.
- `bro daemon run` — the loop itself; spawned by `up`, not for direct
  use.

## Guards

- `BRO_AGENT_ID` sessions are refused at `up` — spawned workers never
  arm supervisors (same predicate as `bro drive --every`).
- `daemon run` inherits drive's own guard, `drive.lock` hold, and
  heartbeat emission — the watchdog reads supervisor liveness through
  them, and `bro watch` renders it in the `daemon` section. A
  recorded-but-dead daemon lands in `attention` — the pulse's job is
  noticing, `up` is the fix.
