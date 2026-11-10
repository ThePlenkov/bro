---

parent: bro-6ptci
scope:
- packages/core/src/config.ts
- packages/core/src/config-schema.ts
- packages/core/src/agents.ts
- packages/cli/src/plugins.ts
- packages/cli/src/agent-connectors.ts
- packages/cli/src/commands/doctor.ts
- packages/cli/src/commands/setup.ts
- packages/cli/src/commands/next.ts
- packages/cli/schemas/
- scripts/gen-config-schema.ts
- .github/workflows/ci.yml
- bro.config.json

---

# bro-d9dmx — contract: bro.config JSON Schema generated from the config section registry

Parent: `bro-6ptci` (epic — CLI is the agent contract). Sibling:
`bro-k9ces` (`bro contract dump --json` over the command surface) — this
bead covers the _config_ half of the same machine-readable contract.

## Problem

`bro.config.*` is validated by hand: every section is a
`ConfigSection<T>` normalizer that silently drops malformed fields and
falls back to `schema(undefined)` on a throw
(`applySections`, config.ts). Two consequences:

- **Invalid config reads as absent config.** `fleet.maxConcurrent: '1'`
  normalizes to the default `3`; `sdd.mode: 'gtae'` normalizes to
  `off`; `connectors.tasks: 42` is dropped — the user sees a fallback
  they never asked for and only a stderr line hints at it (some fields
  don't even warn).
- **No `$schema` for autocompletion.** IDEs and agents writing
  `bro.config.json` have no machine-readable shape to complete or
  validate against; every client re-derives the surface from prose.

The audit criterion (bro-l8c4f, config-policy finding) adds the
behavioral half: diagnostics must name the **layer** a bad value came
from, an **authoritative command** (spawn / claim) must refuse invalid
_policy_ config before its side effect, and hooks must keep working
fail-open with diagnostic + fallback.

## Design

### 1. Every section declares its input schema

`ConfigSection<T>` gains an optional `jsonSchema` slot:

```ts
export type ConfigSection<T> = ((raw: unknown) => T) & { jsonSchema?: JsonSchema };
```

Each registered section attaches a hand-written JSON Schema (draft-07
subset) **next to its parser** — `sddSection.jsonSchema = {…}` in the
same file. Hand-written, not zod-derived: the normalizers accept
shapes zod can't express cheaply (sync's string passthrough, provider
`models` as map _or_ catalog-command string, `string | false` knobs),
and core stays dependency-free (only `smol-toml` today).

The schema describes the _accepted input_, not the normalized output —
it must admit every value the parser accepts and flag what the parser
drops. Semantics beyond shape (secrets-in-command guards, model
allowlists, `mesh://` enforcement) stay in code.

Registry plumbing stays untouched — the schema rides on the section
function itself, so `CORE_SECTIONS` and `pluginConfigSections()` both
expose it without a second registry:

- `coreConfigJsonSchemas()` in core — `configKey → fn.jsonSchema` over
  `CORE_SECTIONS`.
- `pluginConfigJsonSchemas()` in cli/plugins.ts — same over plugin
  `configKey`/`configSchema` pairs (external plugins may declare one
  via the same optional slot).

### 2. Generated document — `schemas/bro.config.schema.json`

`scripts/gen-config-schema.ts` merges `pluginConfigJsonSchemas()` with
`coreConfigJsonSchemas()` (core wins on collision, same rule as
`applySections`) and emits one draft-07 document:

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://unpkg.com/@broject/bro/schemas/bro.config.schema.json",
  "type": "object",
  "properties": {
    "$schema": { "type": "string" },
    "stores": { "type": "array", "items": { "enum": ["jsonl", "beads", "gitref"] } },
    "personality": { "enum": ["terse", "mentor", "sarcastic"] }
    // … one entry per registered section
  },
  "additionalProperties": true // external plugins own their configKeys;
  // doctor owns the unknown-key typo check
}
```

The file lives at `packages/cli/schemas/bro.config.schema.json` so it
ships inside the published `@broject/bro` package (`files` adds
`schemas`). The same document serves global/project/local layers —
which sections belong to which layer is doctor's
`CONFIG_SECTION_LAYERS` concern, not the schema's.

Root scripts: `gen:config-schema` (write) and `check:config-schema`
(`--check` diff, same convention as `gen:plugins`/`check:command-docs`).
CI gets a `check:config-schema` step **after** `npm run build` — the
script reads the section registry from built sources, same dependency
as `check:command-docs`.

### 3. Runtime validation — `packages/core/src/config-schema.ts`

- `validateSchemaValue(value, schema, path)` — a mini draft-07
  validator covering only the keywords the section schemas use:
  `type`, `enum`, `const`, `required`, `properties`,
  `patternProperties`, `additionalProperties` (bool or schema),
  `items`, `anyOf`, `oneOf`, `minimum`, `maximum`, `minLength`,
  `minItems`, `pattern`. Returns `{path, message}[]` — no dependency.
- `configDiagnostics(cwd, sections, only?)` — walks
  `loadConfigLayers` (the same read `loadConfig` uses, so worktree
  inheritance and layer precedence are identical) and validates each
  layer's `raw` against the registered schemas. Returns
  `{layer, file, key, path, message}[]` — layer + file provenance is
  the audit's "источником слоя" requirement.
- `configPolicyErrors(cwd, sections)` — diagnostics restricted to
  policy-classified sections (`CONFIG_SECTION_LAYERS`). Operator-class
  sections are machine-local by definition; they warn, they don't gate.

### 4. `bro doctor` — invalid vs defaulted, `--strict`

New `config-schema` check rows, one per layer file carrying
diagnostics:

- Default run: each diagnostic is a `warn` row —
  `config — project bro.config.json: sdd.mode must be one of
  off|remind|gate — got "gtae"`. A clean config reports
  `ok` per layer. "Invalid" (schema violation) is now distinguishable
  from "defaulted" (section absent) — previously both rendered as the
  same silent fallback.
- `bro doctor --strict`: diagnostics report as `fail` — doctor's
  existing exit-code rule (any fail → exit 1) makes `--strict` the
  CI/gate verdict.

### 5. Mutation gate — policy config must be valid before side effects

`assertMutableConfig(dir)` in cli/plugins.ts throws a
`ConfigPolicyError` listing every policy-section diagnostic with its
layer/file source. Wired into the two authoritative choke points the
audit names:

- **`prepareSpawn`** (agent-connectors.ts) — every agent spawn path
  (`agents up`, loop workers, convoy runners, drive fixers) refuses
  before claim/registry writes.
- **`bro next`** claim path — before `claimUpTo` runs `bd update
  --claim` (project scope only; the global store carries no repo
  policy).

Escape hatch: `BRO_CONFIG_FORCE=1` — the "осознанный override" the
audit allows. The gate runs only on _policy_ sections (act, sdd,
connectors, guard, …); a malformed `providers`/`fleet` entry is
operator config — it diagnoses and warns, never blocks a spawn that
doesn't consume the broken section.

Fail-open stays the default everywhere else: `loadConfig`, hooks,
guards, and every read path are unchanged — diagnostics are computed
only where a command asks for them.

### 6. `$schema` written by `bro setup` + repo dogfooding

`bro setup` writes `"$schema"` as the first key of a new
`bro.config.local.json` pointing at
`https://unpkg.com/@broject/bro/schemas/bro.config.schema.json` (unpkg
serves the shipped file; version-agnostic — the schema is additive
within a major). This repo's own `bro.config.json` gets `$schema` too —
the acceptance criterion (repo config validates against the generated
schema) is exercised by a test that runs the document over the
committed file.

## Plan

- [ ] `specs/bro-d9dmx.md` (this file)
- [ ] core `config-schema.ts`: `JsonSchema` type, `ConfigSection`
  gains `.jsonSchema`, mini validator, `configDiagnostics`,
  `configPolicyErrors`, `configSchemaDocument`, `CONFIG_SCHEMA_URL`
- [ ] `.jsonSchema` on every registered section (core: debt, sync,
  sweep, act, connectors, providers, sdd, fleet, query, mesh, mcp,
  mirror, notify, serve, beads, stack, agents; plugins: loop,
  watch, drive, check, drill, learn, goal, judge, guard, freshness,
  telemetry, rig)
- [ ] `pluginConfigJsonSchemas()` + `assertMutableConfig` in
  cli/plugins.ts; gate wired into `prepareSpawn` + `next` claim
- [ ] doctor `config-schema` rows + `--strict`
- [ ] `bro setup` writes `$schema`; `bro.config.json` gets it
- [ ] `scripts/gen-config-schema.ts`, root `gen:`/`check:` scripts,
  `packages/cli` `files`, CI step

## Verify

- `npm run build && npm run typecheck && npm test` (the CI commands).
- `npm run gen:config-schema && npm run check:config-schema` — emitted
  file is fresh.
- `configDiagnostics`/`validateSchemaValue` unit tests: malformed
  fleet cap, sdd mode, connector pin report errors naming the layer;
  valid cross-layer overrides and main-worktree `bro.config.local.*`
  inheritance produce zero diagnostics (audit criteria).
- `bro doctor` on this repo: config rows ok; `bro doctor --strict` in a
  scratch repo with `sdd.mode: "gtae"` exits 1 naming the file.
- Gate: `BRO_CONFIG_FORCE` unset → `bro next`/`agents up` refuse a bad
  `sdd.mode`; set → refuse lifted. Hooks unaffected (fail-open path
  untouched).
