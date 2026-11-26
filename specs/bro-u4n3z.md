# bro-u4n3z — backlog auditor and prioritization control flow

## Problem

The ready queue is a work list, not yet a dispatch decision. It contains
beads from several planes (feature and bug work, scanner/review debt, convoy
steps, lessons, and `.agents/backlog` notes), with different freshness,
ownership, risk, and execution shapes. A numeric bead priority alone cannot
answer whether an item should run now, be grouped with a sibling, or be
closed as analysis rather than implemented.

The converged orchestrator practice is therefore a three-part control plane:

1. a **policy owner** sets the objective, weights, WIP limits, and override
   rules;
2. a **backlog auditor** turns all intake into an evidence-backed, deduplicated
   audited queue; and
3. the **orchestrator** performs tactical admission and dispatch within that
   queue and the live capacity/ownership constraints.

The auditor is a role and a repeatable decision contract, not another worker
that edits a worktree.

## Roles and boundaries

### Policy owner

The human or named `triage-owner` controls the strategy: the priority classes
and weights, scanner SLA, loop-reliability floor, WIP and provider budgets,
territory map, and tie-breakers. The owner may approve an explicit override
with a reason and expiry. An override is policy evidence, not an auditor
silently changing the score.

### Backlog auditor

The auditor collects and normalizes the configured sources, resolves aliases
and duplicate findings, checks dependencies and ownership, scores candidates
under the current policy, and publishes an audited top-N snapshot. Every row
has a reason and evidence. The auditor may triage an item using the verbs
below, but may not redefine policy, steal an owned worktree, or dispatch an
agent.

The auditor's output is a recommendation. It is not a claim: only the
executor that wins the claim-and-verify race owns the bead.

### Orchestrator

The orchestrator reads the latest valid snapshot, filters it through current
readiness (claims, dependencies, external-agent exclusion, provider walls,
WIP, and one-executor-per-unit-of-work), then dispatches workers through the
fleet/loop/convoy facades. It may skip a stale row, but it does not ad-hoc
promote a lower row over an eligible higher row without recording why.
`bro loop`'s solo, batch, and stack shapes remain execution decisions:
compatible low-priority siblings can be one worker/PR; dependent work is a
stack; risky or high-priority work stays solo.

### Worker/subagent

The worker executes the admitted unit, reports a verdict and evidence, and
does not reprioritize neighboring work. A no-change verdict is still a
deliberate close/defer decision, not an implicit omission.

## Intake and audited snapshot

The auditor runs before dispatch and after material events (a claim, merge,
new scanner result, review-debt collection, worker verdict, or policy
change). It reads:

- beads, including dependencies, parent/convoy membership, labels, claims,
  priority, and age;
- `bro review debt` findings and scanner imports;
- open convoy/molecule steps and `.agents/backlog` entries; and
- `bro self learn probe`/`capture` results, treating lessons as evidence or
  follow-up candidates rather than automatically executable work.

An outage or unreadable source is an **unknown**, never an empty source. The
snapshot records the source error and the auditor refuses to claim that the
queue is clean. This follows the existing fail-loud connector and
infrastructure-failure conventions.

An audited top-N row contains:

```text
id, source, normalized-key, class, priority, score
why-now, impact/risk, effort, freshness, dependencies/blockers
territory/owner, affinity/siblings, recommended action
evidence, policy-version, audited-at, lease/version
```

`normalized-key` is a canonical tuple (source, external id, finding key,
and repository path where applicable), never an ambiguous string
concatenation. A scanner finding and the bead that tracks it therefore
collapse to one candidate while retaining both evidence links. The snapshot
is immutable; a newer audit supersedes it.

## Auditor triage contract

For each candidate the auditor emits exactly one recommended action:

- **implement** — the item is actionable, owned by this repository, has
  sufficient evidence and acceptance criteria, and is ready or has a named
  blocker that the orchestrator can honor;
- **defer** — real work, but blocked by dependency, capacity, freshness,
  policy window, missing customer input, or a provider/territory boundary.
  The row carries a wake condition and a review-after time; defer is not
  disappearance;
- **close** — duplicate, already landed, invalid/stale finding, or explicitly
  accepted as no work. Closure records the reason and evidence and uses the
  task backend's close verb, never deletion;
- **batch** — implementable with one or more siblings under a safe affinity
  key. The row names the lead, complete member set, and why the set is
  compatible.

Batch is a recommendation, not permission to combine arbitrary neighbors.
Use the existing affinity precedence (`spec`, parent/epic, area label, then
path prefix), bind to one key from the lead, and require every member to
carry that same key. P1/P2, `solo`-labelled, cross-territory, dependent, or
uncertain items remain solo/stack work. A batch must preserve per-bead
checkpoints, verdicts, and coverage: an incomplete member requeues rather
than being falsely closed.

### Wontfix-by-analysis

Scanner debt often has a valid terminal outcome without a code change. The
auditor may recommend `close` as `wontfix-by-analysis` only when an analysis
record contains the finding fingerprint, reproduction/evidence, affected
version/path, the reason it is not actionable (false positive, accepted
risk, unreachable path, or compensating control), the decision owner, and a
review/expiry date where the risk can change. The bead is closed with that
record and the scanner finding is marked/suppressed through its supported
mechanism. “No change needed” without evidence is `defer`, not close.

### Owner-territory detection

Before ranking, classify the candidate as `local`, `foreign`, or
`unowned/ambiguous` using configured repository/area ownership, path labels,
source repository, and active claims. A foreign finding becomes a request to
the owning rig (`bro request`) and never a patch in this worktree. An
ambiguous item is deferred to the policy owner or ownership map. Existing
claims and live session markers are evidence of occupancy, not evidence that
the auditor may reassign the item. This preserves the one-executor rule and
the external-finding-as-request contract.

## Race safety and idempotence

Auditing is advisory and may race with dispatch, so every mutating triage
action is conditional:

1. read the candidate and its current revision/status;
2. write the action with the observed revision (or claim token);
3. reread and verify the resulting status, owner, and evidence;
4. on a contested write, keep the winner's state, mark the row stale, and
   re-audit—never overwrite or close the winner's work.

A batch claims the lead and siblings through the task connector's
read→write→verify path. If any member is contested, blocked, or changes
territory, the auditor removes that member and retries the remaining set;
it never silently expands the batch. Close is conditional too: a newly
reopened or re-emitted scanner finding wins over a stale `wontfix` proposal.
Repeated audits and retries are idempotent by normalized-key and action
record. A snapshot lease/TTL prevents dispatch from treating an old ranking
as current, while the dispatch-time readiness check remains mandatory.

## Prioritization control flow

The policy owner chooses weights, but the following class ordering is the
default that matches live practice:

1. **Loop reliability / safety floor** — work that prevents lost claims,
   duplicate executors, broken review gates, stale daemon protection,
   provider-wall violations, or unsafe cleanup is promoted ahead of ordinary
   throughput work. These are reliability blockers even when their bead is
   labelled P2/P3; evidence is an incident, failing gate, or reproducible
   race, not a subjective urgency.
2. **Scanner and review debt within SLA** — exploitable/security and
   correctness findings outrank cosmetic findings. Age and recurrence
   increase score; duplicates and findings on changed/deleted code collapse
   or become analysis-close candidates. Review debt blocking an open PR is
   actionable before new feature throughput.
3. **Feature and product beads** — rank by policy priority, customer impact,
   dependency readiness, strategic value, and effort. A feature does not
   outrank an overdue reliability floor merely because it has a newer bead.

Within a class, use explicit policy priority (lower `pN` first), then
blocking/dependency impact, SLA/age, freshness of evidence, risk reduction
per unit effort, and finally stable creation/id tie-breakers. Never use
lexical ordering for timestamps or versions. A policy override may change
the class or tie-breaker only when it names owner, reason, scope, and expiry.

The flow is:

```text
collect all sources
  → normalize + deduplicate + link evidence
  → detect territory, claims, dependencies, stale/unknown sources
  → classify reliability / scanner-debt / feature
  → apply policy score, SLA boosts, and explicit overrides
  → triage implement | defer | close | batch
  → publish audited top-N + audit evidence/version/TTL
  → orchestrator rechecks readiness and capacity
  → claim-and-verify, then solo | batch | stack dispatch
  → worker/PR/review verdict
  → close/reopen/requeue and capture lesson
  → incremental re-audit
```

The policy owner is the strategic priority authority, the auditor owns
queue quality and evidence, and the orchestrator owns only tactical
dispatch. That separation is the control: no worker, stale snapshot, or
single scanner can unilaterally change the repository's priorities.

## Acceptance

- The role boundary and audited top-N fields are documented and distinguish
  policy, audit, dispatch, and execution ownership.
- All four triage verbs have explicit preconditions, including safe sibling
  batching and evidence-backed `wontfix-by-analysis`.
- Concurrent claim, close, re-emission, and batch membership changes cannot
  overwrite a winner or falsely close unfinished work.
- Foreign and ambiguous territory produces a request or deferral, never an
  in-place patch.
- The ranking flow explicitly orders loop reliability, scanner/review debt,
  and feature work, with owner-controlled weights and auditable overrides.
- The control flow names the existing beads, convoys, review debt, backlog,
  and self-learn surfaces and preserves current solo/batch/stack execution
  practice.
