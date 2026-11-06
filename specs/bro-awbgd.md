# bro-awbgd — the stack cascade must see the base's HEAD, not its name

A stacked chain is only a chain while every member carries the member
below it. `bro stack sync` decides that from the base's NAME: the
member's recorded edge (or its PR's declared base) against the branch
it should stand on. The names match long after the commits stop
matching — and then the chain is broken in the one way that matters,
while the tool reports "in sync".

The router stack showed it. A fix landed on layer 3
(`stack/router/3-tool-use`); layer 4 stood on the OLD layer-3 tip.
`bro stack sync router` said nothing about layer 4, the chain kept the
old head, and the operator had to rebase the chain by hand — the work
the stack machinery exists to do.

Three things had to change. The plan now reads the base's HEAD; the
chain's ROOT is the chain's own; and the fork a rebase starts from is
patch-aware, so a rewritten parent does not replay its old commits. The
fourth is not a bug but a missing job: the chain registers ITSELF with
the host, so nobody adds the PRs to the stack by hand.

## The plan reads the base's head

`SyncMemberInput` carries one new fact: `containsBaseHead` — does the
member's branch still carry the head of the branch it stands on? The
CLI answers it with `git merge-base --is-ancestor <base head> <member
head>`; the pure planner in `@broject/stack` reads the flag and
schedules a rebase when it is false. A head that cannot be read reads
as "carries": an unknown truth never schedules a rewrite.

The base's NAME still decides the retarget — a PR whose base branch
changed is a different thing from a base branch whose commits changed.

## The chain's root is the chain's own

`planSync` started every chain at the default branch. A chain that
roots on something else — the router's arc roots on its own PR
(`feat/router-routes`), because the arc's code exists only there — was
planned onto `main`: the root member read as "retarget me". The root
is now the first member's own base (its PR's declared base, else its
recorded edge, else the default), and the plan follows it.

## The fork is patch-aware

A parent rewritten under its child leaves the child holding the
parent's OLD commits: same patches, new ids. The plain merge-base is
then the parent's old ROOT, and a rebase from there replays the
parent's old commits on top of the new parent — the same changes
twice, and a conflict at every file both touched.

The fork is the child's last commit the new base already holds — by
patch, which is how a rewritten parent looks to git (`git cherry`).
The parent's old commits drop out of the replay; the child's own work
lands on the new parent. The router stack needed exactly this: layer 4
forked at the old layer-3 tip and replayed its own four commits.

A patch-equivalent rewrite is not the only way a parent moves. An
amend that ADDS a file changes the parent's content, and no commit of
the child is patch-equivalent to anything in the new parent — the
`git cherry` answer is empty, and the merge-base would send the
parent's old commits back into the replay. That replay is not a
conflict but a duplicate: the parent's code lands twice, in two
copies, and the file stops compiling.

So the fork is asked in three ways, in order of how well they know the
truth:

1. **git's own fork point** — `git merge-base --fork-point <base>
   HEAD` reads the base's REFLOG and answers exactly: the tip the
   child was built on. It knows the truth even when the rewrite
   changed the content.
2. **the patch-equivalent commit** — `git cherry` — the rewritten
   parent looks patch-equivalent to git.
3. **the merge-base** — the blunt answer, and the one that replays the
   parent's old commits when nothing better is known.

The platform's own rewrite still wins where it happens: a merge makes
the platform rewrite the child, and `followRemote` keeps that path.

## The chain registers itself

A member's PR is opened by the worker (`gh pr create`), not by bro — so
the chain's registration had no owner. The operator added the PRs to the
host's stack by hand, one page at a time; the stack machinery existed and
nobody called it.

The post-tool hook already watches for the very command that creates the
PR. The moment it lands, bro registers the chain: a detached
`bro stack publish <name>`, unref'd, so the hook never waits for it.
Registration is idempotent (`gh stack link` grows the chain, a re-run
reads back as "already published") and it mutates no branch.

The cascade stays explicit. A rebase rewrites the branch a live session
may be working in — the occupancy plane owns that decision, not a hook.
`bro stack sync` is the verb for it; the hook only registers.

## Non-goals

- **Not a merge policy.** The cascade still never merges; the act gate
  owns that.
- **Not a rewrite of the branch the operator pushed elsewhere.** The
  fork reads the worktree's history — the branch bro owns.
- **Not a plan change for the retarget.** A renamed base is still a
  retarget; only a moved head is a rebase.

## Verify

- `packages/stack`: the planner schedules a rebase for a member whose
  base head moved, and stays quiet when the head is unknown.
- `packages/cli`: the fork point of a rewritten parent is the child's
  own last commit (patch-aware), and the plain merge-base when the
  base's tip is already inside the child.
- `packages/cli`: a member's PR — the hook sees the `gh pr create` —
  registers the chain with the host; a PR outside a chain registers
  nothing.
- The router stack, live: `bro stack sync router` rebase layer 4 onto
  the rewritten layer 3 and keeps the chain's base==prev-head invariant
  proven — the operator's hands stay off.
