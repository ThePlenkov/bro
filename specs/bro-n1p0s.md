---

scope:
- packages/core/src/brouter.ts
- packages/core/src/config.ts
- packages/core/src/index.ts
- packages/cli/src/commands/providers.ts
- packages/cli/src/agent-connectors.ts
- skills/providers/

---

# bro-n1p0s — brouter: model-centric provider routing registry

## Problem

Every route today starts at a provider name: `fleet.routing` chains are
`{provider, model}` pairs, `agents.<backend>.provider` names the entry
first, `fleet.profiles` pin provider then model. The model is always the
pin inside a provider-first selection. That inverts what a fleet on free
models actually decides: the work wants a MODEL — `swe-2-max`,
`opencode/space-bunny-free`, `typesafe/jev-1.13` — and any provider that
serves it will do. Asking "who runs model X" today means enumerating
`bro providers models` by eye; nothing resolves a bare model id to the
provider that serves it, and `--model` with no provider is only a
provenance label on the legacy template.

The model registry also has holes a live catalog can't fill: a tool-less
acp backend advertises no `configOptions` at `session/new` (spec
bro-wxfls), so its served models are enumerable nowhere — a static
declaration is the only way they become routable.

`brouter` is the model→provider registry: model ids are the routing key,
provider entries stay the connection records. `fleet.routing` answers
"which lane does this CLASS of work take"; brouter answers "who serves
THIS MODEL". bro-v0pvd.1's matrix (modes × complexity per model) binds
to model ids — this is the registry those ids resolve through.

## Terms

- **route name** — a canonical model id the operator declares in
  `brouter.models`; what consumers ask for (`--model`, `bro providers
  route`, future conductor/matrix lookups).
- **route** — one `providers.<name>` pick plus the upstream model id
  that provider serves (defaults to the route name). An ordered list of
  routes is the candidate set for a model.
- **catalog index** — provider → served model ids, sourced per kind the
  same way `bro providers models` enumerates (api allowlist offline,
  cli `models` template live, acp `configOptions` live, pinned `model`
  always). The registry's dynamic face.

## `brouter` section

A top-level core section — model-centric entries, not provider entries:

```jsonc
{
  "brouter": {
    "models": {
      "swe-2-max": "devin-acp",
      "jev": { "provider": "kilo-cli", "model": "kilo/orcarouter/typesafe/jev-1.13" },
      "cheap": ["opencode-free", "pi"]
    }
  }
}
```

A route value is a bare provider name, `{provider, model?}`, or an
ordered array of those — list order is preference order; the first
route is the primary pick. `model` is the upstream id the provider
serves (defaults to the route name) — the alias case, where the
registry key is a short name and the provider's served id differs.

Rules:

- **Absent/empty `brouter` = off.** No section, no routes — the
  provider-first resolution stands untouched (the "0 disables"
  precedent). Every route's provider must resolve to a configured
  `providers.<name>` — checked at use, naming the brouter key (sections
  parse independently, same rule as `fleet.routing` chain entries).
- **Route names are opaque ids** — no semantics inferred from the
  string; `__proto__`-safe like every config map.

## Resolution — `resolveModelRoute`

`packages/core/src/brouter.ts` — pure, IO-free: providers map + brouter
config + a caller-supplied catalog index → an ORDERED candidate list
`{provider, model}[]` (may be empty). First hit wins across sources:

1. **Qualified id** — `<head>/<rest>` where `head` is a configured
   provider: the route is that provider verbatim (`model` = the rest).
   A `head` that isn't a configured provider is not a qualifier —
   `opencode/space-bunny-free` on a registry with no `opencode`
   provider falls through to the bare-id sources (the vendor-namespace
   ids catalogs emit must never be eaten by a phantom provider split).
2. **Declared route** — `brouter.models.<id>`: its ordered routes; a
   route naming an unknown provider is a config error naming
   `brouter.models.<id>`, not a skipped entry.
3. **Catalog** — providers serving the id, in `providers` config order.
   Exact match only: family/prefix folding (`kilo/orcarouter/…` vs
   `typesafe/jev-1.13`) is a later spec — the ids are different served
   strings even when the upstream model is the same.

An empty result is _unresolved_, not an error — the caller owns the
verdict (a read surface reports it, a spawn path falls back to label
provenance). A `brouter` section never invents providers and the
catalog never invents models — both fail visible.

`brouterStaticCatalog(providers)` builds the offline index — api
allowlist keys + each entry's pinned `model`. Live enumeration (cli
template exec, acp `configOptions`) stays in the CLI layer; a spawn
must never pay a 30s catalog probe, so spawn-side resolution is
static-only.

## Surfaces

- **`bro providers route <model>`** — the read surface. Resolves with
  the LIVE catalog (the same per-kind enumeration `bro providers
  models` runs) and prints the primary route as `provider/model`;
  `--all` prints every candidate. Unresolved exits 1 naming the model —
  never silently empty.
- **`--model` with no provider** — the spawn seam. When neither
  `--provider` nor `agents.<backend>.provider` names an entry, a
  `--model` that resolves through the static index takes the primary
  route's provider (and its upstream model id); unresolved keeps
  today's label behavior — the registry adds routes, it never removes
  label semantics. A resolved route to a non-spawnable or unknown
  provider is the same config error the provider path already throws.

## Filetree

```text
packages/core/src/brouter.ts          BrouterConfig/Route types, section
                                      parse, resolveModelRoute,
                                      brouterStaticCatalog
packages/core/src/config.ts           brouter section — CORE_SECTIONS,
                                      BroConfig, DEFAULT_CONFIG, schema
packages/core/src/index.ts            exports
packages/cli/src/commands/providers.ts  `bro providers route <model>`
                                      (--all, live catalog)
packages/cli/src/agent-connectors.ts  env.brouter passthrough; --model-
                                      only → static-route provider pick
                                      in resolveSpawnProvider
skills/providers/                     brouter section + route verb
```

## Milestones

1. This spec.
2. `brouter` config section + core resolution + `bro providers route`.
3. `--model`-only spawn resolution through the static index.
4. Doctor rows — dangling `brouter.models` providers as warn rows.
5. Wall-aware multi-route picks — the candidate list is already
   ordered; skipping walled providers rides `deriveProviderWalls` and
   the M3 chain walk.
6. Capability fields on route entries (modes, complexity) — the
   bro-v0pvd.1 matrix binds here.
7. Family/prefix catalog matching — router-prefixed served ids folding
   onto upstream model ids (the conductor's pin resolver already
   strips prefixes; dedup is its own spec).

## Non-negotiables

- **Contracts stay vendor-blind.** A route is `{provider, model}`
  opaque labels — no vendor semantics leak upward; the registry
  resolves names into the same `SpawnSpec`/`ProviderEntry` seam.
- **Absent = off, declared = enforced.** No `brouter` → nothing
  changes. A declared route to an unconfigured provider is a config
  error, never a skipped entry; a catalog that can't enumerate is a
  smaller index, not an error.
- **Offline on the hot path.** Spawn resolution uses only statically
  known models; live catalog probes belong to the read surface. A
  model that matters gets declared.
- **Provenance says what ran.** A route's upstream `model` id — not
  the alias — is what lands in provenance (`BRO_AGENT_MODEL`, the
  registry entry); the alias is config vocabulary.

## Risks named up front

- **Qualifier collisions.** A provider literally named `opencode`
  would claim `opencode/…` ids that are vendor-namespaced model ids —
  the first-segment-is-a-configured-provider rule is the disambiguation
  and it errs toward bare-model resolution (a miss is recoverable; a
  phantom provider route is not).
- **Static/dynamic drift.** A declared route can go stale vs the
  provider's actual catalog (renamed model, expired free tier). The
  registry trusts declarations over catalogs — a lie there is the
  operator's own config, same trust as `providers` itself; `bro
  providers route --all` shows what the live catalog would have said.
