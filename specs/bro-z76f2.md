# bro-z76f2 — stack: register member PRs as a GitHub Stack via `gh stack link`

## Problem

`bro stack` builds the chain locally (branches, edges, retargets) but
never tells GitHub the chain is a **Stack** — the server-side object the
UI's "preview stack" button materializes, the thing `cascade` probes
through `.stack` (specs/bro-r6vge.md), and what `mergePr`'s async path
(specs/bro-h07vx.md) detects. Unregistered members miss the
platform-owned cascade and can't ride `gh stack merge`.

Discovery (drill bro-4pghf): the `/stacks` REST API is live
(X-GitHub-Api-Version 2026-03-10; this repo has 3 historical stacks), and
the `gh stack` extension exposes `link` — a verb built for external
branch managers that don't keep gh-stack local state.

## Design

**Wrap the native tool, never hand-roll the REST mutations** (design
update on the bead): `gh stack link <bottom..top>` takes PR numbers,
creates the Stack when members are unstacked, extends the existing one
when some already belong, and skips members already inside — idempotent
by construction. The REST contract stays probe-only: `GET
repos/{o}/{r}/pulls/{n}` carries `.stack { number, position, size }`,
the same read `stackProbe` (reviews.ts) already makes.

### Connector capability (`stacks` facade — packages/core stacks.ts)

Two optional caps join `openHint`/`cascade`/`mergeChain`, named by
domain semantics:

- `membership(member) → StackMembership | null` — the membership probe.
  Returns `{ id, position, size }` where `id` is the host's stack number
  (the `gh stack link <id>` grow arg / UI label). `null` when unstacked,
  unreadable, or the member carries no PR.
- `publish(members) → StackMembership | null` — register the chain
  bottom→top through the host's native stack tool. GitHub implements it
  as `gh stack link <prs…>` in the bound dir (numbers resolve against
  the dir's remote — the verb has no `--repo`), gated on
  `ghStackInstalled` like `mergeChain`. Throws on refusal — a broken
  chain or a rejected member is a real error, not a "maybe". Returns
  the bottom member's post-publish membership (asserted from the API,
  not the tool's output).

Cap presence IS the bead's "native stack tool detected": github serves
both (a missing extension fails `publish` with the
`gh extension install github/gh-stack` hint, same honesty tier as
`mergeChain` declining); GitLab detects stacks from target branches
itself — both absent; plain git has no forge — both absent.

### `bro stack publish [<name>]` (packages/cli)

`collectMembers` yields ordered members with PRs — probe `membership`
per OPEN member (new `stackRef` on MemberView), filter to OPEN + PR'd,
need ≥2 (GitHub: "two or more"), then:

1. **Pre-flight**: all open members in one stack → `already published —
   stack #N`, exit clean (re-push must not churn). Members split across
   two stacks → report and stop — `link` would reject; say so first.
2. `stacks.publish(openMembers)` → `published — stack #N`.
3. No `publish` cap → the host has no stack registry to write — report
   it (GitLab's chain lives in the base links by design).

Publish is a **post-hoc verb** — `stack push` can't call it (no PR
exists at push time); the loop/drive/agent calls it once ≥2 member PRs
exist, or it arrives by cascade below.

### Cascade points

- `syncStack` tail: after a clean cascade (no skipped members, no
  failed rebase/remote-follow/retarget — the chain's base==prev-head
  invariant is verified by sync itself) auto-publishes when the cap
  exists. A dirty chain defers rather than feeding `link` a chain it
  would reject on every sync. In quiet mode the benign no-ops (<2 open
  PRs, already published) print nothing — sync stays noise-free.
- `stack list`: `N of M open member PRs not in a stack on the host —
  bro stack publish <name>` when the cap exists and members qualify.

### Edge cases

- A hand-retargeted mid-stack member can break base==prev-head — the
  native tool reports the refusal; bro surfaces it, never patches.
- Merged members are filtered out before publish (prState !== OPEN).
- Membership probe failure reads as "unstacked" — publish still runs;
  `link` is itself idempotent.

## Plan

- [x] `specs/bro-z76f2.md` — this spec
- [x] `packages/core/src/stacks.ts` — `StackMembership`, optional
      `membership`/`publish` on `StackFacade`; export via index
- [x] `packages/github/src/reviews.ts` — shared `.stack` read
      (stackProbe + stackMembership); `stacks.ts` — `publish` via
      `gh stack link` + `membership`, extension-missing hint
- [x] `packages/cli/src/commands/stack.ts` — `publish` verb, list hint,
      syncStack clean-cascade tail
- [x] tests — github stacks.test.ts (`stack link` scripting, caps);
      fakehost `membership`/`publish` + stack.e2e coverage (publish,
      idempotent re-run, list hint, sync tail, deferred on skip)
- [x] docs — `skills/stack/SKILL.md` publish row + policy,
      `site/content/docs/commands/stack.md` table row, README line

## Out of scope

- `bro stack merge` — shipped by the facade parent (bro-r6vge / #378).
- `/stacks/{n}/unstack` dissolution — nothing in bro tears stacks down
  today.
- GitLab `glab stack` — the platform auto-detects; no call needed.
