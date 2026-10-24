---
title: Restoring a rig on a fresh machine
description: A rig's durable state lives on git refs and branches — clone, bro sync --pull, bd sync through a dolt remote, bro drive install re-supervises open PRs.
---

*Everything below runs on npm `latest` (**0.2.5**) as written — the
`0.3.0` mark is the one piece not yet published. These are the flat
spellings; the grouped `bro <group> <member>` surface (`bro work sync`)
arrives with the next release.*

A bro rig is designed so the machine is disposable. What dies with it is
**processes** — the daemon, act watchers, exec shells, dolt servers —
plus **registrations** — git worktree entries, the agent registry, loop
run records — and anything never pushed. Everything else already lives
on the remote: claims, molecules, and the ready
queue are bead state synced to `refs/dolt/data`; `loop/*` and snapshot
branches are ordinary git refs; the review-debt ledger and `.agents/`
state ride `refs/bro/data`.

## Where each piece lives

| State | Location | Restored by |
| ----- | -------- | ----------- |
| Code, `loop/*` and `fix/*` branches, dirty-tree snapshot branches | `refs/heads/*` | `git clone` / `git fetch` |
| bro artifacts — review-debt ledger, drill evidence, `.agents/` state | `refs/bro/data` | `bro sync --pull` |
| Beads store — issues, claims, drill frames, molecules | `refs/dolt/data` via a dolt remote (`bd dolt remote list`) | `bd sync` |
| Operator config — providers, agent templates, global skills | outside the repo (`~/.config/bro`, `~/.agents`) | the operator's own backup — restore this first |
| Running processes + machine-local state — daemon, watchers, shells, the `bro/drive.json` install marker, act watch markers (`<git-common>/bro/watches/`), agent logs, the agent registry (`<git-common>/bro/agents.json`), git worktree registrations, loop run records (`<git-common>/bro/loop/`), stack edges (`<git-common>/bro/stack/`) | nowhere | restarted below |

## Sequence

```bash
git clone https://github.com/<org>/<repo>.git && cd <repo>
# repo bootstrap — for bro itself: npm ci && npm run build
bro sync --pull             # materializes refs/bro/data into the worktree, then runs bd sync;
                            # a remote with no data ref just prints "nothing to pull"
git fetch origin 'loop/*:loop/*' 'work/*:work/*' 'stack/*:stack/*'
                            # in-flight work as LOCAL refs — `bro drive`
                            # enumerates open PRs from local branches, and a
                            # clone's are remote-tracking only until fetched
bro drive install           # (0.3.0) re-arms the merge path and brings the supervisor up —
                            # the want-marker is machine-local, so a clone starts with none
```

`bro act rearm` is deliberately absent: it resurrects watchers
from dead markers under `<git-common>/bro/watches/` — machine-local
files a clone never carried — so on a fresh machine there is nothing to
rearm. The lost machine's open PRs get their supervision back from `bro
drive --every` instead, which discovers them from local branches, not
markers — hence the fetch step. On 0.2.5 that supervisor is
foreground-only: it drives while the command runs and installs no
durable marker — that is what `bro drive install` adds in 0.3.0. A
watch armed on a branch outside `work/`/`loop/`/`stack/` has no such
enumeration: that promise died with the machine — arm a fresh
`bro act wait <PR> --merge` if the PR still needs one.

Stack edges ride the same loss: `<git-common>/bro/stack/` maps each
`stack/<name>/<n>-<slug>` branch to the base it forked from, and a
clone carries none of it. `bro stack list`/`sync` falls back to an
open member PR's declared base, so members with a PR recover their
place in the chain — a member with no PR yet has no recorded base, so
sync reads it as already on the right base; rebase it by hand if its
parent merged in the meantime.

Then verify from the authoritative reads, not from process exits:

```bash
bd ready                  # the queue survived
bro status                # board, drill frame, fleet
git branch -r             # in-flight work survives as branches (loop/*, work/*, fix/*) —
                          # `git worktree list` shows only this clone; registrations
                          # were machine-local state
bro agents status         # starts empty — agents.json is machine-local
```

### Orphaned claims

Beads restored as `in_progress` still carry the dead machine's assignee,
and every plane that could vouch for a worker — agent registry, run
records, session markers — was machine-local, so the claim reads as
foreign: `bro work enter` reports it refused and `bro agents up`
rejects the step as claimed outside the registry. Release the claim,
materialize the surviving branch, then retake — the fetch above already
made it local:

```bash
bd list --status in_progress                     # the orphaned worklist
bd reopen <id>                                   # release the dead machine's claim
bro work enter <id> --branch loop/<id>           # resume a loop run's tree (work/<id> likewise)
bro agents up <id>                               # respawn a registry worker — claims fresh
```

Or just reopen — an open bead is claimable again, so `bro loop`
retakes it on its own.

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
