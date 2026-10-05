# bro-8xv6 — ignoreChecks only after repeated failure with recent thread activity

## Problem

`act.ignoreChecks` is a boolean ignore: a matching check is dropped from
the exit gate unconditionally. AGENTS.md justifies it as "a failed
AI-reviewer check is pure infra — its findings arrive as threads, which
block on their own." That premise holds only while the reviewer actually
runs. When the reviewer is *down* rather than flaky, it produces no
threads at all and the gate goes green on silence — the same failure
shape as the 2026-10-03 inference wall (resource exhaustion presenting
as infrastructure). Two ignored checks are the whole reviewer signal for
this repo.

## Design

Conditional ignore: an ignored check may be dropped quietly only while
there is evidence the reviewer is flaky-but-alive — repeated failures
**and** recent thread output. A failing ignored check without that
evidence is an **alert**, not a pass. Advisory semantics are preserved:
an ignored check never blocks the gate; the change is detection, not
gating.

- **Config** — `act.ignoreChecks` entries become `string | rule`:
  `{ "name": "kilo", "consecutiveFailures": 3, "threadWindowDays": 7 }`.
  Strings normalize to a rule with defaults (`3`, `7`) — every existing
  config gains the detection without an edit; the object form only tunes
  it. `name` keeps the existing case-insensitive substring match.
- **Check-history ledger** — `<git-common-dir>/bro/act-checks.jsonl`,
  one `{ts, repo, pr, sha, name, bucket}` line per observed check
  outcome, appended by `fetchPrActState` for rule-matched checks. The
  common dir shares the ledger across linked worktrees; a same
  name+sha+bucket repeat is not re-appended so `act wait` polling does
  not grow it. `consecutiveFailures(name)` counts the trailing run of
  'fail' buckets over *distinct* head shas — pushes that failed, not
  polls that observed one. Fail-open: no git dir / unreadable /
  unwritable file behaves as an empty history (streak 0).
- **Thread activity** — a review thread on the PR counts as the check's
  output when its comment author (normalized to lowercase alnum)
  contains the rule-name stem (`kilo` matches `kilo-code[bot]`) and the
  comment is inside `threadWindowDays`. Attribution by name stem, not
  "any thread" — human threads must not certify a dead reviewer alive.
- **Verdict for a failing matched check** — ignored quietly when
  `streak >= consecutiveFailures` **and** a matching fresh thread
  exists; otherwise the check still never gates, but the fetch records
  an alert: `silent reviewer` wording when no fresh thread exists,
  `not yet proven flaky` when it does but the streak is short. Buckets
  other than `fail` (pending, pass, cancel) are ignored as today — the
  stuck-pending protection is the feature's original purpose.
- **Alert surface** — `PrActState.alerts` / `ExitGate.alerts` (not
  blockers); `bro act status` prints `alert:` lines; `bro watch`
  carries them per-PR into `attention`; the act connector's gate lines
  append them. Non-blocking by construction — the existing rule "a
  failed reviewer check never blocks on its own" is kept.

## Out of scope / approximations

- The ledger counts *observed* failures — a check never polled by bro
  has no history, so a first-seen failure alerts as unproven. That is
  the fail-safe direction.
- Author↔check matching is the name-stem heuristic above; a reviewer
  whose bot login shares nothing with the check name never earns the
  quiet ignore and alerts instead — visible, non-blocking, fixable by
  widening `name`.

## Plan

- [x] `core/config.ts`: `IgnoreCheckRule` type + `act.ignoreChecks`
      normalization (`string | rule`, defaults 3 / 7d); export type
- [x] `act/check-history.ts`: `checkHistory(dir)` → ledger at
      `<git-common>/bro/act-checks.jsonl`; `record` + `consecutiveFailures`;
      `fileCheckHistory(path)` for tests; fail-open throughout
- [x] `act/state.ts` + `types.ts`: conditional ignore evaluation,
      `alerts` on `PrActState`; `exit-gate.ts` carries `alerts`
- [x] cli: wire `checkHistory` into every `fetchPrActState` caller
      (act, drive, loop, watch) and the act connector; print alerts in
      `act status`, `watch` attention, connector gate lines
- [x] `bro.config.json`: entries stay strings — they already gain the
      conditional semantics under the new code, and object form would
      read as an empty list under the released CLI (compat); AGENTS.md
      gate paragraph + `site/content/docs/configuration.md` updated
- [x] tests: config normalization, ledger streak/dedup/fail-open,
      conditional-ignore verdicts, exit-gate alert pass-through
- [x] `npm test` + typecheck, PR
