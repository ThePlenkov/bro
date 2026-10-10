---
name: rig
description: "Use when the rig's own bro install must stay current — 'keep the checkout fresh', a staleness check, the fetch→ff-pull→rebuild poll. Thin wrapper over the bro CLI: `bro rig sync` is the pass, `bro rig install` puts it on a scheduler. Requires `bro` (npx -y @broject/bro@0)."
---

# /rig (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Rig freshness keeps the machine's *main checkout* tracking its upstream
— agents run the `bro` built from it, so a lagging checkout means the
fleet runs stale dist. One pass: `git fetch` →
`git merge --ff-only @{upstream}` → the post-merge refresh
(install if dep manifests moved → build → hotpatch slot). The ad-hoc
setsid poller this replaces ran the same shape at a 10-minute cadence.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro rig sync [--repo <dir>]` | One freshness pass on the resolved checkout: guards (dirty → skip, no upstream/diverged → error) → fetch → ff-only merge → install→build→patch refresh. Exit 1 on error or an incomplete refresh (done-sha ≠ HEAD). |
| `bro rig status [--repo] [--json]` | Read plane, no network — branch → upstream, ahead/behind vs the stored ref, dirty count, done-sha freshness, resolved refresh steps, scheduler state |
| `bro rig watch [--every N] [--for S]` | Foreground supervisor — `rig sync` per tick, cadence `rig.intervalSec` (default 600s); `--for` bounds a session-side run |
| `bro rig install [--every N] [--print]` | The poll on a real scheduler — a `bro-rig-<h8>` systemd user timer (crontab fallback) running `rig sync`, survives reboot |
| `bro rig uninstall` | Strip the scheduled entry for the resolved repo |

## Policy

- **The target is the main checkout, never the worktree you're in.**
  Resolution: `--repo` > `rig.repo` config > the repo's *main* worktree.
  A `loop/*` scratch worktree is never the rig — `bro rig sync` typed
  inside one still freshens the checkout the rig's binaries come from.
- **Upstream is the contract.** Whatever branch the main checkout sits
  on, sync fast-forwards it to `@{upstream}`. A dirty tree is skipped
  (a human is mid-edit); a diverged one errors for a manual rebase —
  the mechanic never resolves either.
- **`rig` is the what/when, `freshness` is the how.** The refresh steps
  (install/build/patch incl. the `~/.local/share/bro-hotpatch.sh` slot)
  stay owned by the `freshness` config section — hotpatches re-apply
  after every build until their upstream lands.
- **Install, don't babysit.** `rig watch` is the setsid/debug shape —
  for a durable poll use `bro rig install` so a reboot can't orphan it
  (the lesson the ad-hoc supervisor kept re-teaching). Point-check
  `bro rig status` between turns; never sit in a foreground wait.
- **A pull drops one `rig:` mailbox event** so live sessions learn the
  binary under them changed — a session seeing that drop should expect
  dist to be rebuilt mid-flight.
