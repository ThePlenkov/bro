# act-host-port — move the GitHub/GitLab host scripts into the bro connectors

## Problem

The portable skills repo (`theplenkov-ai/skills`) carries a PR-fix workflow at
`skills/code-review/act/` — ~4036 lines of scripts that implement the loop over
two hosts. It works, and it works *without* bro — but it re-derives, by hand,
the abstractions bro already owns:

| skills repo script | lines | bro equivalent |
|---|---|---|
| `lib/platform.ts` | 411 | the host connectors themselves (`packages/github`, `packages/gitlab`) |
| `review-resolve.ts` | 89 | `ReviewFacade.resolveThread` |
| `review-reply.ts` | 152 | `ReviewFacade.replyThread` |
| `resolve-open-threads.ts` | 88 | `ReviewFacade.reviewThreads` |
| `pr-state.ts` | 254 | `prMeta` + `checks` + `reviewedShas` |
| `extract-findings.ts` | 431 | `checkAnnotations` + `packages/debt` collectors |
| `review-state.ts` | 177 | `packages/debt` state |
| `query-debt.ts` + `review-debt-cli.ts` | 353 | `packages/debt` |
| `update-debt-status.ts` | 178 | `packages/debt` |
| `plan-debt-batch.ts` | 152 | `packages/debt` (batch planning) |
| `set-review-state.ts` | 101 | `packages/debt` |

Verified one-in-one: bro's GitHub connector runs the same
`resolveReviewThread` GraphQL mutation as `review-resolve.ts`, and its GitLab
connector runs the same REST `discussions` PUT.

`ReviewFacade` is implemented **in both connectors** — `prMeta`, `checks`,
`reviewedShas`, `checkAnnotations`, `prFiles`, `prBody`, `updatePrBody`,
`mergePr`, `labels`, `createLabel`, `addLabel`, `removeLabel`,
`scanMergedPrs`, `mergedPrInfo`, `reviewThreads`, `resolveThread`,
`replyThread`. The GitHub side uses GraphQL with cursor pagination; the skills
repo re-derives the same over `gh` and `curl`.

Two problems with the hand-rolled version, beyond the duplication:

- **The storage layer is wrong.** Review debt lives in `.agents/review-debt/`,
  backlog in `.agents/backlog/`, plans in `.agents/plans/` — files. bro is
  beads-backed and uses none of those.
- **The quality bar is lower.** bro's connectors are vendor-neutral, tested
  against two hosts, with typed errors and secret hygiene. The skills repo's
  scripts are host-aware but single-purpose.

## Design

**The port is not a code move — it is a capability move.** The skills repo's
`act` is not a library; it is a *discipline* expressed in a SKILL.md with
scripts underneath. bro already owns the mechanics (`ReviewFacade`) and the
loop discipline (`evaluateExitGate`). What bro does not own is the part the
scripts encode.

### What moves

**1. The cycle-guard becomes a gate condition, not prose.**

The skills repo's exit gate has four hard conditions. Three are already
programmatic in bro (`open_threads`, CI pending/failing, reviewer + SAST
pending). The fourth is not:

> **Reopened thread** — any thread was resolved earlier then commented on again
> → stop, do not merge; user must confirm.

bro has `resolveThread(id, unresolve)` and `unresolveReviewThread` — the
*mechanism* to unresolve exists. What is missing is the *detection*: a thread
that was resolved and then received a new comment must block the gate.

**This does not become a `ReviewFacade` method.** The facade carries the
*host's* view — what a thread looks like now — and "was it resolved before"
is bro's own history, not the host's: the host does not expose a resolve
timestamp on a review thread (GitHub's GraphQL has no `resolvedAt` on
`ReviewThread`). So the record lives in bro, in a resolve ledger under
`<git-common>/bro/act-resolves.jsonl`, written when bro performs the
resolve. `ReviewThread` gains the comment *history* (what the host does
know), and the ledger answers the rest.

### Not in this change — future work

The other two cycle-guards from the same policy are **not** part of this
change. They are named here so the port scope is not mistaken for the port
itself.

**The same-rule-2× guard** — *"same rule 2+ times: same rule ID flagged again
after a fix commit → verify fix is on current HEAD; do not re-merge blindly."*
bro has `fixRounds` / `maxRounds` — a round cap, not a per-rule counter. The
per-rule notion needs the findings that produced the blockers, which bro's
`checkAnnotations` already yields, so the raw material is there — but no
counter, no gate condition, no test.

**The empty-loop guard** — *"2+ `/act` invocations on the same PR with no new
product commits → stop and report cycle."* bro has `fixRounds` but counts
rounds, not *productive* rounds. "No new product commits" is a different
signal.

### What does not move (and why)

- **`runner.cjs`** (268 lines) — manages a GitHub Actions **self-hosted runner**
  lifecycle (`startRunner`, `getRunnerId`, `removeRunner`, `cleanup`, labels
  `self-hosted,<os>,<arch>`) so PR checks re-run without burning GitHub-hosted
  minutes. This is not a review concern — it is CI capacity. It has a home in
  the infra repo (`theplenkov-infra/terraform`'s `scripts/runners-up.sh`, the
  k8s/HCP form of the same problem). It should not become a bro connector.
- **`submit-scores.ts`** (407 lines) — the rating flow: a per-run report plus
  an opt-in persistent `review_scores.csv` dataset for research analysis. bro's
  `judge` produces verdicts but keeps no dataset. This is a *new capability*
  with no host abstraction to reuse — a separate decision, not part of this port.
- **`shadow-fork-check.sh`** (184) — fork/upstream pairing for contributions to
  repos he does not own. `skills/shadow-fork` exists as its own skill; it
  belongs with the upstream-contribution tooling, not the review loop.

### The skills repo's side

After the port, `skills/code-review/act` becomes the **discipline document**
without the scripts: the loop, the hard ordering (pipeline first, comments
second), the exit-gate conditions, the per-thread protocol, the untrusted-content
handling. The scripts go away; the policy stays. The name stays too — nothing
in bro is called `act` at that layer, because bro's `act` is the *command* and
the skills repo's is the *method*.

## Consequence

The skills repo keeps what is portable and agent-agnostic (the discipline) and
loses what is host-specific (the scripts). bro gains the two guards that were
prose and are now mechanical — which is the point: **prose that reached the agent
and did not bind; the mechanism must.**

## What this change actually ships

Only the **reopened-thread** guard. The same-rule and empty-loop guards
described above are **not** in this change — bro has a round cap
(`fixRounds` / `maxRounds`) but not a per-rule counter, and "no new product
commits" is a different signal from a round count. They are named here as
separate work so the port scope is not mistaken for the port itself.

- `packages/act`: a resolve ledger (`resolve-log.ts`) under
  `<git-common>/bro/act-resolves.jsonl`, keyed by `(repo, pr, thread)`;
  `detectReopenedThreads` asks it whether a thread was resolved before; a
  new blocker in `evaluateExitGate`.
- `packages/core`: `ReviewThread` carries the comment history (optional — a
  host that cannot answer it leaves it `undefined`).
- `packages/github` / `packages/gitlab`: the thread query asks for the full
  comment list, and every discussion note is mapped.
- `packages/loop` / `packages/cli`: a reopened thread **parks** the member
  instead of spawning a fixer — the earlier resolution was wrong, and a
  fixer would re-resolve it and hide that.

## Verification

- `packages/act`: the ledger and the detector are covered; the gate blocks
  on a reopen; existing gate tests stay green.
- `packages/loop`: a reopened thread parks the member — verified to fail
  with the park disabled.
- The skills repo's `act` SKILL.md keeps its four exit conditions; the one
  that became mechanical is annotated as such, so the documents do not drift.
