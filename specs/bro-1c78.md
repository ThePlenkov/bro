# bro-1c78 — bro agents/sync clobber shared worktree git state

## Problem

Sessions sharing a git common dir (the main checkout plus every
`bro work enter` linked worktree) share one ref namespace. Parallel
bro-spawned sessions — and anything else with repo access — ran
`git reset --hard origin/<branch>` in the wrong checkout:

- a session's own branch reset to the remote tip seconds after it
  committed — local commits orphaned mid-flight;
- `main` in the primary checkout reset onto a feature branch's tip
  (observed: ahead 2/behind 2 skew on the default branch).

sverka's `main` reflog shows the exact shape:
`reset: moving to origin/work/spec-saas-directions` followed by
`reset: moving to origin/main`. Prompts already tell agents not to do
this — it kept happening. Instructions are advisory; a shared common
dir needs a fence, not a rule.

## Design

A **`reference-transaction` git hook** (git ≥ 2.36) owned by bro's hook
system — installed into `<git-common>/hooks/` (or `core.hooksPath`),
the same place the `prepare-commit-msg` provenance shim lives. One
install covers every linked worktree and every actor: bro-spawned
agents, other CLIs, humans, `bd` — the ref namespace is shared, so the
guard is too.

### The rule

On the `prepared` phase, for each stdin update
`<old> <new> <refname>`:

1. Only `refs/heads/*` updates are judged — remote-tracking, stash,
   tags, `ORIG_HEAD`, `HEAD` symrefs, `AUTO_MERGE`, `refs/bro/data`
   all pass untouched.
2. Deletes (`new = 0`) and same-oid writes pass. Deletes keep git's own
   checks (checked-out branches are already locked; `git branch -D` is
   explicit force). A recorded `old = 0` is NOT trusted as a create:
   unverified writes — `update-ref` without an old arg, `git branch -f`,
   `git switch -C`, forced fetch refspecs — report `0` even for refs
   that exist, because git only logs the old it verified. At `prepared`
   time the on-disk ref still holds the pre-transaction value, so the
   guard resolves it (`rev-parse --verify`); only a ref that truly does
   not exist counts as a create.
3. Fast-forward moves (`old` is ancestor of `new`,
   `merge-base --is-ancestor`) always pass — pulls, merges, and even a
   `git reset` that only advances the branch.
4. **Non-fast-forward moves are judged by the invoking verb** — the
   argv of the git process that fired the hook, read from
   `/proc/<ppid>/cmdline` (the shim passes `$PPID`, its own parent, as
   an argument; no /proc → see failure policy):

   | verb class | verbs | verdict |
   | --- | --- | --- |
   | content producers | `commit` (incl. `--amend`), `merge`, `pull`, `rebase`, `cherry-pick`, `revert`, `am`, `apply`, `stash`, `bisect` | allow |
   | ref movers | `reset`, `fetch`, `update-ref`, `branch`, `checkout`, `switch`, `clone`, `init`, `worktree`, `remote`, `tag` | **veto** |
   | unknown | any verb not in the allow set | **veto** |

   Porcelain internals resolve themselves: `git pull` writes the branch
   ref from an inner `git merge`/`git rebase` process — the parent
   argv IS that inner verb, so ff pulls and rebase pulls stay legal
   without a `pull` special case. `git -C <dir>` / `-c k=v` /
   `--git-dir=` global flags are skipped to reach the subcommand;
   `git-<verb>` dashed builtins strip the prefix.

   Rationale: non-ff rewrites are only legitimate when a content verb
   produced them (amend, rebase). A ref mover producing a non-ff heads
   update is exactly the clobber signature — `reset --hard` to a remote
   tip, `fetch +x:refs/heads/y`, `update-ref`, `branch -f`,
   `checkout -B`, `switch -C` — regardless of which worktree ran it or
   which worktree owns the branch. Ownership can't be policed (`-C`
   makes any worktree the invoker); the destructive *shape* is what is
   forbidden.

5. Escape hatch: `BRO_REF_GUARD=off` in the invoking environment
   passes everything — deliberate human intent is an env away, never
   an interactive prompt (hooks can't prompt).

6. **Failure policy — asymmetrical by design.** The veto path exits
   non-zero with an stderr explanation naming the verb and the ref;
   every internal error (unreadable cmdline, failed `merge-base`,
   missing git) exits 0. A broken guard reverts to today's behavior;
   it must never wedge a repo's git operations.

### The veto message

Names the verb, the ref, and old→new — and reminds that on a vetoed
`reset --hard` the worktree may already be reset (`git status`
inspects; the commit is safe because the ref never moved). Escape
hatch documented inline.

### Limitations (accepted)

- `reset --hard` updates index+worktree *before* the ref transaction,
  so a veto still leaves a staged "everything changed" tree — but the
  branch ref and its commits are intact, making recovery `git restore
  --staged --worktree .` instead of a reflog dig. The loud refusal is
  the fix for the reported data loss; worktree half-state is a
  documented residual.
- libgit2 clients (some IDE plugins) don't run git hooks — guard only
  covers the `git` binary surface, which is what bro and agent CLIs use.
- No `/proc` (macOS): cmdline unreadable → verb resolves "no data" →
  allow. The guard is strictly additive where it can see the invoker.

### Install/uninstall — rides the existing shim machinery

- `bro hooks install` writes **both** shims (provenance + refguard);
  `bro hooks uninstall` removes both; `bro setup` installs both —
  same chain convention: a pre-existing `reference-transaction` is
  renamed `.local`, runs first inside the shim, keeps its veto.
- The shim fast-paths before spawning `bro`: `$1 != prepared` →
  exit 0; no `refs/heads/` line in buffered stdin → exit 0 — remote
  fetches, stash writes, `AUTO_MERGE` noise never pay a node spawn.
- `bro hooks reference-transaction prepared <ppid>` is the argv entry
  (git-hook dispatch beside `prepare-commit-msg`, before the
  stdin-payload path).

## Plan

- [ ] `packages/cli/src/commands/refguard.ts` — stdin update parse,
      ff check via `gitTry merge-base --is-ancestor`, parent-cmdline
      verb resolution (`/proc/<ppid>/cmdline`, argv0 basename +
      global-flag skipping), verdict matrix, shim template
- [ ] `packages/cli/src/commands/githooks.ts` — generalize the
      chained-shim install/uninstall so both hook names share it
      (`.local` chain, BRO_HOOK_MARK per name, idempotent re-install)
- [ ] `packages/cli/src/commands/hooks.ts` — dispatch
      `reference-transaction` before the stdin-payload path
- [ ] `packages/cli/src/commands/setup.ts` — install both hooks
- [ ] tests: `refguard.test.ts` unit matrix (verbs × ff shapes, creates/
      deletes/skips, env-off, unreadable cmdline) + e2e in a real repo:
      `reset --hard` vetoed with ref intact, `commit --amend` and
      `rebase` pass, `fetch +x:refs/heads/y` vetoed, `update-ref` vetoed
- [ ] docs line in the work skill's policy (one line: shared repos
      fence non-ff branch moves by verb)
