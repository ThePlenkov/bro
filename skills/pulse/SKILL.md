---
name: pulse
description: "Use when a session needs its own watchdog cadence — 'arm the pulse', 'wake me every N', keeping an eye on long-running fleet/loop/convoy work without blind infinite waits. Thin wrapper over the bro CLI: `bro pulse <S>` is the session-owned metronome — every S seconds it ticks and drops the beat into the mailbox, which is what actually reaches the session mid-turn. Requires `bro` (npx -y @broject/bro@0)."
---

# /pulse (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — the
metronome mechanics live in `bro pulse`, the snapshot shape in
`bro review watch`.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro pulse [S]` | The session metronome — a long-lived child: beats every S seconds (default `watch.intervalSec`, 60), prints each tick, and drops it into the mailbox as the `pulse.lock` holder. The mail IS the wake: a background child's exit reaches no one, so the tick's drop is the only channel that lands mid-turn |
| `bro pulse [S] --no-notify` | Stdout liveness only — no mailbox drops (default is `--notify`) |
| `bro pulse [S] --json` | One structured object per beat — `{ts, …snapshot, pulse:{sec,mailing}}`, or `{ts,sec,cmd,code,stdout,stderr,mailing}` for a probe |
| `bro pulse [S] -- <cmd>…` | The tick is `<cmd>` instead of the watch snapshot — stdout/stderr echoed verbatim; a failing probe is beat content, never a kill |

## Policy

- **Arm it in a visible background shell — then let go.** `bro pulse
  60` in an exec-background shell; each mailbox drop lands in context
  on your next tool call. Never sit in a foreground poll, never a
  hand-rolled `while sleep` — the beat is one `bro` command, one
  child, continuous ticks.
- **On each drop: digest, don't babysit.** Look at what matters NOW —
  `bro status`, `bro review watch --once`, the loop shell's output, act
  gates — post the digest, get on with the turn. The pulse keeps
  beating whether you look or not; silence in your mailbox is the
  alarm (a dead pulse drops nothing).
- **Only orchestrators pulse.** Sessions with `BRO_AGENT_ID` set —
  spawned workers — get refused (exit 2). A worker never arms its own
  cadence: recursive watchers are the chaos the guard prevents.
- **One mailer per repo, no silent pulses.** `pulse.lock` arbitrates
  who mails — never who ticks. A second `bro pulse` prints every beat
  (visible liveness) and mails nothing while the incumbent lives; it
  takes the role over the moment the incumbent dies. There is no
  'standing by' silence.
- **`pulse.json` is the durable want.** Every start rewrites
  `<git-common>/bro/pulse.json` — the marker a session-start nudge
  reads: armed but no live lock → rearm the unattended leg (`bro
  review watch --every S --for S --notify`, the bounded fallback for
  when no session is attending). `bro review watch uninstall` disarms.
- **Usable anywhere.** Outside a repo there is no marker, no lock, no
  mailbox — the warning says so once and the metronome still beats on
  stdout. A pure timer with an optional point-check.
- **Stop it by killing it.** The pulse runs until the shell is
  killed — it never exits on its own. Disarming the marker
  (`uninstall`) stops future rearm, not the live child.
- **Report progress in words, not IDs.** Same rule as `/watch` — a
  digest says what an agent is *doing* and what *landed*, never bare
  mol/bead/PR IDs.
