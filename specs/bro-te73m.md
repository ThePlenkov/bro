# bro-te73m — rig freshness: the rig's own checkout keeps itself current

## Problem

Agents on a rig run the `bro` built from the local main checkout
(`~/projects/bro` here). That checkout lags behind `origin/main` until a
human pulls and rebuilds: every merged PR leaves the rig's fleet running
stale dist — the exact gap that let the #383 dep-graph break burn a
supervisor for hours (bro-sovl3).

Today the gap is closed by an ad-hoc setsid script at a 10-minute
cadence (log `/tmp/bro-freshness.log`) plus the hand-installed
`~/.local/share/bro-hotpatch.sh` — both invisible to `bro agents`, dead
on reboot, and unverifiable. bro-sovl3 landed the merge-side half
(`post-merge` hook → install → build → patch); this bead lands the
polling half as a bro verb so the script dies.

## Design — `bro rig`

The mechanic is upstream-tracking, not a hardcoded repo or branch:

- **`bro rig sync [--repo <dir>]`** — one freshness pass, serialized
  under `<gitdir>/bro/rig-sync.lock`:
  1. Resolve the target: `--repo` > `rig.repo` config > the main
     worktree of the repo containing cwd (`git worktree list` first
     entry — a scratch `loop/*` worktree never becomes the target).
  2. Guards, cheapest first: not a git worktree → error; dirty tree →
     `skipped` (a human is mid-edit — never pull over uncommitted work);
     detached/no `@{upstream}` → error.
  3. `git fetch`, then `rev-list --left-right --count HEAD...@{upstream}`.
     `behind=0` → `current`; `behind>0 && ahead=0` →
     `git merge --ff-only @{upstream}`; `ahead>0 && behind>0` →
     `diverged` error (manual rebase — the mechanic never resolves).
  4. Then the bro-sovl3 refresh, unconditionally:
     `runPostMergeRefresh(repo)` — install (dep manifests moved) → build
     → patch, serialized by its own `post-merge.lock` and gated by
     `post-merge.done`. Unconditional because a killed refresh leaves
     done-sha behind HEAD — `sync` is also the healer. The installed
     git hook (when present) dispatches a worker that serializes on the
     same lock and no-ops on the done-sha; both paths converge.
  5. A pull transitions the rig — drop one mailbox event
     (`rig: pulled <old>..<new> into <repo> — refresh queued`) so live
     sessions learn the binary under them is about to change.
  6. Result is asserted from state, not the worker's say-so: done-sha
     vs HEAD after the refresh decides `synced` vs `refresh incomplete`
     (exit 1 — a failed build is a real problem, not a skipped tick).

- **`bro rig status [--repo <dir>] [--json]`** — the read plane, no
  network: resolved repo, branch → upstream, ahead/behind vs the stored
  remote-tracking ref, dirty count, done-sha vs HEAD (`fresh`/`stale`),
  resolved refresh steps (`steps`), and pulse state (`pulse`).

- **`bro rig watch [--every N] [--for S]`** — the foreground supervisor
  (the setsid script's shape, registered): `rig sync` per tick, errors
  logged per tick — a poll loop never dies on one bad fetch. Default
  cadence `rig.intervalSec` (600s), `--for` bounds a session-side run.

- **`bro rig install [--every N] [--print]` / `bro rig uninstall`** —
  arm/disarm the cadence under the session-pulse model (bro-killn —
  OS service management is outside the agent-plugin horizon, so no
  systemd unit or crontab line is ever written). `install` writes
  `<git-common>/bro/rig-pulse.json` (`{repo, everySec, armedAt}`) on
  the rig repo's common dir — the want-marker every session checkpoint
  in that repo rearms a bounded `bro rig watch --repo <r> --every N
  --for S` window from (window bound `rig.pulseSec`, floored at the
  cadence). `rig watch` holds `bro/rig-pulse.lock` for its lifetime —
  a rearmed window stands by behind the incumbent, never ticks
  concurrently — and refuses under `BRO_AGENT_ID` (the orchestrator
  owns the cadence, same guard as `bro watch --every`). `uninstall`
  removes the marker and reports a still-live pulse honestly.

## Config — `rig` section (operator layer)

```jsonc
"rig": {
  "repo": "/abs/path/to/main-checkout",   // default: current repo's main worktree
  "intervalSec": 600,                      // watch tick + installed cadence
  "pulseSec": 900                          // rearmed window bound (--for)
}
```

Machine-local by nature (repo paths, cadence) → `operator` in
`CONFIG_SECTION_LAYERS`. The freshness steps themselves
(install/build/patch incl. the hotpatch slot) stay owned by the
`freshness` section — `rig` names *what and when*, `freshness` names
*how*.

## The pulse model (revised during merge — bro-killn landed first)

The branch originally extracted `watch-install.ts`'s
systemd/crontab writers into a shared `sched.ts` engine so
`bro rig install` could ride the same backends. Main then retired
those writers project-wide (spec bro-killn): the merge drops
`sched.ts` entirely and puts `rig` on the same want-marker + rearm
mechanics the watch pulse uses — `rig-pulse.ts` mirrors
`watch-pulse.ts` with the rig's own marker/lock/spawn-record trio and
a `rig watch` spawn argv. A `rigConnector` registered beside
`watchConnector` runs the same checkpoint probes (sessionStart +
postTool) against the rig marker.

## Out of scope

- npm-registry upgrades (`npx @broject/bro@latest`) — the rig mechanic
  serves the source-checkout rig; a registry install has no checkout to
  keep fresh.
- Auto-arming install at `bro setup` — install is an explicit operator
  act; a repo must not schedule a machine poller from a cloned config.
- `post-rewrite`/`post-checkout` coverage — same as bro-sovl3.

## Acceptance

- `bro rig sync` in a repo whose main worktree is behind upstream
  fast-forwards it and runs install→build→patch (observable on the
  refresh's own output); a clean current checkout reports `current`.
- A dirty target is skipped, never pulled over; a diverged one errors.
- `bro rig install` writes `rig-pulse.json` and nothing outside the
  git dir; `--print` emits the marker payload + rearm command without
  touching anything; `uninstall` removes the marker and reports a
  live pulse rather than claiming the cadence stopped.
- An armed repo with a dead rig pulse gets a bounded `bro rig watch`
  spawned on the next session checkpoint; a live pulse, a live
  recorded spawn, or `BRO_AGENT_ID` set all stay quiet.
- A successful pull drops one `rig:` mailbox event.
