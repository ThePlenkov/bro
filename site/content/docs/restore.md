---
title: Restoring a rig on a fresh machine
description: A rig's durable state lives on git refs and branches — clone, bro work sync --pull, bd sync through a dolt remote, bro fleet daemon up, bro review act rearm.
---

A bro rig is designed so the machine is disposable. What dies with it is
**processes** — the daemon, act watchers, exec shells, dolt servers —
plus anything never pushed. Everything else already lives on the remote:
claims, worktree records, molecules, and the ready
queue are bead state synced to `refs/dolt/data`; `loop/*` and snapshot
branches are ordinary git refs; the review-debt ledger and `.agents/`
state ride `refs/bro/data`.

## Where each piece lives

| State | Location | Restored by |
| ----- | -------- | ----------- |
| Code, `loop/*` and `fix/*` branches, dirty-tree snapshot branches | `refs/heads/*` | `git clone` / `git fetch` |
| bro artifacts — review-debt ledger, drill evidence, `.agents/` state | `refs/bro/data` | `bro work sync --pull` |
| Beads store — issues, claims, drill frames, molecules | `refs/dolt/data` via a dolt remote (`bd dolt remote list`) | `bd sync` |
| Operator config — providers, agent templates, global skills | outside the repo (`~/.config/bro`, `~/.agents`) | the operator's own backup — restore this first |
| Running processes + machine-local state — daemon, watchers, shells, the `bro/drive.json` install marker, agent logs, the agent registry (`<git-common>/bro/agents.json`) | nowhere | restarted below |

## Sequence

```bash
git clone https://github.com/<org>/<repo>.git && cd <repo>
# repo bootstrap — for bro itself: npm ci && npm run build
bro work sync --pull        # materializes refs/bro/data into the worktree, then runs bd sync
bro review drive install    # re-arms the merge path and brings the supervisor up — the
                            # want-marker is machine-local, so a clone starts with none
bro review act rearm        # resurrect dead PR watch markers (re-arms, never duplicates)
```

Then verify from the authoritative reads, not from process exits:

```bash
bd ready                  # the queue survived
bro fleet status          # board, drill frame, fleet
git worktree list         # worktree records survived — check each for uncommitted work
bro fleet agents status   # starts empty — agents.json is machine-local; `bd list --status in_progress` is the respawn worklist (`bro work enter <step>` + `bro fleet agents up <step>`)
```

### When `bd sync` cannot authenticate

Dolt's git client does not use the `gh` credential helper or
`~/.git-credentials`, so a `git+https://` dolt remote is dead on machines
whose GitHub auth lives in `gh`. Route the store through a local mirror:

```bash
git clone --mirror https://github.com/<org>/<repo>.git /tmp/<repo>.git
bd dolt remote add file git+file:///tmp/<repo>.git
bd dolt pull --remote file      # first pull
bd sync --remote file           # pull+push thereafter
```

A `--mirror` clone carries `refs/dolt/data`; refresh it before each sync
with `git -C /tmp/<repo>.git fetch origin`. After dolt pushes into the
mirror, publish with `git -C /tmp/<repo>.git push origin refs/dolt/data`.
Peer rigs keep their beads on their own `refs/dolt/data` (often a
dedicated `*-beads` repo) — repeat the mirror step per store.

### Snapshot branches

Evacuations push dirty worktrees as snapshot branches (e.g. `evac/*`),
merge state included. None are needed for the rig to run — restore one
only when the work it captured matters:

```bash
git fetch origin '<prefix>/*:<prefix>/*'   # e.g. 'evac/*:evac/*'
git worktree add ../<repo>-<name> <branch>
```
