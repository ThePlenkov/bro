# bro-3xeav — the cascade's fork point must be a SHA, not a branch that moved

## Problem

`bro stack sync` rebases every member onto its base with
`git rebase --onto <base> <fork>`. The fork is where the member's replay
starts — and the replay must carry the member's OWN commits and nothing
else. The parent's old commits replayed on top of the new base are the
whole failure: files the parent added come back as add/add conflicts,
and the member's diff inflates with work that is not its own.

The fork was resolved from a BRANCH NAME, late — after the cascade had
already moved that branch's ref. A name is not a fork point: by the time
it is read it points somewhere else, and git falls back to the
merge-base, which is far too old.

Measured on the router stack (2026-11-07): layer 2's rebase onto the
rewritten layer 1 replayed 17 base commits and conflicted on 15 files
(add/add across `packages/brouter/*`), while the member's own work was 5
commits.

Reproduced in a scratch repo (`/tmp/fr_old` vs `/tmp/fr_new`, same
starting state):

```text
СТАРЫЙ путь: форк = имя ветки, разрешённое ПОЗДНО
    Rebasing (1/4) … (4/4)      ← 4 коммита в replay: 3 базовых + свой
НОВЫЙ путь: форк = захваченный SHA
    Rebasing (1/1)              ← 1 коммит в replay: только свой
```

Same result, same tree — but the OLD path carried the base's commits
through the replay. When the base was squash-merged (the operator's
merge style), those commits are not patch-equivalent to the squash, so
git cannot drop them: they land as add/add conflicts.

## Design

### The fork is captured in the plan, before any ref moves

The plan is made BEFORE the cascade runs (`syncStack` builds it, then
walks it) — and that is the only moment when every ref still stands
where it stood. The old base's tip is read there and kept as a SHA:

```ts
m.forkSha = shaOf(root, baseOf(m, prev));   // the plan phase
```

A SHA does not move. The rebase then starts from it — but only when the
member still CARRIES that tip (`containsBaseHead` says exactly that):
then the member's own work starts right after that commit, and the
replay is the member's work alone.

When the base was rewritten under the child, the tip is not in the
member — and `forkPoint` answers that case, from the base's reflog and
the patch-equivalence list:

```ts
const fork =
  m.forkSha !== undefined && carriesCommit(m.branch, m.forkSha, wt.path) === true
    ? m.forkSha
    : forkPoint(item.desiredBase, wt.path);
```

So the fork is an immutable commit whenever the member carries it, and
the reflog's answer otherwise. `git rebase --onto <base> <sha>` resolves
the fork from that commit: when the SHA is an ancestor of the member,
the replay is exactly the member's own work; when it is not, git takes
the merge-base of the SHA and the member — the same answer, but from a
commit that cannot move under the cascade.

### The member's own reflog answers for a base that is GONE

The plan's SHA comes from a REF — and the base's ref may be gone before
the plan is even made: the platform deletes a merged member's branch
(GitHub's delete-on-merge), and the sync retires a merged member's
branch mid-cascade. Then there is no SHA to capture.

The member's OWN history still remembers: its reflog's CREATION entry —
"branch: Created from <base>" — names the base's tip of that moment,
and the entry's SHA is that tip. Not merely the OLDEST entry: a reflog
that was truncated or expired has no creation entry left, and its
oldest survivor is a later commit — a fork there would drop the
member's own commits. That commit is used only while it is still an
ancestor of the member's tip: after a rebase the member's history no
longer carries it, and the reflog's answer is then a question the plan
cannot answer.

```ts
const fork =
  m.forkSha !== undefined && carriesCommit(m.branch, m.forkSha, wt.path) === true
    ? m.forkSha
    : (forkFromReflog(m.branch, wt.path) ?? forkPoint(item.desiredBase, wt.path));
```

### The fork is asked of the base the member FORKED FROM

`forkPoint(base, wt)` asks one question: *where was `base` when this
member's line branched off it?* — `git merge-base --fork-point` reads
`base`'s reflog for it. The question has an exact answer only for the
branch the member's line actually left.

- `item.oldBase` — the base the member forked from (the recorded edge,
  else the PR's base). The question fits: the answer is the base's tip
  at the fork, and the replay carries the member's work alone.
- `item.desiredBase` — the base the member is GOING to. A different
  question: where the desired base forked from the member's line. When
  the desired base is the trunk and the member left another branch, the
  answer is where the CHAIN left the trunk — too old, and a replay from
  there carries the base's old commits, which conflict with the
  squash-merge on the new base.

So the fallback reads `oldBase` first and `desiredBase` last. Measured
on the same chain (`--fork-point` against a base that advanced after
the member forked off it):

```text
форк от oldBase      = e1a9a68  ← базовый tip в момент форка: replay несёт 1 коммит
форк от desiredBase  = 9ef3f7a  ← точка выхода ветки с транка: replay тащит базу
```

### The late name resolution is gone

`rebaseMember` used to answer the fork with `item.oldBase` — a branch
name — whenever that branch still existed. That name was read during
the cascade, after the cascade had moved it. The name is replaced by
the captured SHA; the fallback for a base whose ref is GONE stays
`forkPoint()`, which answers the same question from the base's reflog
and the patch-equivalence list.

### The plan's oldBase stays a name; the SHA rides beside it

`planSync` compares the member's old base with the base it must stand
on — a comparison of NAMES ("does this member move?"). The name must
stay a name for that decision, so the SHA rides beside it: the plan's
member carries `forkSha` the way it carries `containsBaseHead`.

## Plan

- [x] `SyncMemberInput` carries `forkSha` — the old base's tip, read in
      the plan phase.
- [x] the CLI captures it in the same pass that reads the base's head.
- [x] `rebaseMember` starts the replay from the captured SHA; the late
      branch-name resolution is gone.
- [x] a base whose ref is gone: the member's own reflog says where its
      work began.
- [x] the fork is asked of the base the member forked FROM; the desired
      base is the last resort.
- [x] the plan's SHA is revalidated against the member's current head —
      a rewritten member does not carry it, and a commit it does not
      carry is not a fork.
- [x] tests: the replay carries the member's own commits only — when the
      base's branch is retired mid-cascade, and when the host deleted it
      before the sync (that one fails on the old code); and the fork
      comes from the base the member forked from, not from the desired
      base.

## Verify

- `npx tsx --test packages/cli/src/commands/stack.e2e.test.ts` — the
  cascade's own end-to-end story still holds, and the replay carries the
  member's work only.
- `npm test` — the exact command CI runs.
- The repo's CI, exactly as GitHub runs it.

## Non-negotiables

- **The replay carries the member's own work.** No commit of the base's
  old history may ride along.
- **The fork is immutable.** A fork point read from a ref that the
  cascade moves is not a fork point.
- **The tool does the move.** The cascade is bro's own work, not a
  hand-rolled rebase.

## Risks named up front

- **A base whose ref is GONE has no SHA to capture.** The member's own
  reflog answers that case — its oldest entry is the commit its branch
  was created at, and it is used while that commit is still an ancestor
  of the member. Behind it, `forkPoint()` reads the BASE's reflog: after
  a squash-merge the patch-equivalence list cannot recognise the
  squashed commits, so that last resort can still land too early.
- **The capture is a point in time.** It is read in the plan phase, so
  it describes the chain as it stood when the plan was made. That is
  the truth the plan is about.
- **A reflog can expire.** The member's creation point lives in the
  member's reflog; a repository with `core.logAllRefUpdates` off, or a
  reflog pruned past its expiry, has no such record — and the plan's
  SHA is then the only answer.
