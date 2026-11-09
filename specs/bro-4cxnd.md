# bro-4cxnd — the merge step closes on a verdict, not on a claim

## Problem

The merge step of the `ship-bead` formula closed on the agent's word. The
agent ran `bro flow convoy done <merge-step> --result "PR #958 merged
(squash d11788ce) …"` and the convoy accepted it: the step's `close_reason`
became the agent's sentence, and nothing checked whether the PR was merged
at all.

On [PR #958](https://github.com/ThePlenkov/bro/pull/958) the step's own
watcher (`bro act wait --merge --squash --detach`) printed *"landing
anyway"* and exited **without a merge verdict** — the log ends there, the
PR was already merged by another actor, and the step closed anyway. The
ledger says the merge happened; the ledger cannot say **who** landed it
(watcher / auto-merge / human), and nothing stops the next agent from
closing a merge step for a PR that is still open.

A step that asserts a merge must be checked against the host that holds
the truth.

## Design

### The merge step declares its kind

The formula's merge step becomes its own step kind:

```toml
[[steps]]
id = "merge"
title = "Merge — bro act wait --merge"
type = "merge-step"
```

`merge-step` is a bd custom type, registered by `bro convoy pour` next to
`agent` and `human` — the same mechanism the formula's other step kinds
already use. `stepKind` keeps it agent-executable (an unknown type is an
agent step).

The registration is **verified**, not assumed: the pour reads
`types.custom` back and fails when `merge-step` is not in it. A pour that
cannot keep the merge step's kind would flatten it to `task` and the step
would close on a claim instead of a verdict — so the pour refuses
instead.

bd's `mol pour` flattens an unregistered type to `task`, so the verifier
does not rely on the poured issue's type alone: it also resolves the
molecule's formula (`bd formula show <formula> --json`, the root issue's
title is the formula's name) and matches the step by title — the formula's
title pattern with `{{var}}` as a wildcard against the poured title. A
step poured by plain `bd mol pour` still carries the declaration in the
formula, so the check survives the path that skips bro's pour.

### `done` verifies before it closes

`bro flow convoy done <merge-step> --result TEXT` on a `merge-step`:

1. **Find the PR.** `--pr N` if given, else the PR references in the
   result text (the clickable `[#N](…/pull/N)` form and the bare `#N`),
   else the upstream handoff — the close reasons of the step's direct
   dependencies. The result must name the PR: a merge claim without a PR
   is unverifiable, and unverifiable is refused.
2. **Ask the host.** The PR's state comes from the review facade
   (`prMeta`): `MERGED` is the only state that closes the step.
3. **Close or refuse.**
   - `MERGED` → the step closes. The close reason leads with the verdict
     and the actor:
     `verified: [#958](https://github.com/owner/repo/pull/958) MERGED (merge d11788ce, by ThePlenkov)` —
     then the agent's own sentence, kept as the claim it is.
   - anything else (`OPEN`, a closed-unmerged PR) → **refuse**. The gate
     holds: exit `3` (actionable — the caller can land the PR), with the
     host's state in the message.
   - no PR, or a host that cannot answer → **refuse** (fail closed).

The verdict leads the close reason because the downstream steps read it as
their input: the close-out step needs the PR that landed, and it gets it
from the verdict line rather than from the agent's prose. A PR the claim
named by link reads as a link in the verdict too — the repository travels
with the number, so the line says *which* PR landed.

### One PR, one repository, one host

The claim names a PR, not a PR number:

- The **bare form** (`#958`) names the number; the **link form**
  (`[#958](…/pull/958)`) names the number, the repository and the host.
  A bare reference next to a link is the same PR — the link's repository
  survives it.
- One PR number in **two repositories** (or on two hosts) is ambiguity:
  the verifier must not pick one, so the claim is refused.
- A link that names **another host** is refused before the host is asked:
  this connector reads one host, and a same-numbered PR there is not this
  one. `--pr N` (which names no host) stays the way through.

### Who landed it

The host's merge record says who: `mergedBy` (and the merge commit's sha)
come with the PR's state. The path that landed it — watcher, auto-merge
or a human — is the agent's claim and stays in the close reason as prose;
the host's account is the part the ledger can stand behind.

## Non-goals

- Not the gate: the exit gate decides whether a merge may happen; this
  checks that the merge *did* happen.
- Not `bro act wait --merge`'s "already merged" verdict — that is
  bro-0i1lm, the watcher side of the same question.
- Not a rewrite of the merge path: the watcher, auto-merge and the human
  keep their jobs; only the *closing* of the step is verified.

## Risks

| risk | what happens | mitigation |
| --- | --- | --- |
| the host is unreadable | the step cannot be verified | fail closed — refuse, never close on an unreadable answer |
| the review connector has no credentials | the host cannot answer | the auth failure is a refusal (exit 3), not a crash — the step stays open |
| the result names the wrong PR | the wrong PR is verified | the PR comes from the result, the handoff, or `--pr`; a claim naming two different PRs is ambiguous and refused |
| the result names another repository's PR | the wrong PR is verified | one PR number in two repositories is ambiguous and refused |
| the result names another host | the wrong PR is verified | a link on another host is refused before the host is asked |
| a formula step is renamed | the title match stops resolving | the formula's declaration and the poured type are two independent signals; neither has to be the only one |
| the pour cannot register the merge kind | the merge step flattens to `task` | the pour reads `types.custom` back and refuses when `merge-step` is missing |

## Plan

- [x] `PrMeta` carries the merge record (`mergedBy`, `mergeSha`) and the
      GitHub connector fills it
- [x] a PR-reference parser for free text (link form + bare form) — a
      string walk, not a regex: the text is untrusted, and a regex over
      it is super-linear (CodeQL)
- [x] the convoy verifier: find the PR, ask the host, verdict or refusal
- [x] `bro convoy done` runs it on a `merge-step` and refuses with exit 3
- [x] `bro convoy pour` registers the `merge-step` type — and verifies it
- [x] the formula's merge step declares `type = "merge-step"` and tells the
      agent to name the PR in its result

## Verify

- A merge step whose PR is still open is refused, with the state in the
  message and the step still open.
- A merge step whose PR is merged closes, and its close reason leads with
  the verdict and the actor.
- A merge step with no PR named is refused — unverifiable is not verified.
- A merge step whose claim names a PR on another host is refused before
  the host is asked.
- A merge step whose claim names one PR number in two repositories is
  refused as ambiguous.
- A non-merge step closes exactly as before.
