# bro-0ykhg.2 — brouter cascade: T0 rules → T1 recall → T2 judge → T3 escalate

Child of bro-0ykhg (specs/bro-0ykhg.md). Depends on bro-0ykhg.1 (formula).

## Problem

Every routed task pays one judge call, even when the table already leaves
one candidate. On a fleet of free lanes the judge spends the same allowance
the workers need, and its latency sits on the spawn path.

## Design

Stages, cheapest first. Each stage either decides or passes the surviving
candidate set on; each stage is optional and fail-open.

| stage | what decides                                                                                      | cost             |
| ----- | ------------------------------------------------------------------------------------------------- | ---------------- |
| T0    | code: `match` on what the task already carries (bead type, labels, path globs, repo), then health | ~0, no model     |
| T1    | recall: the outcome rows of similar past tasks (bro-0ykhg.4)                                      | local, ms        |
| T2    | the judge: the formula's questions (bro-0ykhg.1)                                                  | one typed call   |
| T3    | escalation: a stronger judge, only when T2 is low-confidence                                      | rare             |

**When to ask** — `brouter.router.invoke`:

- `ambiguous` (default) — T2 runs only when more than one candidate
  survives T0 (+T1), or a pending match or hard filter requires an absent
  formula answer. One fully evaluated candidate → no call; the explanation
  says `decided by: rules`.
- `always` — T2 on every task (today's behavior; useful in shadow to grow
  the journal).
- `never` — T0/T1 only; the judge is never called.

**Two-phase resolution.** Extend `RouteTask` with optional `labels: string[]`,
`paths: string[]` (repo-relative), `repo: string` (canonical repository ID),
and the typed `features` map from .1. bro's spawn/loop callers populate
these from the bead and checkout when available; standalone callers pass
them explicitly (CLI `--labels`, `--paths`, `--repo`, `--features` JSON
inputs). Validate types and paths; no git/beads dependency is required.
T0 evaluates carried fields only. Missing non-inferable fields do not
match; missing declared formula fields remain pending, not rejected and
not eligible for dispatch. After T2, code evaluates pending matches and
all hard filters before picking and walking a chain. Pending routes count
toward ambiguity. No candidate may dispatch with an unresolved hard filter.
With `invoke=never`, `mode=off`, a judge failure, or an untrusted shadow answer, exclude
routes whose required inputs are still unresolved and use table order
among the remaining safe candidates; if none remain, return a named
no-eligible-route result. Fail-open skips optional model ranking, never
hard restrictions. Health and hard filters also run after T1 decisions.

`mode` (`off | shadow | enforce`) is untouched: it says whether a T2/T3
answer is TRUSTED; `invoke` says whether it is ASKED.

**T1 recall without vectors.** The ledger stays vector-free
(bro-olfvd.1 S1). Recall is FTS5 BM25 over the task text of outcome rows
(node:sqlite ships FTS5): top-k similar tasks with a known outcome, grouped
by route. Restrict retrieval to the active `contextId`, table hash,
formula hash, and success predicate (.4); intersect route IDs with current
candidates. Only verified rows satisfying that predicate vote for a route;
failures are counted separately, never positive agreement. T1 decides only
when the top-k successful rows agree above a threshold
(`brouter.router.recall = { k, minAgreement, minRows }`); otherwise it
reorders the candidates and passes them on. Embeddings stay a later,
separate store, as bro-olfvd.1 already decided.

**T3** is a second provider (`brouter.router.escalate`) used only when T2's
answer is in `lowConfidence`; absent → the table's order stands.

Every stage writes its verdict into the journal row (`stage`, `candidates
before/after`, `latencyMs`), so bro-0ykhg.5 can replay stage by stage.

## Verify

- `invoke = ambiguous` with a one-candidate table: zero judge calls (fake
  judge asserts it was never called), explanation says `rules`.
- T1 with agreeing top-k decides; with split top-k it only reorders.
- T3 is called only on a low-confidence T2 answer.
- `--explain=route` lists each stage, what it removed and why.
- A missing inferred match survives T0 and is evaluated after T2; a single
  candidate with a pending filter still calls T2 in ambiguous mode.
- Never/off/shadow and judge errors cannot bypass a hard filter; no safe
  candidates yields no-eligible-route. Invalid input fails loud; absent
  labels/paths/repo do not satisfy matches that require them.
- Same-named routes in different contexts never share recall votes;
  unanimous failed outcomes do not cause a T1 decision; empty recall passes.
