---
scope:
  - packages/cli/schemas/plans/
  - packages/core/src/plan.ts
  - packages/cli/src/commands/plan.ts
  - packages/cli/src/commands/contract-dump.ts
  - packages/*/src/plan.ts
  - skills/*/SKILL.md
  - contract/cli.json
---

# bro-hp0su — contract: publish plan schemas as JSON Schema

Parent epic: bro-6ptci (CLI is the agent contract). Sibling of
bro-6ptci.2 (PR #1070), which shipped `schemas/cli/*.schema.json`
for `--json` *outputs* plus the Ajv2020 harness. This bead is the
plan-*input* side: the TOML plans agents author for `bro run`.

## Problem

AGENTS.md promises "plan payload validated against a per-command plan
schema", but no `*.schema.json` is shipped for plans — agents author
them blind:

1. `bro plan` lists only `kind + version`. The contract a plan file
   must satisfy lives exclusively inside each plugin's `planSchema`
   TypeScript function (`unknown → T`) — invisible to an author until
   `bro plan validate` throws.
2. `plans may carry $schema` is the bead's own acceptance — today the
   parsers *reject* `"$schema" = "…"` as an unknown top-level key.
3. Skills that teach plan authoring (`query`, `wtf`, `next`) inline
   TOML examples with no pointer to a machine-readable contract; the
   examples and the parsers drift unchecked.

## Design

Seven plan kinds exist (plugins with `planSchema` + `runPlan`):
`act`, `convoy`, `debt`, `drill`, `next`, `query`, `retrospect`.

### 1. `schemas/plans/<kind>.schema.json` — one per kind

JSON Schema draft 2020-12 (same convention as `schemas/cli/`:
`$id` = `https://broject.dev/schemas/plans/<kind>.schema.json`, files
ship via the package's `files: ["schemas"]`). Each schema describes
the **parsed plan document** — the TOML→object shape `planSchema(doc)`
consumes:

- closed world: `additionalProperties: false` at every level, keys
  are the parser's allowlists;
- `kind`: `const <kind>` — the `bro run` envelope requires it;
- `version`: `integer, minimum 1, maximum <PLAN_VERSION>` — the pin
  contract, drift-coupled to the plugin's `PLAN_VERSION` constant;
- `$schema`: optional string — an authored plan may pin the schema
  URL (same convention as `bro.config`'s `$schema`);
- enums, `required`, `minItems`, non-empty-string `minLength: 1` —
  the structural slice;
- `examples`: one canonical valid document embedded in the schema —
  `bro plan describe` prints it and the drift suite feeds it through
  the real parser.

Cross-field semantics stay in the `planSchema` functions — the single
validation pipeline the audit mandates: act's reply-requires-comment /
defer-requires-title, convoy's needs-DAG + no-duplicate-ids +
gates=forbid-means-no-human-steps, drill's `under` indexing, query's
read-only GraphQL gate and forbidden env overlay. The schema is the
authoring/discoverability contract, **not a second validator** —
"schema-valid ⇒ parser-valid" on the structural slice is what the
drift tests prove, and each file's `description` says which checks
remain semantic.

Notable encodings: convoy's molecule is a `oneOf` of two closed
shapes (formula-pour vs inline-steps — a table carrying both or
neither matches zero arms, mirroring the parser); query's `env` uses
`propertyNames.not.enum` for the ATLASSIAN_API_URL/PATH/HOME ban.

### 2. `$schema` becomes an envelope key

`packages/core/src/plan.ts` exports `PLAN_ENVELOPE_KEYS =
{'kind','version','$schema'}`; the seven parsers' top-level key
allowlists become `envelope ∪ kind-keys` instead of repeating
`kind`/`version`. No other behavior change — the value is not
verified.

### 3. `bro plan describe <kind> [--json]`

New subcommand on the `plan` plugin (audit recommendation — "for each
plan kind the CLI returns the structural schema, version and a
resolver-passing example"):

- `--json`: `{kind, version, schema}` — `schema` is the shipped
  file's content verbatim (examples included).
- human: `act — plan schema v1 — schemas/plans/act.schema.json`
  followed by the schema's `examples[0]` rendered as TOML via
  `smol-toml`'s `stringify` — a ready-to-edit template, the plan-side
  twin of `bro retrospect schema`.

The file resolves from the package root by walking up from
`import.meta` to the dir holding `schemas/plans/` — `src/commands`
in dev, `dist/` in a bundle, `node_modules/@broject/bro` installed.
A kind with no shipped file (an external plan kind — externals can't
ship files into this package) is an explicit error.

`bro plan validate` itself is unchanged: the bead's "uses the same
schema" is the single shared pipeline (`resolvePlanDoc` — TOML →
kind routing → version gate → `planSchema`), which already rejects an
invalid fixture with a pointer to the field. No runtime ajv — the
6ptci.2 non-goal stands: schema validation is a CI-time contract
check, the semantic validator stays the only executor.

### 4. Contract dump carries the ref

`ContractCommandRow` gains `planSchema?: string` — derived by
convention (`schemas/plans/<name>.schema.json`) for every non-external
plugin that accepts plans, emitted next to the existing
`plan`/`planVersion` fields. `contract/cli.json` regenerates via
`bro contract gen`. The `json schema refs` disk-resolution test gains
a plan-ref walk over `dump.commands[*].planSchema` — convention
derivation makes a missing file fail CI the day a kind is added
without one. Externals derive no ref (their files can't live in this
package).

### 5. Drift gate — `plan-schema.test.ts`

Same Ajv2020 harness pattern as `contract-schema.test.ts`:

- every `schemas/plans/*.schema.json` compiles;
- every plan-capable live plugin has a schema file **and** the file's
  kind const matches the plugin name (non-vacuity);
- `schema.properties.version.maximum === plugin.planVersion` — a
  `PLAN_VERSION` bump without a schema bump fails;
- `examples[0]` validates against its own schema **and** passes the
  real `planSchema` parser (the audit's "resolver-passing example");
- per-kind valid + invalid fixtures: schema-rejected docs carry an
  `instancePath` pointer; parser-rejected docs carry the field name —
  and each invalid fixture fails **both** (the two layers can't
  drift apart on the structural slice);
- a doc carrying `"$schema"` passes the real parser for every kind.

### 6. Docs

- One line in each plan kind's `SKILL.md` (`act`, `debt`, `convoy`,
  `next`, `drill`, `wtf` ← retrospect, `query`): the schema file +
  `bro plan describe <kind>`; woven into existing plan sections where
  they exist.
- AGENTS.md "Unified plans" bullet gains the `schemas/plans/` pointer.
- `plan` plugin summary advertises `list|validate|describe`;
  generated command docs regenerate (`gen:command-docs`).

## Non-goals

- No runtime ajv in the shipped CLI (6ptci.2 non-goal stands); the
  planSchema function stays the single validation pipeline for
  `bro plan validate` and `bro run`.
- No `$schema` *value* verification — the key is accepted, not
  resolved.
- No schema for plan *execution output* — input contract only.
- No cross-field/semantic checks duplicated into JSON Schema (§1).

## Verify

- `packages/cli/src/commands/plan-schema.test.ts` — compile, kind
  coverage, version-maximum, example-through-parser, dual-layer
  rejection, `$schema` tolerance.
- `packages/cli/src/commands/plan.test.ts` — describe subcommand:
  `--json` emits kind+version+schema, human prints TOML example,
  unknown/plan-less kinds error.
- `packages/cli/src/commands/contract.test.ts` — plan refs resolve
  on disk; `contract/cli.json` regenerated, `npm run check:contract`
  green.
- `npm run build`, `npm run typecheck`, `npm test`,
  `npm run check:command-docs`, `npm run check:docs` — CI-identical.
