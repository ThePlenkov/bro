---

scope:
- packages/pack/
- scripts/gen-pack.ts
- scripts/check-pack.ts
- packages/core/src/pack.ts
- packages/core/src/config.ts
- packages/core/src/connectors.ts
- packages/cli/src/commands/setup.ts
- packages/cli/src/commands/pack.ts
- packages/cli/src/commands/doctor.ts
- packages/cli/src/skills-data.ts
- packages/cli/src/embedded.ts

---

# bro-5phkq — pack format: manifest, sections, composition rules

## Problem

`@broject/bro-pack` ships `skills/` + `formulas/` as bare trees — no
manifest, no versioned contract, and no room for the other capability
kinds the aggregator epic (bro-y4njw) needs to compose: guard defs,
provider presets, hook connector entries. Today:

- `bro setup --pack` resolves `<spec>/package.json`, requires `skills/`,
  explodes both trees into `.agents/skills/` and `.beads/formulas/` —
  provenance (which pack, which version) is lost the moment files land.
- The config-owned capabilities have no distribution channel: a guard
  ships only as a hand-edit to `guard.defs[]`, a provider preset only as
  a hand-edit to `providers`, a hook connector (bro-u8e8m's
  `hooks.connectors[]`) has nothing to ride in on.
- One pack at a time: `--pack` takes a single spec, and two packs
  carrying the same skill name have no defined answer.
- Pack install and pack authoring share no artifact: `gen-pack.ts`
  copies trees into `packages/pack/` but emits nothing a consumer could
  introspect (`package.json` tells npm, not bro).

The aggregator needs one manifest format — the unit that hook
connectors (bro-u8e8m) and the skills-lock workflow (bro-c1z1x) both
consume, and that `@broject/bro-pack` dogfoods as the reference pack.

## Design

### Physical shape

A pack is a **self-contained npm package** — the existing contract:
resolution through `<spec>/package.json` (`resolvePackDir`: the
project's `node_modules` first, then the CLI's install tree), no
symlinks followed (`readPackTree`/`lstat`). At the package root, beside
`package.json`, sits **`pack.json`** — the manifest. File payloads stay
trees: `skills/<name>/…`, `formulas/*.formula.toml`. Everything else is
inline JSON in the manifest — one schema surface, nothing second-class.
The manifest references `https://unpkg.com/@broject/bro/schemas/pack.schema.json`
so that schema must be published with the CLI (see below) and any
pack.schema.json artifact required by the manifest must be included in
published packages.

Backward compatibility: a package without `pack.json` resolves as the
legacy manifest `{skills: <every dir under skills/>, formulas: <every
file under formulas/>}` — today's 0.2.5 pack stays installable.

### `pack.json` schema

```jsonc
{
  "$schema": "https://unpkg.com/@broject/bro/schemas/pack.schema.json",
  "name": "@broject/bro-pack",      // must equal package.json name
  "version": "0.3.0",               // must equal package.json version
  "requires": { "bro": ">=0.2.5" }, // semver range vs the running CLI
  "skills": ["act", "drill"],        // optional subset of skills/ dirs
  "formulas": ["ship-bead.formula.toml"], // optional subset of files
  "guards": [
    { "name": "…", "when": { "on": ["stop"], … }, "say": "…" }
  ],
  "providers": {
    "typesafe": { "type": "api", "baseUrl": "…",
                  "models": { "jev-latest": "systemone" },
                  "apiKeyEnv": "TYPESAFE_API_KEY" }
  },
  "hooks": [
    { "event": "stop", "command": "…",
      "timeoutMs": 5000, "failOpen": true }
  ]
}
```

Field rules — validation **reuses the existing validators**, no new
DSLs:

- `skills` / `formulas`: member lists over the trees. Absent → the whole
  tree (back-compat). An entry naming a member the tree doesn't carry
  fails the pack — a typo'd name is a defect, not a partial install.
- `guards`: `Guard` objects, the exact `guard.defs[]` schema —
  `guardProblems()` validates; a malformed def fails install (pack defs
  are authored content like config defs — fail closed, not the
  connector contributions' fail-open).
- `providers`: name → `ProviderEntry`, the `providers` config schema —
  `parseProviderEntry`/`PROVIDER_REGISTRY` is the base validator, but
  manifest validation is **strict** where config is forgiving:
  `parsePack` uses an error-returning variant (never warn-and-drop)
  and an invalid entry _fails the pack_ (config's warn-and-drop exists
  for a hand-edited file; a published manifest is authored content —
  same fail-closed rule as `guards`). Unknown fields on a provider entry
  fail too — a typo'd `apikeyEnv` silently dropping the key source is a
  pack defect, not forward-compat; `parsePack` rejects any keys not in
  the ProviderEntry allowlist. `apiKeyEnv` names a variable and
  `apiKeyCommand` runs a lookup; beyond the config validators
  (`isEnvName`, the inline-key denylist — which admits ALL-CAPS literals
  and key shapes outside its patterns) a pack screens both fields for
  credential-shaped values, since a published manifest carrying a literal
  key is a leaked secret, not a config error. A preset is a default, not
  an activation: it resolves only when a consumer names it
  (`judge.provider`, `agents.<backend>.provider`, `fleet.profiles.*`),
  so an unreferenced preset spends nothing and calls nothing.
- `hooks`: `{event, command, timeoutMs?, failOpen?}` — the
  `hooks.connectors[]` entry shape bro-u8e8m specifies; event names are
  that spec's set. Commands execute on every matching event — this is
  the pack's executable surface, gated by the arming rule below.
- `requires.bro`: checked at install; unsatisfied → refuse before any
  mutation.
- `name`/`version` must equal `package.json`'s — `gen-pack` stamps both
  from one source; a mismatch is a pack defect — install **refuses**
  before any mutation (never a warning; a warning would still let the
  lock and provenance records state a false identity), and the repo-side
  `check:pack` fails.
- Unknown top-level keys warn and are ignored (forward compat — the
  config-file convention).

### Composition rules — `bro setup --pack a,b`

Packs compose as an **ordered set processed left→right**. v1 rule:
**identical merges, differing errors** — no silent shadow.

| Section                                          | Same key, identical content | Same key, different content               |
| ------------------------------------------------ | --------------------------- | ----------------------------------------- |
| `skills`, `formulas` (file payloads, by relpath) | dedupe                      | **error** — names both packs and the path |
| `guards` (by `name`)                             | dedupe                      | **error** — names both packs and the def  |
| `providers` (by entry name)                      | dedupe                      | **error**                                 |
| `hooks` (by full entry equality)                 | dedupe                      | concatenate — both run, in pack order     |

First-wins was rejected: a pack that silently loses a skill or guard to
an earlier pack is a broken install the operator never sees. Erroring
makes the collision a decision — drop a pack, or rename in the pack.

Repo and config content **always outranks** pack content:

- An existing `.agents/skills/<name>` with different content is a
  collision, not an overwrite — today's `installFiles` warns _and
  overwrites_, which is right for `--skills` (reinstalling canonical
  content) but wrong for a pack: a locally-modified file is operator
  content, so pack install warns, keeps the local file, and reports the
  skipped member at the end. Reinstalling over a local edit is an
  explicit `bro pack update` decision — out of v1.
- `collectGuards` order gains the pack source **between** config and
  connectors: config defs → pack defs (install order) → connector
  guards. The existing earlier-wins dedupe makes a pack def shadowed by
  a config def the designed outcome — the repo can always veto a pack.
- `providers` presets merge **below all config layers** — a preset is
  the default of last resort; an operator `providers.<same-name>` entry
  (global or local layer) replaces the preset wholesale, never
  field-merges.
- The whole set validates **before any mutation** — the existing
  `checkedPackDir` precondition extends to manifest parse + composition,
  so a bad pack fails setup on a clean tree, not a half-written one.

### Materialization — files explode, defs resolve

Two channels, by content kind:

1. **File payloads explode** into the trees clients already read:
   - `skills/` → `.agents/skills/<name>/`, plus a `skills-lock.json`
     entry `{sourceType: "pack", source: "<pack>@<version>",
     computedHash}` — the seam bro-c1z1x's `bro skills add|update|remove`
     manages (an installed-by-pack skill is distinguishable from a
     vendored or local one).
   - `formulas/` → `.beads/formulas/` — only when a beads store is
     active (today's `wantsBeads` rule).
2. **The pack installs as a unit**: `.agents/packs/<slug>/` holds the
   resolved `pack.json` plus `install.json` provenance
   `{name, version, spec, hooksArmed, manifestHash}` — the audit,
   upgrade, and uninstall unit (removing the dir removes the pack's def
   contributions). Committable like `.agents/skills/`.
3. **Def contributions resolve at load time, never copied into config**:
   - guards: `collectGuards` reads installed manifests as the `pack`
     source (see order above).
   - providers: config load merges installed presets under all layers.
   - hooks: installed entries join `hooks.connectors[]` resolution
     (runtime is bro-u8e8m's) tagged `source: "pack:<name>"`, gated on
     the install receipt's `hooksArmed` — `bro setup --pack x
     --with-hooks` (or `bro pack arm <name>`) records consent.
     `manifestHash` (sha256 over the resolved `pack.json`) binds that
     consent to the armed content: an entry resolves as armed only
     while the installed manifest still hashes to the receipt's value —
     a post-install manifest edit drifts the hash, disarms the pack's
     hooks (`bro pack list`/`bro doctor` show the drift; `bro pack arm`
     re-arms explicitly), so an armed command can never be swapped out
     under a stale receipt. Unarmed entries are listed but never
     executed.

`pack` stays the config key for the default pack; `packs: string[]`
joins it as the committed baseline — a bare `bro setup --pack` installs
`packs ?? [pack] ?? [@broject/bro-pack]`, while `--pack a,b` installs
exactly the listed set without touching config.

### The two materializers

- **Authoring side (this repo)**: root `skills/` + `formulas/` stay the
  single source of truth. `gen-pack.ts` grows to emit `pack.json`
  (name/version synced from `packages/pack/package.json`, member lists
  from the trees); `check:pack` mirrors `check:plugins`/`check:embedded`
  as the CI freshness gate.
- **Consumer side**: `bro setup --pack` is the materializer — resolve,
  validate, compose, install. `gen-plugins` is unchanged: it renders the
  repo's own trees into per-client adapters (`plugins/*/bro/`) and does
  not run on consumers.

### `@broject/bro-pack` — the reference pack

The canonical example and the default `pack` value. It carries the
repo's full `skills/` + `formulas/` trees today and gains the emitted
`pack.json` in v1 — the schema sections this spec defines (`guards`,
`providers`, `hooks`) are populated by packs as their content requires;
the reference pack is the format's proof, not a mandate that every
section be non-empty. The repo's own `guard.defs[]` are bro-project
policy — they are NOT reference-pack content.

## Non-goals

- Pack registry/discovery (`bro pack search`) — npm is the transport;
  a curated index is separate work.
- Transitive pack dependencies — npm `dependencies` already expresses
  package→package; composition is the consumer's flat list. No version
  solver: conflicts error, they never resolve silently.
- `bro skills` mechanics and lock ownership — bro-c1z1x; this spec pins
  only the `sourceType: "pack"` entries install writes.
- Hook connector runtime — bro-u8e8m; this spec pins only the entry
  shape and the arming record.
- Git-repo packs (gascity-style `gc pack fetch`) — npm specs only.

## Filetree

```text
packages/core/src/pack.ts            pack.json schema + parsePack —
                                     reuses guardProblems, parseProviderEntry;
                                     composition planner (merge → conflict report)
packages/core/src/config.ts          `packs` key; providers merge gains
                                     the installed-pack preset layer
packages/core/src/connectors.ts      collectGuards gains the pack source
packages/cli/src/commands/setup.ts   multi-spec resolution, composition,
                                     .agents/packs install, lock entries
packages/cli/src/commands/pack.ts    bro pack list|arm|disarm (facade)
packages/cli/src/commands/doctor.ts  pack rows — installed, armed hooks,
                                     shadowed presets
packages/pack/pack.json              emitted manifest (reference pack)
packages/pack/package.json           `files` gains `pack.json` — the
                                     manifest must reach the tarball
packages/cli/schemas/pack.schema.json  the $schema target — editor
                                     schema published with the CLI
                                     (mirrors bro.config.schema.json)
scripts/gen-pack.ts                  trees + manifest emission
scripts/check-pack.ts                freshness gate (mirrors check:plugins);
                                     also asserts the npm tarball carries
                                     pack.json and any required schema
                                     (npm pack --dry-run)
```

## Plan

- [x] bro-5phkq this spec
- [ ] `packages/core/src/pack.ts` — manifest schema, `parsePack`
  (strict provider validation — error-returning variant, unknown
  fields fail, credential-shape screen; guardProblems reuse),
  composition planner
- [ ] `packages/cli/schemas/pack.schema.json` — the published `$schema`
  target (rides the CLI tarball's existing `schemas/` entry)
- [ ] `gen-pack.ts` emits `pack.json` (and any required schema artifact);
  `packages/pack/package.json` `files` gains `pack.json` (and schema
  if referenced); `scripts/check-pack.ts` + `npm run check:pack` in CI
  (freshness + `npm pack --dry-run` asserts the tarball carries the
  manifest and any required schema)
- [ ] setup: multi-spec `--pack a,b`, validate-then-mutate, conflict
  errors, `.agents/packs/` unit install, skills-lock `pack` entries
- [ ] config `packs` key; providers preset layer; `collectGuards` pack
  source
- [ ] `bro pack list|arm|disarm`; doctor rows
- [ ] tests: pack.ts units; setup.test.ts matrix (subset lists,
  conflict → clean failure, legacy no-manifest pack, hooks unarmed)

## Verify

- `npm test` (`tsx --test` — the CI command), `npm run typecheck`,
  `npm run build`, `check:plugins`, `check:embedded`, `check:pack` green.
- e2e scratch repo: `--pack a,b` union install; a differing-skill
  conflict exits non-zero before any file lands; a pack without
  `pack.json` installs as legacy; `--with-hooks` flips `hooksArmed`;
  editing the installed `pack.json` drifts `manifestHash` and disarms
  hooks until re-armed.
- `bro guard list` shows a pack-sourced def; `bro guard test` fires it.
- A pack provider preset resolves when `judge.provider` names it; an
  operator entry of the same name shadows it wholesale.
