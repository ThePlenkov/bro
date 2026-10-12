# bro-atb2g — drive: non-thread blockers spawn per-class fixers

## Problem

`bro drive`'s gate path: `gate.ok` → merge; `open_threads > 0` →
spawnFixer; `mergeable=CONFLICTING` → spawnRebaseFixer (bro-glkes);
**everything else** → `blocked` verdict reported pass after pass with
zero remediation. Observed live: #398 (Sonar 4.4% duplication +
conflicts), #407 (build-test), #412 (Sonar), #400/#403 (CI + Sonar)
all sat `blocked` — the queue's own fixers couldn't land because
nothing fixes their class of failure.

Two settled blockers have no remediation path:

- **`ci_failing > 0`** — a check run settled red (failure/cancelled/
  timed out). The fix needs the run's own record: the failing job's
  log, reproduced in the PR's worktree.
- **`sast_pending > 0`** — failure-level ANNOTATIONS on SAST check
  runs. The gate counts annotations, not check conclusions: a green
  SonarCloud can still carry blocking findings (learn
  `learn-act-gate-sast-pending`).

Out of scope (transient or human-owned, no agent remediation): pending
checks/reviewers, `mergeable=UNKNOWN`, `sast_unknown` (an annotation
fetch that never read — infra, retried each pass), `is_draft`,
`mergeState=BEHIND` (the loop's `updateBranch` path owns that shape —
porting it is a separate bead).

## Design

Extend `blockedVerdict`'s ladder in
`packages/cli/src/commands/drive.ts` — same shape as the conflict
branch, same order as the loop's memberAction:

```
threads>0    → occupied? : spawnFixer            (existing)
CONFLICTING  → occupied? : cap-guard → rebase     (existing)
ci_failing   → occupied? : cap-guard → spawnCiFixer
sast_pending → occupied? : cap-guard → spawnSastFixer
else         → 'blocked'
```

- **`spawnCiFixer`** — re-probes `checks()` (a failure that settled
  green between the gate fetch and now reads `ci-resolved`, never
  burning a spawn), lists the failing non-reviewer checks in the work
  order with a per-check SAST hint (a red SAST run's findings are
  annotations, not log lines), then the shared worktree + locked-spawn
  tail. Prompt: `buildCiFixerPrompt` — read `gh run view --log-failed`,
  reproduce, fix, push.
- **`spawnSastFixer`** — `liveSastChecks` names the annotation-bearing
  checks, `checkAnnotations(repo, headSha, names)` re-probes the
  finding counts (`sast-resolved` when none remain); the prompt names
  each check + count and points at the annotations API
  (`gh api repos/<repo>/check-runs/<id>/annotations`) since findings
  live there, not in logs. Prompt: `buildSastFixerPrompt`.
- **Classifier reuse** — `@broject/act` exports `isSast`,
  `gatedCiChecks`, `failingCiChecks`, `liveSastChecks`: the spawn paths
  name exactly the checks the gate counted (a second name list would
  rot). Drive filters through `act.ignoreChecks` name-matching first —
  an advisory check the gate ignored never lands in a work order.
- **Same-head dedup (`fixerAttempt`)** — a fixer that exits `ok`
  without moving the head proved the work order can't remediate this
  head; replaying the identical prompt is deterministic. The spawn
  records `{ head, classes }` on the fixer bead's registry entry
  (inside the same locked spawn ceremony); a re-entry on the same
  `(head, class)` with a recorded `cause: 'ok'` verdicts
  `fixer-spent` — terminal until any push moves the head. Crash/lost/
  unclassified exits stay respawn-able (the existing contract);
  `rate_limited`/`quota` are refused by the connector's own guard.
  Applied to `rebase`, `ci`, and `sast` work orders; the **thread**
  fixer is deliberately undeduped — new threads arrive on an unmoved
  head, so same-head replay is real work there.
- **Cap** — the same `fixRounds > maxRounds` guard as the conflict
  path: a PR whose reviewed pushes exceeded the round cap reads plain
  `blocked`, not another remediation round.

Verdicts added: `ci-resolved`, `sast-resolved`, `fixer-spent`; spawn
details carry `ci `/`sast ` tags like `rebase `.

## Plan

- [ ] `@broject/act` — export `isSast`, `gatedCiChecks`,
      `failingCiChecks`, `liveSastChecks`; state.ts consumes them
- [ ] `buildCiFixerPrompt` / `buildSastFixerPrompt` — per-class work
      orders (exported for tests)
- [ ] `spawnCiFixer` / `spawnSastFixer` — re-probe → dedup-aware
      shared spawn; `FixerSpawn.attempt` + `fixerAttemptSpent` /
      `recordFixerAttempt` on the registry entry
- [ ] `blockedVerdict` — the two new branches before `blocked`
- [ ] fake host: `checkAnnotations` reads `host.json`; fake agent
      clears `checks`/`annotations` on the new prompt markers
      (`fixerNoop` leaves them for the dedup test)
- [ ] tests — prompt unit tests + dedup predicate; e2e: ci-fail →
      `spawned` → merge; sast → `spawned` → merge; same-head ok-exit →
      `fixer-spent`; occupied/cap/thread-preempt
