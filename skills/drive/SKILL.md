---
name: drive
description: "Use when orphaned PRs need an owner — 'drive the review loop', 'watch the PRs and fix them', a post-PR supervisor. Thin wrapper over the bro CLI: `bro review drive` polls act exit gates, spawns fixer agents through the facade, and merges on green. Requires `bro` (npx -y @broject/bro@0), bd, and the configured review-host CLI (for example, `gh` or `glab`)."
---

# /drive (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only —
the pass logic, occupancy guard, and fixer spawn live in
`packages/cli/src/commands/drive.ts`.

`bro review drive` is the write-side counterpart of `bro review watch`'s gates plane:
watch *reports* `PR #N blocked — open_threads`; drive acts on it. It
exists for the orphaned-PR gap — a convoy/loop session ends at PR-open,
and review threads that arrive afterwards have no owner.

## What a pass does

For every open PR on a fleet branch (worktree branches + local
`work/*`, `loop/*`, `stack/*` branches):

| Gate says | Occupied? | Action |
| --------- | --------- | ------ |
| `open_threads > 0` | yes | skip — the live owner works its own threads |
| `open_threads > 0` | no | spawn/respawn the PR's **fixer agent** on its fixer bead (`-l fixer`, `external_ref drive:pr:<N>`) in the PR's worktree |
| `mergeable = CONFLICTING` | yes | skip — the live owner works its own conflicts |
| `mergeable = CONFLICTING` | no | spawn the same fixer agent with a **rebase work order** — fetch + rebase onto the PR's base, resolve, `--force-with-lease` push — bounded by the `fixRounds > maxRounds` cap |
| `gate.ok` | yes | report — the owner's merge step lands it |
| `gate.ok` | no | `bro review act merge`, retire the worktree when clean, close the fixer bead |
| PR merged/closed | — | close a dangling fixer bead |

Occupancy = the agents facade + a live foreign watch marker on the PR
(a `bro flow loop` heartbeat, `act wait`, convoy — drive only owns
*unsupervised* PRs, so a live supervisor is an occupant) + the
worktree's own fresh claim marker (`<gitdir>/bro/work`, stamped by
`bro work enter`) + fresh `.work` markers + a `/proc` cwd scan that
follows a process's ancestry to an agent-shaped root — agent CLIs sit
at their launch dir while their tool shells hold the worktree cwd — or
matches a `BRO_AGENT_ID`/`AI_AGENT` env badge, which detached
descendants keep. Occupied is always the safe verdict.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro review drive [--once]` | one supervision pass (default) |
| `bro review drive --every [N]` | a pass every N seconds — runs in-process, spawn it detached (nohup/tmux/daemon); a bare `--every` uses `drive.intervalSec` |
| `bro review drive --no-merge` | supervise only — never merge (config: `drive.merge: "never"`) |
| `bro review drive --connector <name>` | spawn fixers on one backend |
| `bro review drive --json` | one JSON line per PR verdict |

Config: `drive.intervalSec` (300), `drive.merge` (`auto`|`never`).
The fixer agent's command resolves exactly like `bro fleet agents up` —
`agents.<backend>.command` → `loop.agent`.

## Policy

- **The orchestrator's pulse runs single passes.** The session-pulse
  model (bro-killn): a bounded `bro review watch --every --for` window ends →
  `bro review drive` once → digest → re-arm. `bro review drive --every` stays the
  long-lived detached supervisor when one is wanted — both `--every`
  forms refuse under `BRO_AGENT_ID` (spawned workers never arm
  cadences). No systemd/crontab installs exist — a session start rearms
  a dead pulse from `bro/pulse.json`.
- **Occupied is not an error.** A skipped PR means a live session owns
  it — report and move on; never force-spawn into someone's worktree.
- **The fixer bead is the handle.** `bro fleet agents status <bead>` shows
  the fixer, `bro fleet agents down <bead>` stops it (the fixer is a
  standalone task, not a molecule step — `bro fleet` doesn't list it).
  A dead fixer respawns on the same agentId — that is the contract.
- **Merge is the exit gate's call, not the driver's.** `bro review drive`
  never bypasses `bro review act merge` — a non-green PR is supervised, not
  forced.
