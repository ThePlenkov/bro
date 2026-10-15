---
scope:
  - packages/cli/src/commands/pulse.ts
  - packages/cli/src/commands/pulse.test.ts
  - packages/cli/src/commands/pulse.e2e.test.ts
  - packages/cli/src/commands/watch.ts
  - packages/cli/src/plugins.ts
  - skills/pulse/SKILL.md
  - skills/watch/SKILL.md
  - site/content/docs/commands/fleet.md
---

# bro-ijffz — `bro pulse` + `/pulse`: the session-owned metronome

## Problem

The session watchdog needs a **wake channel**, and the only one this
harness family actually delivers is the mailbox: a detached/background
child's *exit* reaches no one (verified — a finished exec-shell child
produces no agent wake), while notify drops arrive between the agent's
tool calls. Any one-shot/relay design ("wait, tick, exit; the session
reacts to the exit") is dead on arrival — no wake-on-exit exists.

`bro watch --every N --for S --notify` (bro-killn) carries the cadence
today, but as the session-facing form it has two problems:

1. **Two knobs where the session wants one.** `--every` × `--for`
   bundles a cadence and a window bound; the session-facing ask is
   "tick every S, forever — the ticks are my wakes".
2. **The standby path is silent.** `watch --every` serializes on
   `pulse.lock` via `awaitFileLock` — a contender behind a live
   incumbent *stands by*: no ticks, no bound on the wait (observed:
   an interim `watch --every 60 --for 60` under a held lock printed
   "standing by" for 9+ minutes past its `--for`). A watchdog that can
   go silent while looking alive is worse than none — silence must
   mean *dead*, never *waiting*.

The model the bead names: **the pulse is a continuous mailer the
session owns — ticks are the wakes.**

## Design

```
bro pulse [S] [--notify|--no-notify] [--json] [-- <cmd>…]
```

A long-lived child: every S seconds it ticks — prints the tick to
stdout and, as `pulse.lock` holder, drops it into the session mailbox.
Each mail = one wake for the session.

- **S** — the tick cadence, positional, seconds. Default:
  `watch.intervalSec` (60). Bounds: `MIN/MAX_INTERVAL_SEC` (a
  sub-floor pulse is a busy loop; >2^31-1 ms clamps to ~1 ms). First
  tick on entry, then every S — a session that just armed it wants the
  first beat now.
- **`pulse.lock` arbitrates the MAILER role only — never the tick.**
  The pulse try-acquires the lock (zero wait budget, heartbeated for
  the hold's lifetime) and re-tries each tick. The holder mails every
  tick; a non-holder still prints every tick — visible liveness in the
  exec-shell log — but never mails. One mailer per repo, no standby
  silence: a live incumbent's contender looks alive *because it is*,
  ticking without mailing, and takes the mailer role over the moment
  the incumbent's hold dies.
- **Silence = dead pulse.** The pulse mails every tick, quiet
  snapshot or not — a deduped-away beat would make "stopped mailing"
  ambiguous between "nothing changed" and "crashed". Transition-only
  mailing stays `bro watch --notify`'s contract. The recovery leg is
  unchanged: `pulse.json` want-marker + `pulseRearm`/`spawnPulse`
  checkpoint (`bro watch --every --for --notify`, spawned detached)
  rearms the cadence when the lock holder dies.
- **`pulse.json` is written/refreshed on start** (`armPulse(dir, S)`) —
  the durable want-marker; the session's pulse IS the armed cadence,
  and the marker carries the session's last S for the fallback
  respawn. Disarm is `bro watch uninstall`.
- **Orchestrator-only.** `BRO_AGENT_ID` set → exit 2
  (`isOrchestratorSession` — the same predicate as the `orchestrator`
  mailbox address). A spawned worker must never arm a cadence —
  recursive watchers are the chaos the guard exists for.
- **The tick.** Default: one watch tick — the shared `tickOnce(dir)`
  (janitor reap + `collectSnapshot` + `renderSnapshot`), the heartbeat
  file refreshed (`writeHeartbeat`, best-effort), the rendered text on
  stdout. `-- <cmd>…` ticks that instead: each beat runs the command,
  echoes stdout/stderr verbatim, and the mailed drop names the command
  and its exit code. A failing `--` command never kills the metronome
  — the failure IS the beat's content.
- **`--notify`** is default ON — the pulse's whole purpose is the wake
  channel; `--no-notify` is the local-metronome opt-out (stdout liveness
  only). Outside a repo there is no mailbox — an explicit `--notify`
  warns once, the pulse still ticks.
- **Usable anywhere.** Outside a git repo there is no marker to write,
  no lock to hold, no mailbox — the warnings say so once and the
  metronome still beats; the snapshot degrades per-plane as it does
  for `bro watch`.
- **`--json`** changes stdout only: snapshot mode prints the
  `WatchSnapshot` plus `pulse: {sec, mailing}` per tick; cmd mode
  prints `{ts, sec, cmd, code, stdout, stderr, mailing}` per tick.
  Mail always carries the text form — drops land in prose context.
- **Exit paths are signals** — the session kills the child to stop the
  cadence; the process-exit lock release frees the mailer role for the
  next contender or the checkpoint respawn.

### What the pulse is not

- Not a one-shot, not a relay — the exit is not an event anyone can
  see; the mail is.
- Not the fallback — the spawned `bro watch --every N --for S
  --notify` stays the *unattended* leg (`pulseRearm` + `spawnPulse`):
  it keeps ticking across quiet stretches with no session events at
  all, which a session-owned child can't.
- Never armed inside a spawned worker (CLI refuses), never a
  hand-rolled `while`/`sleep` loop, never a per-tick `spawn` — the
  beat is one `bro` command, one child.
- The session-side policy lives in `skills/pulse/SKILL.md`: `bro pulse
  <S>` as a visible exec-background child; each arriving mail is a
  wake → glance (quiet = free, transition = point-check the named
  plane: `bro status` / `bro review watch --once` / the loop shell /
  `bro review act status`) → act. Stop when the user stops it or the
  exit gate is green.

## Plan

1. `watch.ts`: extract `tickOnce(dir)` — janitor reap + snapshot +
   render — from `runWatchCommand`'s tick body (behavior identical).
2. `pulse.ts` (new): `pulseArgs` (S positional, `--notify`/`--no-notify`,
   `--json`, `-- <cmd>` split, strict flags) + `runPulseCommand`
   (guard → arm marker → tick loop: try-lock → tick → print → mail →
   sleep S).
3. `plugins.ts`: `pulse` plugin (group `fleet`, skill `pulse`).
4. `skills/pulse/SKILL.md`: the policy half above.
5. Docs: `watch` SKILL.md names `bro pulse` as the session-facing
   cadence (the `--every --for` window stays as the spawned
   fallback); `site/content/docs/commands/fleet.md` gains the row.
6. Tests: `pulse.test.ts` (args, mailer-role try-lock, tick text) +
   `pulse.e2e.test.ts` (spawned CLI: ticks print + mail, marker
   written, `BRO_AGENT_ID` refusal, `--` echo, second pulse ticks
   without mailing, outside-repo degradation).

## Acceptance

- `bro pulse 0.5` in a repo: first tick prints at once, repeats ~0.5 s;
  `pulse.json` armed; the process holds `pulse.lock` heartbeated; a
  second session's mailbox receives every tick while it lives.
- `BRO_AGENT_ID=x bro pulse 5` exits 2 with the orchestrator error.
- `bro pulse 0.5 -- echo hi` prints `hi` per beat and keeps beating if
  the command fails — the metronome never dies on its probe.
- A second `bro pulse` while one holds the lock ticks on stdout and
  mails nothing; when the first dies, it acquires the mailer role on a
  later tick without ever having gone silent.
- `bro pulse` outside a repo ticks and warns, exit-by-signal only —
  pure metronome, no repo state touched.
- `bro --help` lists `pulse`; `bro fleet pulse` dispatches it.
