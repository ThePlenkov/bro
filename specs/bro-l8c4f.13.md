# bro-l8c4f.13 — Не перезапускать sverka без --evaluate после COLLECTION_FAILED

Parent audit: bro-l8c4f. Supersedes the `COLLECTION_FAILED` retry in
specs/review-gate/bro-eqgx.md.

## Problem

`bro check --evaluate` against a config whose steps emit no SARIF makes
sverka return `{"command":"run","error":"COLLECTION_FAILED"}` (the whole
stdout report is dropped) and exit 3. bro answered by **spawning sverka a
second time** without `--evaluate` so the step stats would still land
(check.ts `executeSverka`, pinned by the "retries once" test). Two
defects in that fallback:

- **The workflow executes twice** — every step's side effects re-run for
  what is purely a reporting failure.
- **Evaluation failure becomes a pass** — the retried report has no
  verdict machinery, so `bro check` exits 0 / `status: success` on a run
  whose requested policy gate never ran. A caller cannot tell
  "policy evaluated clean" from "policy could not run".

The audit contract: one `bro check` runs the workflow once;
`executionStatus` is separate from `evaluationStatus`; an evaluation
error must never surface as `verdict=pass`. Project-side SARIF output
errors return an error; infra may degrade only when explicitly marked.
Reuse sverka's own run report — no bro-side evaluator.

## Design

**Single spawn.** `executeSverka`'s retry is deleted: `runCheck` performs
exactly one `sverka run` and parses its stdout envelope.

**Recover the on-disk run report.** Newer sverka (Spec 53,
`sverka.run/v1`) writes `.sverka/runs/<runId>/report.json` **before**
returning the collection failure — the step stats survive on disk even
though stdout drops them. On `COLLECTION_FAILED`, bro reads the newest
`report.json` whose mtime ≥ the spawn's start (freshness guard: a report
older than the spawn is a previous run, never attributed). Verified by
`schema === "sverka.run/v1"` and an object `data`. sverka 0.2.10 (the
pinned floor) writes no report — recovery is opportunistic, absence
degrades to an empty `data`.

**Marked evaluation, honest exit.** The check envelope and the runCheck
result gain an `evaluationStatus` marker:

```json
{"command":"check","data":{…steps,status…},"durationMs":N,
 "evaluationStatus":"failed","evaluationError":"artifact directory not found"}
```

- `data` (and the text report) come from the recovered run report when
  present — `data.status` is the execution status, always separate from
  `evaluationStatus`.
- `evaluationStatus: "failed"` + `evaluationError` (sverka's message)
  replace the vanished verdict — never a synthesized pass. The enum also
  admits `"unavailable"` for future infra-only degradation.
- stderr keeps a loud error naming the remediation (declare SARIF
  artifact outputs or drop `--evaluate`), and the exit code stays
  sverka's (3) — a collection failure is a sverka RuntimeError, not a
  pass.

A real policy failure is untouched: sverka's `verdict`/`summary`/exit
code pass through exactly as before.

## Plan

- [x] spec (this file)
- [ ] `check.ts`: delete the retry; `COLLECTION_FAILED` → error +
      `evaluationStatus:failed`, recover `data`/`report` from
      `.sverka/runs/*/report.json` when fresh
- [ ] `check.test.ts`: one-spawn counter, evaluationStatus marker, report
      recovery, stale-report guard, policy-fail verdict/exit passthrough
- [ ] `skills/check/SKILL.md`: retry policy line → evaluation-failure
      contract
- [ ] `npm run build`, `npm run typecheck`, `npm test` (CI parity)
- [ ] PR
