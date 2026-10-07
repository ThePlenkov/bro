# bro-9vmx — config layering: global user + committed project + local override

## Problem

One `bro.config.json` per checkout mixes two audiences. Committing it
(sverka PR #316) puts operator settings — providers with
`apiKeyCommand`/`subscription`, `judge`, `fleet` caps, `agents` spawn
templates — in front of reviewers next to real project policy
(`act.docsPaths`, `sdd.mode`, `guard.defs`). Not committing it loses the
policy. There is also no user-level layer at all: provider/subscription
wiring is re-declared (or silently missing) in every project.

## Design

Three layers, merged deep — precedence **local > project > global**:

| Layer | File(s) | Audience |
| ----- | ------- | -------- |
| global | `$XDG_CONFIG_HOME/bro/config.{ts,json}` (default `~/.config/bro/`) | This user's cross-project operator config — providers, judge, fleet caps, agent spawn templates, `beads.global` |
| project | `bro.config.{ts,json}` | Committed, identical-for-everyone policy — `act`, `sdd`, `guard`, `debt`, `stack`, `connectors` |
| local | `bro.config.local.{ts,json}` | Gitignored project-private overrides — autoApprove, machine paths, personal `maxSessions` |

Resolution per layer keeps today's rule: **cwd → main worktree root**
(linked worktrees inherit), `.ts` beats `.json` inside one dir, first
file found wins the layer. Layers merge over `DEFAULT_CONFIG`:

```text
defaults < global < project(cwd→main) < local(cwd→main)
```

Merge semantics:

- plain objects deep-merge; per key, higher layer wins
- arrays and scalars **replace**, never concat (`debt.sources`,
  `act.docsPaths`, `plugins`, `stores` all follow)
- the merged raw object runs through the existing normalization
  pipeline unchanged (`normalizeStores`, `applySections`,
  `normalizePluginSpecs`) — every section schema keeps its current
  per-field defaults, so a layer contributing only `providers` leaves
  `act` etc. at defaults or lower layers' values
- relative `plugins` specs anchor at their own layer's dir before the
  merge (containment rule unchanged — a spec escaping its anchor is
  dropped)

Back-compat: a lone `bro.config.json` keeps working — it is simply the
project layer with nothing above or below it. A **broken file** stops
its dir's remaining names (`.ts` precedence never promotes the sibling
`.json`) but the layer falls through to the next dir, exactly like the
old cwd → main-root fallback; when **no** layer loads at all and a
broken file was seen, `stores` collapses to `jsonl`-only — a half-read
file must never silently enable the beads projection.

### Section ownership (advisory)

Sections carry an owning audience. `doctor` warns — never blocks —
when one sits in the wrong layer:

- **operator** (`stores`, `personality`, `providers`, `judge`, `agents`,
  `fleet`, `beads`) found in the committed project file → warn:
  belongs in `bro.config.local.json` or `~/.config/bro/config.json`
- **policy** (`act`, `debt`, `sdd`, `guard`, `sweep`, `stack`,
  `connectors`, `query`, `drill`, `learn`, `watch`, `check`, `loop`,
  `drive`, `mesh`) found in the **global** file → warn: global policy
  silently applies to every project
- policy keys in `local` are a legal override but get listed in the
  provenance output — the local layer exists exactly for that

Ownership is **advisory, not enforced at load** — dropping `providers`
from a committed config would break clones that rely on it today;
migration is `doctor`-guided. (Rejected: hard layer enforcement —
turns a config-organizing feature into a breaking change.)

### Doctor surface

`bro doctor` config section becomes per-layer:

```text
✓ config     2 layers — project bro.config.json, global ~/.config/bro/config.json
✓ provenance act←project · sdd←project · providers←global · stores←default
! config     providers,judge in committed bro.config.json — operator config belongs to bro.config.local.json or ~/.config/bro/config.json
```

Provenance names the **winning** layer per set key (`default` when no
layer set it). Implementation: `loadConfigLayers(cwd)` in
`@broject/core` returns the per-layer `{ layer, dir, file, raw }`
records loadConfig consumed; doctor recomputes provenance from the
raws instead of re-reading files (one load path, one truth).

## Plan

- [x] Write spec (this file)
- [x] `packages/core/src/config.ts`: layer discovery + deep merge +
      `loadConfigLayers` export; global dir = `XDG_CONFIG_HOME/bro` or
      `~/.config/bro`
- [x] `packages/core/src/config.test.ts`: precedence, deep-merge,
      array-replace, broken-layer → jsonl-only, worktree inheritance per
      layer, plugin-spec anchoring per layer
- [x] `packages/cli/src/commands/doctor.ts`: layered config rows +
      provenance + ownership warnings (`SECTION_LAYERS` map exported
      from core)
- [x] `.gitignore`: `bro.config.local.*`
- [x] `site/content/docs/configuration.md`: layers section
- [x] `AGENTS.md`: convention line for the three layers
- [x] `npm test` (exact CI command), commit, push, ready PR
