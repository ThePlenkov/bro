---
parent: bro-7xgk
scope:
  - packages/core/src/config.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/commands/watch-config.ts
  - packages/cli/src/commands/watch-install.ts
  - packages/cli/src/plugins.ts
  - skills/watch/SKILL.md
  - skills/notify/SKILL.md
---

# bro-7xgk.5 — orchestrator liveness: split the session holder from the watcher

## Problem

A session that must stay alive waiting on background work runs a
"watchdog" subagent that does three jobs in one billed agent loop: hold
the parent session alive, poll mol/gh/PR state, and write a snapshot
report. Measured on 2026-10-02 (session lying-thief, 11:00–16:00 UTC):
130 watchdog invocations against 712 requests of the session's own
traffic — at least 18% of the budget, nearer 30–40% once a tick's
sleep-and-report costs ~2–3 requests. That is 40–60 requests/hour spent
confirming that nothing changed.

The two jobs have different cost structures and should not share a
loop. Holding the parent live REQUIRES an agent — only an agent keeps a
session turn-loop alive. Polling does NOT — bro already ships it as a
zero-inference process: `bro watch --once --notify` writes into the
mailbox, and the notify connector's postTool probe delivers it into the
parent's context. Today the expensive primitive does the cheap job.

## Design

### `bro watch install|uninstall` — polling on a non-agent timer

`bro watch` gains two subcommands that own the scheduler entry so the
deployment's cadence is a real timer, not a hand-rolled crontab or a
billed subagent:

```text
bro watch install [--every N] [--print]   install the poll for this repo
bro watch uninstall                       remove it
```

The installed command is always `bro watch --once --notify` run in the
repo — one snapshot per tick, one mailbox drop per tick (`--once`
always emits; transition dedup lives in `--every`'s process and a timer
starts a fresh one each tick).

Backends, in precedence order:

- **systemd user timer** — preferred when `systemctl --user`
  answers. Two units under `$XDG_CONFIG_HOME/systemd/user` (default
  `~/.config/systemd/user`), named `bro-watch-<h8>` where `<h8>` is the
  first 8 hex of the repo's git-common-dir sha256 — per-repo units, one
  timer per repo. `bro-watch-<h8>.service` is a `Type=oneshot` unit
  with `WorkingDirectory=<repo>` and an install-time captured
  `Environment="PATH=…"` (user managers don't inherit nvm/`~/.local`
  paths); ExecStart resolves `bro` on PATH first, then
  `npx -y --prefer-offline @broject/bro@<version>` — the same fallback
  the git-hook shim bakes. `bro-watch-<h8>.timer` fires
  `OnBootSec=<N>` + `OnUnitActiveSec=<N>`. Install writes the units,
  `daemon-reload`, `enable --now`. Uninstall `disable --now`, removes
  both files, `daemon-reload`.
- **crontab** — fallback when systemd --user is absent but `crontab`
  exists. A managed line tagged `# bro-watch-<h8>`: `*/<mins> * * * *
  cd '<repo>' && PATH=<captured> bro watch --once --notify
  >/dev/null 2>&1`. Cron granularity is minutes — `intervalSec` rounds
  up to whole minutes. Reinstall replaces the tagged line; uninstall
  strips it. Entries outside the tag are never touched.
- **neither** — install refuses and prints the unit text (the `--print`
  output) so the entry can be installed by hand.

`--print` emits the artifacts the resolved backend would install
(systemd units, or the cron line) without touching anything — review
before install, and the manual path on scheduler-less hosts.

Cadence: `--every N` on install, else `watch.intervalSec` (new config
section, **default 60** — a heartbeat that probes act gates per fleet
PR is cheap for `gh`, and mailbox freshness is the point). Invalid
values fall back to the default.

Install is idempotent — identical artifacts report `already`; a changed
repo path, cadence, or CLI version rewrites in place. Install outside a
git repo refuses: `--notify` has no mailbox there, so the timer would
burn cycles into nothing.

### The holder — agent-side policy, not bro mechanics

bro cannot BE the holder — only an agent keeps a session's turn-loop
alive. The `watch` skill gains the split as policy so every session
stops re-deriving it expensively:

- The **holder** is a background subagent whose ONLY tool call is a
  sleep (~15 min cadence, was 3) — it collects no snapshot, runs no
  `bro watch`, writes no report. Its completion is the parent's wake
  boundary; the mailbox drain lands on the postTool probe right after.
- The **watcher** is `bro watch install`'s timer — zero inference per
  tick. Polling, snapshotting, and reporting all live there.
- Cost math, documented once and not re-measured per session: 3-min
  holder ≈ 40–60 req/h → 15-min holder ≈ 8–12 req/h, and the poll's
  request cost drops to zero. A shorter holder is justified only when
  measured native completion-notification latency demands it.
- **Pull semantics are stated, not implied:** a mailbox drop never
  wakes a sleeping parent — it lands in context on the next tool call.
  Removing the holder entirely requires a push path first; until then
  the holder is load-bearing, not waste.

The `notify` skill gains the same one-line pull-semantics statement —
the drain is a postTool probe, delivery is bounded by the session's own
tool cadence.

### Out of scope

`bro watch --every N --notify` detached (nohup/systemd-run) stays legal
and unchanged — install is the durable version of the same contract, not
a replacement for ad-hoc detach. No push channel (native completion
notification wiring) — that is the separate comms bead the parent
comment tracks. Holder mechanics are agent-runtime-specific; the skill
carries the contract, each runtime's subagent tool fulfils it.

## Plan

1. `watch-config.ts`: `watchSection` — `intervalSec` (default 60,
   bounded like `drive.intervalSec`); register `configKey: 'watch'` in
   plugins.ts.
2. `watch-install.ts`: unit-name hash, systemd unit text, cron line
   text, backend detection (systemctl --user → crontab → none), and
   `installWatch`/`uninstallWatch` with an injectable command runner +
   dirs so tests never touch the real scheduler.
3. `watch.ts`: `install|uninstall` subcommand dispatch ahead of flag
   parsing; plugins.ts summary gains the subcommands.
4. Skills: `watch` — install/uninstall rows + the holder/watcher split
   policy; `notify` — the pull-semantics line. `npm run gen:plugins`.
5. Docs: README watch row + site `commands/fleet.md` table.
6. Tests (`watch-install.test.ts`): unit/cron text, hash naming,
   backend precedence, install idempotency + refresh, cron
   replace/strip by tag, no-repo refusal, `--print` purity.
7. `npm test` (exact CI command).
