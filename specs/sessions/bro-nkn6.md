---
parent: sessions
scope:
  - packages/guard/
  - packages/core/src/connectors.ts
  - packages/cli/src/commands/guard.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/plugins.ts
  - skills/guard/
  - bro.config.json
---

# bro-nkn6 — bro guard: declarative prompt contributions to the mega-hook

Parent: `sessions` capability. See `spec.md`.

## Problem

The hook aggregation plane exists: `hooks.json` calls `bro hooks
<event>`, connector probes (`sessionStart`/`promptSubmit`/`postTool`/
`stopGate`) assemble one control JSON, and every contribution is
fail-open under a per-probe timeout. What a connector cannot declare
today is a *prompt-shaped* contribution — a fragment of context that
should appear only when a condition on session/diff state holds. Every
nudge that exists (skill citation on first mutation, PR-created →
act-gate hint, parallel-work lines) is hand-coded inside
`commands/hooks.ts`, so a new policy ("src/ changed without tests",
"spec went stale") means editing the mega-hook's core rather than
declaring a module beside the connector that owns the state.

`bro learn` already proves the demand for trigger-gated prompt
fragments — but lessons are *learned knowledge* gated on text/trace
matching (terms, commands, paths, tools, errors over the prompt and the
session trace journal). A guard is *declared policy* gated on **state**:
the worktree diff, the armed aspects, the branch, the repo layout. Same
injection plane, different condition space — and a guard's author is a
connector or the repo's own config, never a captured session artifact.

## Terms

- **guard** — a declarative module `{ name, when, say }`: `say` is the
  prompt fragment injected when `when` holds. Pure — a guard has no
  run(), no side effect, no command surface; it is data the mega-hook
  evaluates.
- **`when`** — the guard's condition: hook events (`on`), an optional
  trace/prompt `match` (the lesson `TriggerMatch` DSL, reused), an
  optional `state` predicate set over live repo/session state, an
  optional `judge` clause. Conjunctive across keys.
- **probe** — a named state predicate the engine implements
  (`diff`, `branch`, `armed`, `exists`, …). Guards reference probes by
  name; the probe registry is closed — a new predicate is an engine
  change, not config.
- **fired set** — the per-session dedup plane guards share with learn:
  `<git-common>/bro/hooks/fired/<session>`, one id per line, appended
  under the same file lock. Guard entries carry the `guard:<name>`
  prefix so the two namespaces cannot collide.
- **judge clause** — an optional `decide()` input that may *suppress* a
  firing guard. Veto-only, abstains when the judge can't answer —
  see below.

## Guard schema

```ts
interface Guard {
  /** `[\w][\w.-]*` — unique across config defs and connector
   *  contributions; first declaration wins, later dupes warn+skip. */
  name: string
  when: GuardWhen
  /** The prompt fragment. Rendered as `bro guard <name>: <say>`; the
   *  engine truncates past a bound (fragments stay fragments). */
  say: string
}

interface GuardWhen {
  /** Events the guard may fire on — ≥1. 'session-start' covers all
   *  three rehydrate events (they share emitSessionContext); 'stop'
   *  contributes a passive hint line, never a block. */
  on: Array<'session-start' | 'prompt-submit' | 'post-tool' | 'stop'>
  /** Trace/prompt conditions — the same TriggerMatch shape learn
   *  uses: conjunctive across keys, disjunctive within a list.
   *  terms/commands/paths/tools/errors evaluate against the prompt
   *  text and the session trace tail, unchanged. */
  match?: TriggerMatch
  /** Live-state predicates — conjunctive across keys. */
  state?: {
    /** Worktree diff (`git status --porcelain`, repo-relative):
     *  `changed` needs ≥1 path hitting a glob; `without` needs zero
     *  hits — "src/ touched, no test file" is
     *  `{ changed: ['src/**'], without: ['**/*.test.*'] }`. */
    diff?: { changed?: string[]; without?: string[] }
    /** Glob vs `git branch --show-current`. */
    branch?: string
    /** Gate aspects this session armed (readArmed) — all must hold. */
    armed?: string[]
    /** Repo-relative paths that must exist. */
    exists?: string[]
    /** Engine-registered named probes — the extensible slot where
     *  costlier predicates (spec-drift, docs freshness) plug in. An
     *  unknown name fails the clause and shows in `bro guard test`. */
    probes?: Array<{ name: string; args?: Record<string, unknown> }>
  }
  /** Optional decision-model clause — a single noul question asked of
   *  the judge facade with the guard's evaluated evidence as `state`.
   *  Fires the guard iff `noul >= threshold` (default
   *  `judge.confidence`). Veto-only: judge off/unavailable/low-
   *  confidence abstains — the deterministic clauses decide, and the
   *  emitted line is marked `(unjudged)`. */
  judge?: { question: string; threshold?: number }
  /** Max fires per session, default 1 — same semantics as the lesson
   *  budget. */
  budget?: number
}
```

A bare `{ on: [...] }` fires on every matching event (budget-capped) —
same event-only rule as a lesson trigger with no `match`.

Validation is `guardProblems()` with the learn convention's two faces:
config `defs` fail closed (a malformed def is dropped with a stderr
warning at load), connector-contributed guards fail open (a malformed
contribution is skipped with a warn line, never a crash).

## Sources — two ways to declare

- **Connector contribution** — `Connector` gains
  `guards?(ctx: ConnectorCtx): Guard[]`, collected by a `collectGuards`
  mirroring `connectorHooks`: every registered connector's declarations,
  fail-open per connector. `guards()` runs synchronously and is not
  bounded by `PROBE_TIMEOUT_MS`; each declaration must return promptly.
  Declarations are data — collection stays cheap; *evaluation* is
  centralized in the engine, not in the connector; state probes never
  run inside a connector.
- **Repo config** — `bro.config.json` gains a `guard` section; `defs`
  is the repo's own guard list so a project can nudge without shipping
  a connector:

  ```jsonc
  {
    "guard": {
      "enabled": true,          // kill switch — off emits nothing
      "maxPerEvent": 3,         // cap on emitted guard lines per hook event
      "defs": [ { "name": "…", "when": {…}, "say": "…" } ]
    }
  }
  ```

Aggregation order: config `defs` first, then connectors in registry
order; a duplicate `name` loses to the earlier declaration with a warn
line (the repo can always shadow a plugin's guard).

## Aggregation in the mega-hook

The engine — `packages/guard` — owns evaluation; `commands/hooks.ts`
gains one call per emit path:

```text
session-start / post-compaction / pre-compact
      append fired guard lines to `parts` (after connector probes)
prompt-submit   match.terms sees the raw prompt, state sees live repo
post-tool       match sees the journaled trace tail (same file, same
                100-line tail read learn makes); state sees live repo
stop            fired lines join `hints` — additionalContext only;
                `decision: block` stays owned by GateContributions +
                the session-arming policy. A guard is a nudge, not a
                gate — nothing in `when` can produce a block.
```

`MatchContext` is built once per event: prompt-submit uses the prompt +
trace tail; post-tool and rehydrate events use the trace tail (plus the
session-context text on session-start — the same inputs the learn
connector assembles). The trace read happens only when some eligible
guard declares `match`; `state` probes are lazy per clause — an
`armed`-only guard never pays for `git status`.

## Budgets and dedup vs prompt spam

Three independent bounds, each pinned to machinery that already exists:

- **Per-session budget** — `when.budget` (default 1) enforced through
  the shared fired set: `guard:<name>` lines appended to
  `<git-common>/bro/hooks/fired/<session>` inside the same
  `` `withFileLock(`${fired}.lock`)` `` critical section learn uses —
  concurrent post-tool hooks can't double-fire a budget-1 guard. No
  session id → no fired set → guards don't fire (the learn rule:
  an unbudgeted post-tool nudge on every landing is the failure this
  prevents). Fired files prune on the marker TTL.
- **Per-event cap** — `guard.maxPerEvent` (default 3) bounds the lines
  one event may emit — injection is a budget, not a dump.
- **Fragment bound** — `say` is truncated at 2000 chars / 20 lines
  with an ellipsis marker; a guard is a pointer to policy, not a
  document.

Dedup across events is the budget: a guard that fired on post-tool
doesn't repeat its `say` on stop unless `budget > 1`. There is no
content-hash dedup in v1 — `budget: 1` already covers it.

## Judge-decision inputs

A guard's `when.judge` rides the existing `judge` facade — the
`decide(state, questions)` contract and its shadow-mode rules are
pinned by `specs/sessions/bro-f4ot.2-judge.md` (question types
`choice|score|noul`, fail-open `JudgeUnavailable`, `judge.timeoutMs`
bounding the whole call, `judge.maxDecisionsPerRun` bounding spend):

- The clause is **one `noul` question** — "should `<name>` fire in this
  state?" — asked only for a guard whose deterministic clauses already
  pass. A guard the diff never triggered never spends a decision.
- `state` for the call is the evaluated evidence: which match keys hit,
  which state probes held, the diff/branch summary — the connector
  serializes, per the contract.
- The answer can only **suppress**: `noul < threshold` vetoes the
  firing (journaled, visible in `bro guard test` and the verdict
  journal as `kind: 'guard'`). Judge off (`judge.mode`), unavailable,
  or answering under `judge.confidence` → the clause abstains and the
  deterministic `when` decides — identical to the clause being absent.
  A judge that could mute a configured guard by wedging would make
  guard behavior depend on a network call; it must not be able to.
- Verdicts append to the same `verdicts.jsonl` journal with
  `kind: 'guard'` — suppression accuracy is measurable before any
  stronger use is considered, same dogfood discipline as act triage.

## `bro guard` — the facade

```text
bro guard list [--json]     every resolved guard: name, source
                            (config|<connector>), on-events, budget,
                            validation state — TSV like spec drift
bro guard test <name>       evaluate `when` against the live dir and
    [--event <e>]           this session context: per-clause verdicts
    [--prompt <text>]       (match hit/miss, each state probe's result,
                            the judge answer or 'abstained'), then
                            FIRE|SKIP plus the exact rendered line
```

`test` never records to the fired set and never writes a verdict —
it is a read on the engine, safe to run mid-session. Exit codes follow
the repo convention: `test` exits 1 on SKIP (CI-able), 2 on usage
errors, 0 on FIRE.

## Filetree

```text
packages/core/src/guards.ts       Guard/GuardWhen schema + guardProblems — the
                                  seam types live beside Connector, which owns
                                  guards?; @broject/guard re-exports them
packages/guard/src/probes.ts      state predicate impls — diff/branch/armed/exists
packages/guard/src/engine.ts      collect→evaluate→budget→fired-set, per event
packages/guard/src/config.ts      `guard` config section (enabled/maxPerEvent/defs)
packages/guard/src/index.ts       exports
packages/core/src/connectors.ts   Connector.guards? + collectGuards
packages/cli/src/commands/guard.ts    bro guard list|test
packages/cli/src/commands/hooks.ts    guard evaluation in the four emit paths
packages/cli/src/plugins.ts           guard plugin entry + connector registration
skills/guard/SKILL.md                 policy only — mechanics live in the CLI
```

## Plan

- [ ] bro-nkn6.1 this spec
- [x] guard schema + `guard` config section + `collectGuards` seam
      (`Connector.guards?`, config defs, dedup/warn rules) +
      `bro guard list`
- [x] state probes (diff/branch/armed/exists) + engine evaluation +
      fired-set budget in the four emit paths; `bro guard test`
- [ ] `when.judge` veto clause through the judge facade,
      `kind: 'guard'` verdicts
- [ ] first real guards: test-coverage-on-stop
      (`stop` + `diff.changed src/**` + `without` tests) and the
      spec-drift nudge probe (bro-fvhz); docs/site freshness and
      changelog/debt linkage land as their consumer beads add probes
- [ ] tests — schema, matcher reuse, per-probe fixtures, fired-set
      concurrency, per-event cap, judge abstain paths; CHANGELOG +
      embedded-data regen

## Risks named up front

- **Guard spam is the feature failing.** Every new injection surface
  re-opens the prompt-budget question; that is why budget defaults to
  one fire per session, `maxPerEvent` caps an event, and the fired set
  is the same file learn already locks — no second dedup plane to
  disagree with.
- **State probes get expensive.** A named probe that runs `bro spec
  drift` or hits the network sits inside a hook with a 10–25s host
  timeout — probes must be argv-git/file reads with their own bounds;
  anything costlier fires on cached state or doesn't ship as a probe.
- **Judge creep, second front.** The veto clause is deliberately
  one-sided: suppression only, abstain on doubt, journaled as
  `kind: 'guard'`. A judge answer that *causes* a firing needs the
  same measured graduation the act annotation is earning — separate
  spec, after stats say it earned it.
- **Guards vs lessons drift apart.** The condition spaces overlap at
  `match` (deliberately the same TriggerMatch code). If the DSLs
  diverge — guards gain keys lessons can't read — the shared matcher
  stops being shared and this spec's reuse argument dies; keep the
  split at "trace/text" vs "live state", not at diverging syntax.
