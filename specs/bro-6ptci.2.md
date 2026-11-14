---
scope:
  - packages/cli/schemas/cli/
  - packages/cli/src/plugins.ts
  - packages/cli/src/commands/contract-schema.test.ts
  - packages/cli/package.json
  - contract/cli.json
---

# bro-6ptci.2 — contract: --json schema coverage — stub schemas, unwired outputs, no output-vs-schema validation

Parent epic: bro-6ptci (CLI is the agent contract). Follow-up to
bro-6ptci.1 (PR #1007), which fixed the missing watchdog schema, gated
`json` refs on disk existence, and deleted the phantom
`debt-status.schema.json` — the real debt `--json` outputs were left
for this bead.

## Problem

`schemas/cli/*.schema.json` are the machine-readable half of the CLI
contract, but today they are write-only artifacts:

1. **Stub schemas can't catch renames.** `debt-next.schema.json` and
   `fleet-status.schema.json` are ~7-line
   `type:object, additionalProperties:true` placeholders — a field
   rename in `DebtRecord`/`BroStatus` passes silently.
2. **Phantom decision, second half.** `debt-status.schema.json` is
   gone (6ptci.1), but the real `debt` `--json` outputs — `debt stats
   --json` (`StatBucket[]`) and `debt trend --json` (`TrendPoint[]`) —
   still have no schema and no contract subs: `debt`'s
   `contract.subs` lists only `status`+`next` while the summary
   advertises `collect|status|prs|list|mark|sync|set` — `stats`,
   `trend`, `next`, `watch` are absent from it.
3. **Unwired/undeclared `--json` emitters.** `skills sync`,
   `otel status`, `otel test` declare `--json` in contract flags with
   no schema ref; `fleet telemetry|watch|resume|leases|pulse`,
   `doctor`, `guard`, `check` (and a long tail of undeclared
   emitters) emit `--json` with no classification.
4. **No output-vs-schema validation** (pbfdp AC#2, the whole point of
   the schema files): no code path loads the schemas at all. Nothing
   fails CI when an emitter drops or renames a field.

## Design

### 1. Validator — ajv, already in the tree

`ajv@8.20.0` is already in the dependency tree (via
`@modelcontextprotocol/sdk`, a runtime dep of `packages/cli`), so no
new code lands — but it is only a *transitive* dep today, and
importing transitives directly is fragile (a dedupe shuffle or an
sdk bump silently breaks the import). `packages/cli` therefore
declares `ajv` as a **devDependency** (`^8.20.0`, matching the
resolved version): the validator runs inside `tsx --test` only, never
in shipped code. A hand-rolled draft-2020-12 subset was rejected —
`oneOf`/`anyOf`/`additionalProperties`/`$ref`/`$defs` semantics are
exactly where hand-rolled validators go silently wrong, and the
"pure TS" preference is moot: ajv is already pure-JS and already
downloaded. Schemas declare `draft/2020-12`, so the harness
instantiates `Ajv2020` (`ajv/dist/2020.js`), not the draft-07 default.

### 2. Stub flesh-outs

- **`debt-next.schema.json`** → `DebtRecord`
  (`packages/debt/src/types.ts`). Closed-world emit
  (`JSON.stringify(row)` of a fixed interface) →
  `additionalProperties: false`; every field required except the
  optional `source` (absent on review-thread rows). Null-union fields:
  `line`, `fix_pr`, `fixed_at`, `notes`. Enums: `status`
  (open|claimed|done|wontfix|duplicate), `priority`
  (blocking|human|nit|scan|noise), `needs`
  (code_change|reply_only|skip).
- **`fleet-status.schema.json`** (title: `bro status --json`) →
  `BroStatus` (`commands/status.ts`). Closed-world →
  `additionalProperties: false` at every level. Required:
  `dir,branch,dirty,worktrees,beads,fleet,loop,drill,watch,build,sync`;
  `act` optional (`--deep` only). `watch|build|sync` are
  `type:[object,null]`; `drill.frame` `[object,null]`. Nested closed
  shapes: `StatusWorktree` (name,path required; branch,state,claim,
  main,here optional), `StatusAgent` (id,backend,state required +
  optionals), `BeadRow` (id,title + optionals), `LoopRunView`
  (beadId,slug,pid,state,silentMs + optionals; silentMs number|null),
  `HeartbeatSummary` (ts,ageMs,attention required; futureMs,
  writerSkewed optional), the `act` object (all gate fields required
  when present; ownership optional enum).

### 3. Phantom decision — schema the real outputs, wire the subs

The phantom file is already gone; this bead's half of the decision is
to schema the two real `debt` `--json` outputs and declare them in
the contract:

- **`debt-stats.schema.json`** (new) → `StatBucket[]` — top-level
  **array**; items closed `{key,total,open,claimed,done,wontfix,
  duplicate,fixRate(number|null)}`, all required, `aP:false`.
- **`debt-trend.schema.json`** (new) → `TrendPoint[]` — top-level
  array; items closed `{bucket,key,opened,closed,open}`.
- `plugins.ts` debt `contract.subs` gains `stats` and `trend` (flags,
  `json` refs, exits — `0` printed, `2` bad flag value); the plugin
  summary is corrected to the real verb list
  (`collect|status|stats|trend|prs|list|mark|set|sync|next|watch` —
  `next` and `watch` were missing too).

### 4. `--json` audit — schema the agent-facing reads, document the rest

Classification rule (pbfdp scope): a `--json` output is a **contract
read** when a machine consumer parses it to decide the next action —
the `act status` / `status` / `rig next` / `next` class. Action
reports, acks, diagnostics, passthroughs and producer streams are
not.

**New schemas + contract wiring (agent-facing):**

| Command | Emit shape | Schema |
| --- | --- | --- |
| `bro skills sync --json` | `{command:'skills sync', data:{steps:SyncStep[], rows:SkillRow[], drift:{name,kind}[]}}` | `skills-sync.schema.json` — closed; `command` const; steps `{label,state:ok\|error\|skipped,detail?}` |
| `bro fleet leases --json` | `[{key,rig,host,pid,agentId?,acquiredAt,expiresAt}]` | `fleet-leases.schema.json` — top-level array, closed items |
| `bro fleet resume --json` | `ResumeReport` minus `watch.link` | `fleet-resume.schema.json` — closed; required `dryRun,sweep,watch,daemon,daemons,loop,agents,worktrees,sessions` (sweep `object\|null`) |
| `bro watch --json` | `WatchSnapshot` | `watch.schema.json` — closed; `ts,attention,mols,gates,fleet,loop,daemon` required; `molsError,activity,clock,janitor` optional; `WatchPrGate` closed w/ optionals; fleet closed w/ `walls?/prErrors?/wallsError?/error?` |
| `bro fleet walls --json` | `FleetWallRow[]` | `fleet-walls.schema.json` — top-level array, closed items `{account,cause,source}` required + `until,bound,resetAt,provider,rig,step,observedAt` optionals |

Contract changes for the new set: `skills.subs.sync.json` ref;
`fleet.subs.leases` + `fleet.subs.walls` (new subs — flags+exits+json);
`resume.contract` (new block — flags+exits+json); `watch.contract`
(new block — flags+exits+json); `debt.subs.stats`/`debt.subs.trend`
(§3). The existing stub schemas that shared this gap —
`agents-status`, `claim`, `mode` — were fleshed out alongside
`debt-next`/`fleet-status` (§2), and the already-detailed-but-open
schemas (`sessions`, `fleet`, `fleet-hosts`, `skills-list`,
`rig-status`) were tightened to `additionalProperties: false` where
their emit is a fixed literal.

**Excluded — documented, no schema:**

| Surface | Why out |
| --- | --- |
| `otel status/test --json` (declared flags) | telemetry-plane diagnostics — operator config debugging, not a decide-next-action read. Flags stay declared (they exist); no schema. |
| `telemetry --json` (`hooks perf`) | perf-journal rollup — debug surface. |
| `pulse --json` | a JSONL *producer* stream (one object per beat, two record variants) — not a one-shot read; the durable artifact is the mailbox/heartbeat file. |
| `doctor --json` | environment diagnostics (human/e2e health probe). |
| `guard list --json` | resolved-declaration debug listing. |
| `check --json` | sverka passthrough — the shape is owned upstream; freezing it would couple bro's contract to a foreign emitter. |
| `pipeline run/wake --json` (declared) | action reports (started-runs scan / wake-pass result). |
| `delegate --json` (declared) | action reply/ack — needs a live provider to emit; not a read plane. |
| `act wait/rearm --json`, `convoy run/wait --json`, `agents prune --json`, `loop`, `drive` | spawn acks / run reports — mutations, not reads. |
| `convoy next --json`, `wait --json`, `mesh wait/inbox --json`, `sessions resume` | agent-facing reads **without a contract block** — deferred to follow-up bead bro-6ptci.3 (adding contract blocks wholesale is a bigger surface change than this audit). |
| every other undeclared emitter (bus, hooks, judge, learn, retrospect, spec, sweep, trace, plugins, provider, sinks, dogfood, goal, buildstamp, setup, mode extras, `contract dump` — the dump's schema *is* `contract/cli.json`, meta-recursive) | debug/introspection/mutation surfaces outside the contract. |

Exclusion is recorded here and as a one-line comment beside the
affected `contract` blocks in `plugins.ts`.

### 5. Output-vs-schema validation — `contract-schema.test.ts`

New test file `packages/cli/src/commands/contract-schema.test.ts`:

- **`validatorFor(schemaRel)`** — `Ajv2020` compile cached per `$id`.
- **Producers** — a `schemaRel → emit()` map that runs the REAL emit
  pipeline in a hermetic fixture and returns the parsed `--json`
  document. Every producer exercises the command's own
  assembly/serialization path, never a hand-written literal:

  | Schema | Producer |
  | --- | --- |
  | act-status | `fetchPrActState(fakeRev)` + `evaluateExitGate` → `{pr,exit_gate}` (same assembly as `cmdStatus`) |
  | agents-status | `runAgentsCommand(['status','--json','--connector',fixture])` — fixture connector via `registerAgentConnector`, captured stdout |
  | claim | `runClaimCommand(['list','--json'],{claims,dir})` — ClaimFacade stub |
  | debt-next/stats/trend | `runDebtCommand([sub,'--json'])`, `BRO_DEBT_DIR` → seeded `debt.jsonl` |
  | fleet | `collectFleet(dir)` → the same 8-field payload literal as `fleet.ts:613` |
  | fleet-hosts | `runFleetHostsCommand(dir,['--json'],{ledger})` — `ledgerFacade` fixture |
  | fleet-status | `collectStatus(dir)` in a `gitRepo()` fixture |
  | fleet-leases | `runFleetLeasesCommand(dir,['--json'],stateHome)` — seeded via `localLeaseStore().acquire` |
  | fleet-resume | `runResumeCommand(['--dry-run','--json'])` in an `initRepo` fixture (`BRO_AGENT_ID` unset) |
  | mode | `runModeCommand(['list','--json'],{dir,ledger,env})` |
  | next | `runNextCommand(['--list','--json'])` under the scripted-`bd` PATH shim (`next.test.ts` pattern) |
  | rig-status | `rigStatus(main,'test')` on an `initRepo` checkout |
  | rig-next | `rigNext(dir,item,{store})` — injected `TaskStore` stub |
  | sessions | `runSessionsCommand(['--json'],{ledger,dir})` — `ledgerFacade` fixture |
  | skills-list | `collectRows(root,cfg)` → `{command:'skills list',data:{rows}}` (same assembly as `cmdList`) |
  | skills-sync | `runSync(root,cfg,spawnStub,probeStub)` with a `local:` source → same `{command,data}` assembly as `cmdSync` |
  | watch | `collectSnapshot(dir)` in a bare fixture repo — planes degrade (`unavailable` fields), the shape stands |
  | watchdog | `runWatchdogCommand(['--json'])` in a tmpdir — probes degrade to `{unavailable}` |

- **Tests**
  - `emitted --json output validates against its schema` — per
    producer: parse → validate → `deepEqual(errors, [])` (error text
    included in the failure message).
  - `a field removal/rename fails validation` — per producer: drop a
    schema-required key (top-level object, else first array item) →
    assert INVALID. This is the pbfdp AC#2 proof — the same mutation
    an emitter refactor would ship.
  - `closed-world schemas reject an unknown field` — for every schema
    with `additionalProperties:false` at the validated level: inject
    `__bogus__` → assert INVALID (proves the schema would catch a
    renamed field *appearing* under a new name, not just
    disappearing).
  - `every contract json ref has a producer` — non-vacuity sweep:
    `schemaRefs(buildDump(PLUGINS))` ⊆ producer keys; a schema
    added without a producer fails the suite.
- Producers share fixtures with existing test files (`initRepo`,
  `tmpDir`, `ledgerFacade`, scripted `bd`) — no e2e/subprocess: the
  whole suite runs in `tsx --test` under `npm test`.

### 6. Docs

`contract/cli.json` regenerates (`npm run gen:contract`) — new
`json` refs + debt summary/subs land together. No engdocs change:
`site/content/docs/commands/debt.md` already documents `stats`/
`trend`; the generated reference pages pick the new subs up via
`gen:command-docs`.

## Non-goals

- No `--json` flags added or removed — schema coverage of the
  existing surface only.
- No schema for the excluded surfaces in §4 (table stands as the
  audit trail) and no contract blocks for the deferred reads
  (convoy next, wait, mesh) — follow-up bead.
- `fleet.schema.json`, `agents-status`, `sessions`, `mode`, `claim`,
  `next`, `rig-*`, `skills-list`, `fleet-hosts` schemas stay as they
  are — already non-stub; this bead does not re-tighten them.
- No runtime validation in the shipped CLI — validation is a CI-time
  contract check only (the emitters must not pay ajv's cost).

## Acceptance

- `debt-next` and `fleet-status` schemas are real shapes
  (`additionalProperties:false`); a DebtRecord/BroStatus field
  rename fails the contract-schema suite (proven by the mutation
  tests).
- `schemas/cli/{debt-stats,debt-trend,skills-sync,fleet-leases,
  fleet-resume,watch}.schema.json` exist, are referenced from
  `plugins.ts`, and resolve under `contract/cli.json`
  (`npm run check:contract` green).
- Every `json` ref in the live registry has a producer whose
  emitted output validates against the schema; per-producer
  mutation proofs (drop required field / add unknown field) fail
  validation.
- `npm run check:contract`, `npm test`, `npm run typecheck`,
  `npm run check:command-docs` green.
- The §4 audit table is the documented answer for every `--json`
  emitter not schema'd here.
