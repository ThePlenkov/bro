# bro-sovl3 — post-merge freshness: install the dep graph before build

## Problem

A merged PR that adds a dependency (real case: #383 added
`@broject/linear`) leaves every rig checkout one `git pull` away from a
broken dist: the pull→build path rebuilt `packages/*/dist` against a
`node_modules` the new package was never installed into. Every spawned
`bro` then died on `ERR_MODULE_NOT_FOUND` in under a second, and the
loop supervisor respawned into the crash — exit 1, same second, every
cycle, burning silently.

The local patch (`~/projects/bro/.git/hooks/post-merge` + the setsid
freshness supervisor from bro-te73m) proved the fix: when
`ORIG_HEAD..HEAD` touched `package*.json`, run `npm install` **before**
`npm run build`. This bead lands that ordering as a bro mechanic — pull
must mean install → build → patch, not build alone.

## Design

A third bro git hook: **`post-merge`**, riding the same chained-shim
install `prepare-commit-msg` and `reference-transaction` use
(`bro hooks install`, shared `<git-common>/hooks` so one install covers
every linked worktree; a pre-existing `post-merge` is renamed `.local`
and rides inside the shim, its veto kept).

The shim calls `bro hooks post-merge`, which is a **dispatcher**, not
the worker — a hook may never stall `git pull`:

1. Gate: skip trees without `package.json` or `node_modules` (fresh
   worktrees bootstrap first; non-node repos no-op).
2. Append a dispatch line to the log and spawn a detached
   `bro hooks post-merge-run` (same node + same entry script —
   `process.execPath`/`argv[1]`), stdout/stderr appended to
   `<worktree-gitdir>/bro/post-merge.log`. Exit 0 immediately.

`post-merge-run` is the **worker** — it does the whole refresh under
`<worktree-gitdir>/bro/post-merge.lock` (`withFileLock`), so merges in
quick succession serialize instead of racing `npm install` against
`npm install`:

- Loop until done: read `HEAD`; if it equals the recorded
  `post-merge.done` sha, stop.
- Base = the recorded done-sha when it still resolves, else
  `ORIG_HEAD`, else none.
- **install** runs when `git diff --name-only <base>..HEAD` touched a
  dep manifest at any depth — `package.json`, `package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `yarn.lock`, `.yarnrc.yml`, `bun.lock`, `bun.lockb` — or when no base
  resolves (first run: prove the path works). Package manager is
  detected by lockfile: pnpm-lock → `pnpm install`, yarn.lock →
  `yarn install`, bun.lock* → `bun install`, else
  `npm install --no-audit --no-fund`.
- **build** runs when the repo defines `scripts.build`:
  `<pm> run build`.
- **patch** is the machine-local slot (the hotpatch contract from
  bro-te73m): first executable of `$XDG_DATA_HOME/bro/hotpatch.sh`,
  `~/.local/share/bro-hotpatch.sh`.
- `install && build && patch` is a chain — a failed step stops the
  pipeline and `post-merge.done` is NOT advanced, so the next merge
  retries the whole gap. Building on a failed install is the bug this
  bead kills. On success, write `post-merge.done` = `HEAD`.

Because the done-sha is recorded per worktree gitdir
(`--git-dir`, not `--git-common-dir`), each worktree tracks its own
refreshed head; the state dies with `git worktree remove`.

### Config — `freshness` section

```json
"freshness": {
  "install": "npm install --no-audit --no-fund",  // string | false
  "build": "npm run build",                        // string | false
  "patch": "bash /path/to/hotpatch.sh"             // string | false
}
```

Absent = auto (detections above); a string replaces the step; `false`
disables it. Registered on the `hooks` plugin (`configKey:
'freshness'`); unlisted in `CONFIG_SECTION_LAYERS` — install/build are
project policy while `patch` is operator-machine, so the section is
mixed/neutral like `mesh`.

## Loop: fast-exit is a crash, not a verdict

`bro loop`'s no-PR path reopened the bead on any agent exit —
`claim → spawn → exit 1 in <1s → reopen → reclaim` burned forever when
the spawned tree itself was broken. A spawn that ends in under
`loop.crashExitMs` (default 10s) without a PR and without a `bd close`
verdict never ran: that's environment, not work. `pushItem` now
**parks** such a bead (loud note, worktree kept) instead of reopening —
the claim drains the queue once instead of burning a supervisor cycle
per crash. `crashExitMs: 0` restores the legacy reopen-always path.
Fix/rebase rounds stay as-is: already bounded by `loop.fixRounds`.

## Out of scope

- The polling supervisor itself (fetch → pull → refresh on a cadence,
  hotpatch re-apply until upstream lands) is bro-te73m — this bead is
  the merge-side half it will call.
- `post-rewrite`/`post-checkout` coverage (`git pull --rebase`,
  branch hops) — follow-up; the worker's done-sha loop already
  self-heals on the next post-merge.

## Acceptance

- `bro hooks install` writes `post-merge` (chaining a foreign hook to
  `.local`); `uninstall` removes it and restores the chain.
- A merge that touches `package*.json` runs install **before** build —
  ordering observable in `post-merge.log`; a merge that doesn't skips
  install entirely.
- A failed install never builds and never advances the done-sha.
- A loop agent gone in <10s with no PR and no verdict parks the bead —
  no silent respawn-burn.
