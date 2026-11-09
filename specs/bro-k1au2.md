# bro-k1au2 — the act gate must be a project-side required check

## Problem

Auto-merge (`gh pr merge --auto`, `glab mr merge --auto`) is a **project
config**: it lands a PR as soon as GitHub's required checks are green. It
is the right way to take the merge off the agents — but it only sees
what the project makes *required*.

The act gate today lives in the **agent's session** (`bro review act
status` / `bro act wait`). Nothing on the project side knows about it.
What the ruleset on `main` (id `23368330`) actually carries:

```text
required_review_thread_resolution: true     ← "all threads resolved" — GitHub enforces it
required_status_checks: build-test, Codacy Static Code Analysis,
                      CodeScene Code Health Review (main),
                      SonarCloud Code Analysis, CodeQL
required_approving_review_count: 0
```

So the first half of the gate ("no thread is open") is enforced by
GitHub itself. The second half — **"every reviewer has reported"** — is
not: the AI reviewers' checks (CodeRabbit, Kody, Kilo, cubic, Sourcery)
are not required contexts.

The consequence is a race, and the router stack hit it twice: auto-merge
lands the PR while a reviewer is still running, and that reviewer's
finding arrives **after** the merge, as review debt. On
[#953](https://github.com/ThePlenkov/bro/pull/953) two rounds landed
after the first head — 6 findings, the last three on the final head.

The control has to be on the project side. That is the whole point of
auto-merge: less load on the LLMs, with the controls still in place.

## Design

### The gate becomes a required check

A workflow in the repo evaluates the gate and its job's conclusion **is**
the verdict:

```yaml
# .github/workflows/act-gate.yml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr: {description: "PR number to evaluate", required: true, type: string}

permissions:
  contents: read
  pull-requests: read
  checks: read
  statuses: read

jobs:
  act-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>   # pinned
        with:
          ref: main          # the rules of the game — not the PR's code
      - run: npm ci --no-audit --no-fund --ignore-scripts
      - run: npm run build
      - name: Skip the gate for a draft
        if: ${{ github.event.pull_request.draft }}
        run: echo "draft — the gate does not apply yet"
      - run: node packages/cli/dist/index.js review act wait "$PR" --timeout 20
        env:
          PR: ${{ github.event.inputs.pr || github.event.pull_request.number }}
          GH_TOKEN: ${{ github.token }}
```

The job's check lands on the PR's **head SHA** and is refreshed on every
push — the same SHA the ruleset evaluates. Its conclusion is the gate:
green only when the reviewers have reported and no thread is open.

### The gate never counts itself

While the gate job runs, its own check is **pending on the PR's head SHA** —
`gh pr checks` reports it like any other check. A gate that counts itself
waits for itself: the job never settles, it hits the timeout, and the
required context can never report success. The deadlock is real, not
theoretical (codeant-ai and kilo both flagged it on this PR).

The exclusion is **project policy**, not connector logic: `act.selfCheck`
names the check that IS the gate, and the gate drops it from its own
input — never from anyone else's.

```json
{ "act": { "selfCheck": "act-gate" } }
```

The name match is case- and separator-insensitive (`act-gate` matches
`Act gate`): a setting that silently matched nothing would restore the
very deadlock it exists to prevent. The connector stays
provider-agnostic — no gate name is hardcoded in shared code, and the
exclusion is not `act.ignoreChecks` (that path reports a "reviewer may be
down" alert for a failing check without thread activity — noise the gate
would raise on itself).

### Why the workflow polls instead of publishing a check

`bro` publishing the check itself (`POST /check-runs`) would need a
refresh path, and the only scheduler available — a `schedule` trigger —
checks out the default branch: its checks land on **main's** SHA, not
the PR's. The verdict would go stale on the PR head, and auto-merge
would land a PR whose gate was never re-evaluated.

The workflow's own job check has neither problem: it lands on the head
SHA and is refreshed by every push. The poll (`bro act wait`) is what
closes the race — the gate turns green only when the reviewers have
reported.

### The agent's job shrinks

The agent fixes the findings and pushes. It does **not** have to watch
the merge: once `act-gate` is green and the other required checks are
green, auto-merge lands the PR. The act loop stays as the *fix* loop
(`bro act threads` → fix → push), not as the *watch* loop.

`required_review_thread_resolution: true` still holds the line on
threads at merge time — GitHub re-evaluates it when the merge actually
happens, so a thread that lands a minute after a green gate still blocks.

### The ruleset change is infra, not repo

The ruleset is not a file — it is project configuration. The context
`act-gate` is added to `required_status_checks` **after** this lands,
otherwise every open PR would wait for a check that no workflow produces
yet.

A `pull_request` workflow only runs when its file is on the default
branch — so a PR opened before this lands has no gate check, and a
required context that never reports **blocks** the merge. The workflow
therefore carries a `workflow_dispatch` lever: dispatch it with the PR
number and the gate runs (that is also how the open PRs are covered
before the ruleset change, and how an operator re-evaluates on demand).

## Non-goals

- Not replacing `required_review_thread_resolution` — it is already on.
- Not changing who merges: auto-merge stays the project's mechanism, and
  the formula's merge step keeps the agent's side of it.
- Not adding a check-publishing API to bro — no new platform surface.

## Risks

| risk | what happens | mitigation |
| --- | --- | --- |
| CI minutes | the gate job polls while the reviewers run (≈3–8 min after a push) | `--timeout 20`; a blocked PR fails with the blockers listed, and the next push starts a fresh run |
| a reviewer never reports | the gate waits, then fails — the PR blocks visibly with the reason | the failure names the pending reviewer; the operator can override the ruleset rule |
| the workflow itself breaks | the required context never appears → PRs block | the ruleset rule can be disabled in one API call; the rule id is in the spec |
| the PR's own code is broken | — | the job checks out `main`, so the gate never depends on the code under review |

## Plan

- [x] `.github/workflows/act-gate.yml` — the gate job, plus the
      `workflow_dispatch` lever for the PRs that predate it
- [x] `act.selfCheck` — the gate's own check never counts as CI (config
      section + state filter + unit tests + config schema + docs)
- [x] the formula's merge step states the division of labour: the project
      lands the PR (auto-merge), the agent fixes the findings, the step
      closes on the PR's state
- [ ] after the merge: add the context `act-gate` to the ruleset's
      `required_status_checks` (project config — one API call, documented
      here, not in the repo) — and dispatch the workflow once for each PR
      that was open before it landed

## Verify

- The job runs exactly what a maintainer can run by hand:
  `bro review act wait <PR> --timeout 20` — exit 0 = the gate is green.
- On a test PR: the `act-gate` check appears on the head SHA, turns red
  while a reviewer is running, and green once the reviewers have
  reported; with auto-merge armed, the PR lands on green.
