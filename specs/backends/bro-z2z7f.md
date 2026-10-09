---
parent: backends
---

# bro-z2z7f — task projection: beads materialize as tracker issues at PR time

## Problem

Bead activity is invisible outside `bd`: 1170 beads churn internally
while GitHub Projects / milestones / issues views show nothing. An
operator cannot tell what the rig is doing without CLI access, and
external collaborators see PRs with no linked intent. Meanwhile bro's
own architecture rule says beads is a *backend*, not the domain model —
so the outward face must be a projection through the connector seam,
not bd leaking upward.

## Design

Projection, not sync. Beads stays the source of truth; the tracker is
a read-facing materialization. Syncing 1:1 would export internal churn
(fix rounds, debt nits) and make the board useless — the projection
policy decides which beads are board-worthy.

### `mirror` — optional TaskStore capability

```ts
publish?(dir: string, task: TaskRow): TaskRef | undefined
```

Per-connector: GitHub → issue (+ `BRO_TRAILER` provenance, labels,
milestone); GitLab → issue/epic; Jira → REST item. Absent capability =
no projection; the loop does not depend on it.

### Trigger — the PR-armed chokepoint

`pushItem → findPr` is the single point where a loop PR becomes real —
the same pass as `bro-c650l` (bro-managed label). One stamp does all:

1. `publish` the bead → issue number (idempotent via `external-ref`
   stored back on the bead — a second PR for the same bead references
   the same issue, no dupes)
2. Edit PR body: `Fixes #N` (GitHub auto-close on merge)
3. Apply `bro-managed` label
4. Project/milestone assignment per policy

Deterministic orchestrator-side stamping; nothing is delegated to the
worker's prompt.

### Epic → milestone

Claiming a child of an epic materializes the epic as a *milestone*;
each child issue joins it. `/milestones` then shows epic progress bars
for free — the natural GitHub-native rendering of "epic with N tasks".

### Projection policy — formula, not hardcode

Which beads mirror is a configurable rule (formula), evaluated at the
chokepoint:

- spec-linked beads, epics, features → issue
- internal debt, housekeeping → no projection (or a sink label)
- policy per-repo via `bro.config` connector config — GitLab/Jira
  substitute their own `publish` under the same rule

## Existing blocks

`BRO_TRAILER` + `ensureGithubId` (doctors.ts) already materialize a
bead into an issue on demand; `createGithubTaskStore` proves the full
issue↔bead round-trip; `CLOSERS` is already backend-parameterized.
Assembly over existing mechanisms — no greenfield.

## Acceptance

- A loop-created PR for a spec-linked bead lands with `Fixes #N`,
  `bro-managed` label, and the issue carrying `BRO_TRAILER`
- Re-push of the same bead references the same issue
- Epic children materialize their epic as a milestone
- A connector without `publish` (e.g. beads-only rig) runs unchanged
- `gh pr list -l bro-managed` and the issues view show rig activity
