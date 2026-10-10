# bro-r6vge — stack facade: delegate stack ops to the platform

## Problem

`bro stack push|list|sync` already models the domain — an ordered chain
of `stack/<name>/<n>-<slug>` branches, each based on the member below,
optionally carrying a PR — but every forge interaction is hand-rolled
against the generic `reviews` facade: `gh pr create --base` is
hard-coded into push output, sync issues `retargetPr` calls even on
hosts that retarget natively, and nothing delegates a merge to the
platform's stack machinery.

Measured cost: merging the 3-layer sverka stack (#320→#321→#322) took
~30 min of per-layer merge-async + retarget + full CI re-runs per layer.
Both native stacks features remove most of that:

- **GitHub stacked PRs** — the platform auto-retargets dependent PRs
  *and* rebases their remote branches when the bottom merges; the
  `gh stack` extension adds `gh stack merge <pr> --yes`, an atomic
  all-or-nothing merge of the whole chain in one call.
- **GitLab stacked MRs** (19.1+) — the platform detects the chain from
  target branches alone and retargets the next MR to the default branch
  on each merge; merge is bottom-up via the existing
  `PUT merge_requests/:iid/merge`.
- **plain git** — a chain without a forge: rebase cascade and merge are
  local operations; today it is indistinguishable from "host
  unreachable".

## Design

New `stacks` facade (FacadeMap + `Connector.stacks`) — the connector's
answer to stack ops. Contract in `packages/core/src/stacks.ts`:

```ts
interface StackFacade {
  /** The command that opens a review for a member — push's hint line.
   *  Undefined → this host has no review surface (plain git). */
  openHint?(m: { branch: string; base: string }): string | undefined

  /** What the platform already did above a merged member, probed per
   *  member (GitHub: only when the PR carried `.stack`; GitLab: always;
   *  git/unknown: nothing). Absent → `{false,false}` = manual. */
  cascade?(m: { branch: string; pr?: number }): { retarget: boolean; rebase: boolean }

  /** Merge the whole chain bottom→top — one host call where the
   *  platform has it, else undefined → the caller's per-layer merge. */
  mergeChain?(members: StackChainMember[], opts): { lines: string[]; merged: string[] } | undefined
}
```

Connectors:

- **git** (`gitConnector`, built-in like `beadsConnector`) — `matchDir`
  claims any git dir that no forge remote claimed; `mergeChain` merges
  each member into the trunk in the main worktree; no hints, manual
  cascade.
- **github** — `openHint` is today's `gh pr create --base`; `cascade`
  probes the member PR's `.stack` field (same read `mergePr` uses);
  `mergeChain` uses `gh stack merge <top-pr> --yes` when the extension
  is installed, `undefined` otherwise → per-layer `mergePr`
  (merge-async handles stack members — bro-h07vx).
- **gitlab** — `openHint` is `glab mr create --target-branch`;
  `cascade` reports platform-owned retarget only on ≥19.1 hosts (probed
  via `glab api version`, cached per facade — older hosts and failed
  probes answer manual and sync drives `retargetPr`); no `mergeChain` →
  the per-layer fallback is the platform flow (bottom-up `PUT …/merge`,
  `should_remove_source_branch` triggers the auto-retarget).

Consumers in `packages/cli/src/commands/stack.ts`:

- **push** — the "open the PR" hint comes from `openHint` instead of a
  hard-coded `gh` command.
- **sync** — per member, `cascade()` decides the complement: retarget
  is skipped when the platform owns it; a platform-rebased remote
  branch means the local step is `fetch` + `git rebase FETCH_HEAD`
  (replay local-only commits onto the rewritten remote), never a
  force-push over the platform's rebase.
- **`bro stack merge <name> [--squash|--merge|--rebase] [--admin]`** —
  new verb. The merge set is the contiguous prefix of live members with
  an OPEN PR (a PR-less member breaks the chain — above it nothing can
  land on the trunk). Every member's act gate must be green, then:
  `mergeChain` → atomic host call; absent/refused → per-layer
  `mergePr` with a verify-retarget of the next member between merges
  (`PUT target_branch` / `pr edit --base` is a no-op when the platform
  already moved it). Post-merge `stack sync` retires merged members.

Per-layer correctness under platform rebase (GitHub `.stack` members):
the remote head moves server-side after each merge, so the fallback
re-reads `prMeta` before each layer and waits briefly for a `.stack`
member's headSha to change — a stale pin fails closed, and the rerun
converges.

The merge slot (`bd merge-slot`) wraps gate + merge, same as
`bro act merge` — merging through bro never bypasses a BLOCKED gate.

## Non-goals

- `gh stack submit` / local gh-stack metadata adoption — the extension
  tracks its own stacks; bro's chain joins the *platform* stack by base
  chaining alone, so only `merge` (a purely remote op given a PR
  number) is delegable. Submit stays per-member `pr create --base`.
- `bro stack submit` / reorder / unstack verbs — the bead's scope is
  delegating the ops bro already performs.
- Changing the loop's per-bead merge flow — `loop --stack` still lands
  one bead's PR at a time; it inherits the cheaper sync cascade for
  free.
- Remote branch litter after merges — existing behavior, tracked
  separately (bro-co9nj domain).

## Plan

- [x] `specs/bro-r6vge.md` — this spec
- [x] `packages/core/src/stacks.ts` — `StackFacade` contract,
      `StackChainMember`, `mergeChainPerLayer` fallback helper
- [x] `packages/core/src/connectors.ts` — `stacks` in FacadeMap +
      `Connector.stacks`, `gitConnector` built-in, `stackHost()`
      resolver
- [x] `packages/github/src/stacks.ts` — extension-detect,
      `gh stack merge` atomic path, `.stack` cascade probe
- [x] `packages/gitlab/src/stacks.ts` — platform cascade + hint
- [x] `packages/cli/src/commands/stack.ts` — hint dispatch, sync
      cascade, `stack merge`
- [x] tests — core (git mergeChain + per-layer), github stacks
      (extension present/absent, cascade probe), gitlab, stack e2e
- [x] docs — `skills/stack/SKILL.md`, `site/content/docs/commands/stack.md`
