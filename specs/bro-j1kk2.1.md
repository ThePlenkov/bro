---
scope:
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/agents.test.ts
  - skills/agents/SKILL.md
  - site/content/docs/commands/fleet.md
---

# bro-j1kk2.1 — `bro agents log <ref> [-f]`: live tail of a managed agent's log

## Problem

The wire streams; the observation plane doesn't. `bro acp-worker` drains
`session/update` notifications into `<git-common>/bro/agents/<id>.log`
incrementally — every `agent_message_chunk` lands the moment it arrives —
but **nothing surfaces that file to a watching session or human**:

- `bro agents status <ref>` prints only the log *path*;
- `bro watch` is a point snapshot by design;
- `bro serve` is JSON snapshots — no log plane.

So a live worker presents as "frozen, then — бац — everything at once"
(observed verbatim 2026-10-15). The workaround — `tail -f` the path by
hand — works but bypasses the registry's ref→path resolution, and
nobody should need `ps` to find the file.

## Design

```
bro agents log <id|step> [--follow] [--lines <N>] [--connector <name>]
```

A fourth read on the agent plane. Resolution is *exactly* `status
<arg>`'s: `collectAgentBackends` → `findInBackends` — same miss wording,
same degraded-backend warnings on stderr.

- **Replay.** Without `--follow`: print the newest `--lines` (default
  50) whole lines of `info.log` to stdout, exit 0. `--lines 0` prints
  nothing — the follow-only replay policy.
- **Follow.** With `--follow`: replay, then poll-appended reads
  (~250 ms) write new bytes to stdout until SIGINT. A `tail -F`, not
  `tail -f`:
  - *truncation* (`size < offset` — the janitor's tail-cap keeps the
    newest whole lines and drops the head): stderr `[log truncated —
    resyncing]`, re-read from 0. Lost middle bytes are reported, never
    silently skipped.
  - *disappears mid-follow* (reaped, then a respawn rewrites the same
    per-id path): one stderr note, keep polling; on reappear —
    `[log reopened]`, resume from 0. Follow tracks the *path*, because
    a respawn reuses the agentId — the watcher's interest outlives one
    process generation.
- **Missing pieces are named, never invented.** `info.log` absent →
  die `agent <id> has no recorded log` (a backend may not keep one).
  Recorded path missing on disk → die `log missing: <path> — reaped or
  never written`. A `scheme://` ref (copilot records its sessionUrl as
  `info.log`) → die `log is remote — <url>` naming the backend's own
  surface, never a filesystem error on a URL.
- **stdout carries log bytes only** — replay + appends. The one-line
  context header (`agent <id> (<state>) — <path>`) goes to stderr so
  `bro agents log x | …` pipes clean.

No `--json` — the payload is the raw log; structured consumers get the
serve plane (SSE, bro-j1kk2.3), not a second rendering here.

## Mechanics

`followLog(path, on, { pollMs, signal })` in agents.ts — offset-tracked
`fs` poll loop, returns `{ stop }`. `cmdLog` wires SIGINT → stop → exit
0. Tests drive `followLog` directly (append → data; truncate → marker +
re-dump; remove/reappear → notes) and `runAgentsCommand` for the
replay/miss/no-recorded-log paths — no in-process `-f` hang.

## Non-goals

- Following a *session* (the acp session id) rather than the agent's
  recorded path — the path is the contract.
- Supervisor-backend logs (tmux/docker) beyond `info.log` — a backend
  that keeps no file reports "no recorded log", not a fabricated tail.
