# bro-h07vx — act merge: stacked PRs need the async merge endpoint

## Problem

GitHub refuses both merge paths bro knows for a PR that belongs to a
**stack**: the GraphQL `mergePullRequest` mutation (`gh pr merge` is a
GraphQL client) and the synchronous `PUT /repos/{o}/{r}/pulls/{n}/merge`.
The API answers *"must be merged using the asynchronous merge REST API"*.
`bro act merge` therefore fails on every stacked PR, and so does
`bro act wait --merge`, whose merge step is the same call — an agent
watching a stack layer gets a hard error instead of a merge.

Hit on sverka #318 (2026-10-07), worked around by hand with
`gh api -X PUT .../pulls/318/merge-async`. The workaround belongs in the
connector, not in the operator's shell history.

## Design

One seam: `ReviewFacade.mergePr` — every merge bro performs
(`bro act merge`, `bro act wait --merge`, `bro drive`'s green-PR pass)
goes through `landPr` → `mergePr`, so fixing the GitHub connector fixes
all three. No CLI change, no facade-contract change: the existing
contract — *"merge + authoritative verify, return the post-merge state"* —
already covers an async merge, because the state is read back from the PR
afterwards.

Detection, two ways, both cheap:

| Signal | Source | Why both |
| ------ | ------ | -------- |
| `.stack` present on `GET repos/{o}/{r}/pulls/{n}` | REST PR read | Decides *before* touching a merge endpoint — no doomed GraphQL attempt, no alarming error text. Doubles as the base-branch read the merge action needs |
| merge rejection matching `asynchronous merge` | `gh pr merge` stderr | The reactive net for hosts/versions where `.stack` is absent from the PR payload — detection must not depend on one API field |

A probe failure reads as **not a stack**, never a throw: an unreachable or
field-less API must not block a merge the sync path can still do. The
reactive net catches the stack case that probe missed.

The async path:

1. `PUT repos/{o}/{r}/pulls/{n}/merge-async` with `sha` (the head the
   gate evaluated — the same pin `--match-head-commit` gives the sync
   path, so a head that moved mid-gate still fails closed) and
   `merge_action`:
   - `merge_queue` when the base branch requires a merge queue — the
     queue owns the strategy, and passing `merge_method` with it is
     rejected by the API;
   - `direct_merge` + `merge_method` (`squash`/`merge`/`rebase`)
     otherwise, so `--squash`/`--rebase` keep meaning what they say.
   `--admin` maps to `bypass_rules=true`.
2. `202`/`200` carries a `uuid` (a `409` carries the uuid of the request
   already pending, so a re-run resumes rather than double-requests);
   `200` can also be terminal. Both are read from stdout *and* stderr —
   `gh api` puts the body on either stream depending on the status.
3. Poll `GET repos/{o}/{r}/pulls/{n}/merge-async/{uuid}` until `status`
   leaves `pending`. `merged` → the caller sees `MERGED` from the
   authoritative re-read; `enqueued` → the re-read says `OPEN`, and the
   existing "a merge queue still owns it" line is exactly right;
   `failed` → throw with the API's message.

Merge-queue enablement is a GraphQL-only fact (`Repository.mergeQueue`
— REST does not expose it, per Renovate's own workaround), so it is one
`{mergeQueue(branch: $base){id}}` query on the stack path only. Any
error (GHES without the field, permissions) reads as "no queue": the
direct path preserves the requested method, and a wrong guess fails
loudly at the endpoint instead of silently.

**No branch deletion on the stack path.** `--delete-branch` on a lower
layer closes every PR stacked on it — irrecoverable — and the async
endpoint has no such parameter anyway. The connector says the head branch
is kept. Local cleanup (`--cleanup`) is unaffected: it deletes only a
local ref whose tip is the merged head.

Non-settled results are never guessed: a poll `404` (the request record
is gone) or a timeout throws with the uuid, so the operator can re-check.
Silent success is the failure mode this whole bead exists to kill.

### Verified against the live API (2026-10-07, gh 2.102.0, sverka)

Probed on an already-merged PR (`PUT` on a closed PR cannot mutate):

| Call | Answer |
| ---- | ------ |
| `merge-async` with `merge_action=bogus` | `422` — *"Must be one of the following: default, direct_merge, merge_queue"* |
| `merge_action=merge_queue` **+** `merge_method=squash` | `422` — *"Custom merge params (merge_method, commit_title, commit_message) are not supported with the merge_queue merge action"* (`sha` is not among them — it survives the queue path) |
| `merge_action=direct_merge` + `merge_method=squash` + `sha` | `200 {"status":"merged","details":{"message":"Pull request is already merged.","sha":"d39ff2…"}}` — terminal on a 200, no uuid to poll |

Also confirmed: `gh api` prints the JSON error body on **stdout** (the
`gh: … (HTTP 4xx)` line goes to stderr), which is why the reader takes
both streams.

## Plan

- [x] `specs/bro-h07vx.md` — this spec
- [x] `packages/github/src/reviews.ts` — `stackProbe`, `queueRequired`,
      `mergeAsync` (PUT + poll, injectable sleep for tests), and
      `mergePr` dispatching to it on `.stack` or on the async-merge
      rejection
- [x] tests — facade-level (probe-detected stack, rejection-detected
      stack, queue vs direct body, no `--delete-branch`) and unit-level
      poll loop (`pending` → `merged`, `enqueued`, `failed`, missing
      uuid, 404, timeout)
- [x] docs — one line in `skills/act/SKILL.md` + the act command page

## Out of scope

- bro-r6vge (native `gh stack`/`glab stack` delegation) — this is the
  per-layer fallback that bead's design keeps for when those CLIs are
  absent.
- Retargeting the layers stacked above a merged one, and merging more
  than one layer per call: a stack is still merged one PR per
  `bro act merge`, which is what the gate evaluates.
