# Package-extraction analysis — PR #873 (bro-l8wqu session pane)

Scope: `plugins/herdr/tui/**`, `plugins/herdr/src/**` (lane/live-view changes),
`packages/providers/src/acp-*.ts`, `packages/cli/src/commands/{session-feed,fleet-state,herdr-session-view,herdr-projector}.ts`.
+13,961 / −700 across 63 files. Analysis only — no implementation.

## 1. How the code is actually wired today

```
providers/acp-events.ts ──writes──► <common>/bro/agents/<id>.events.jsonl ◄──reads──┐
 (agentTurnPlane, agentEventRecord — the row schema lives only in its writes)      │
                                                                                 │
   readers: cli/session-feed.ts (ArchiveRow, parse, tail, verdict)                │
            ├── cli/herdr-session-view.ts  (line-mode pane, AcpRenderer)          │
            ├── cli/herdr-projector.ts     (writes fleet-status docs)             │
            ├── plugins/herdr/tui/main.ts  (OpenTUI shell — DEEP source imports   │
            │        ../../../packages/cli/src/commands/*.ts)                     │
            └── plugins/herdr/tui/{model,view,impl,acp/*}.ts                      │
                     └── DEEP source imports into packages/providers/src/*.ts     │
plugins/herdr/src/acp-render.ts = BYTE-IDENTICAL COPY of providers/acp-render.ts  │
                     └── consumed by plugins/herdr/src/acp-watch.ts               │
```

Three different smuggling mechanisms carry the SAME seam across package borders:

1. **Byte-identical copy** — `plugins/herdr/src/acp-render.ts` (646 lines) ≡
   `packages/providers/src/acp-render.ts`. Cause: `plugins/herdr` is outside the
   npm workspace (`workspaces: ["packages/*"]`) and can't declare deps, so the
   file was vendored. Consumer: `acp-watch.ts`.
2. **Deep relative source imports** — `tui/*.ts` reaches into
   `packages/cli/src/commands/{fleet-state,session-feed,herdr-session-view,
   plugins}.ts` and `packages/providers/src/acp-render.ts` by filesystem path.
   Works only because Bun/Node-22 run raw `.ts`; it pins every consumer to the
   repo layout and bypasses each package's declared public surface.
3. **Implicit file contracts** — the `.events.jsonl` row schema
   (`kind:'update'|'turn'|'prompt'|'permission'`, `ts/by/session/key`), the
   `<id>.events.jsonl` naming, and the sibling `.prompt.md` derivation are
   re-derived by convention on ≥4 independent sites (writer `archiveFile`,
   projector `join(agentsHome, ...)`, live-views `stem.events.jsonl`,
   tui `--agent` resolution, `readPrompt`'s `.replace`).

## 2. Concrete duplications found (all must converge)

| What                                                                         | Copies | Sites                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-render.ts` whole file                                                   | 2      | `packages/providers/src/acp-render.ts` ≡ `plugins/herdr/src/acp-render.ts` (diff = 0)                                                              |
| permission line text `── ⚠ permission ‹…› — <verdict> (headless driver…) ──` | 4      | `tui/model.ts` `side()`, `tui/acp/model.ts` `permissionItem()`, `cli/herdr-session-view.ts` `eventRow()`, `acp-render.ts` `permission()`           |
| `PLAN_BOX` + `── plan ──` block                                              | 3      | `tui/model.ts` `onPlan()`, `tui/acp/model.ts` `planItem()`, `acp-render.ts` `onPlan()`                                                             |
| internal-call storm batch (`▸ N internal calls`)                             | 2      | `tui/model.ts` `micro*` machinery vs `tui/acp/model.ts` `buildStorms`/`stormItem` — same addendum-27 feature in two vocabularies                   |
| `shortBy`/`headBy`/`isInternalBy` provenance labels                          | 2      | `tui/view.ts` vs `tui/acp/model.ts` (private re-impl)                                                                                              |
| `eventsOf` (ArchiveRow → ModelEvent[])                                       | 2      | `tui/spike-feed.ts` vs `tui/acp/model.ts` (acp adds `prompt_error`)                                                                                |
| `at()` row→ms                                                                | 2      | `spike-feed.ts`, `acp/model.ts`                                                                                                                    |
| ANSI/control sanitize                                                        | 3      | `safe`/`safeBlock` (acp-render, ×2 copies) and `plain()` in `cli/herdr-status-view.ts` — same job, three names                                     |
| archive tail pump (offset read + torn-row + widen-window)                    | 2      | `cli/herdr-session-view.ts` `pumpEvents`/`tailEvents` vs `tui/main.ts` `pumpEvents`/`armFeed`                                                      |
| `pidAlive`                                                                   | 2      | `tui/main.ts` vs `plugins/herdr/src/lib.ts`                                                                                                        |
| `agents.json` read                                                           | 2      | `tui/main.ts` `agentEntry()` vs `lib.ts` `agentsJson()`                                                                                            |
| `OUTCOME` permission-option labels                                           | 2      | `acp/model.ts`, `acp/lines.ts`                                                                                                                     |
| `JUDGE_PROMPT_MARK`                                                          | 2      | `tui/verdict.ts` re-states `'System One decision endpoint'` — a literal copy of `TYPED_PREAMBLE`'s first line in `providers/acp.ts`; rots silently |

## 3. Cohesive units already present (the extraction seams)

The PR already built — possibly without noticing — a clean 4-layer stack:

- **Wire/journal contract** (schema only): `ArchiveRow` + row kinds + `ts`/`by`.
- **Wire decode** (pure): `acp-render.ts`'s helper half — `safe/safeBlock/clip/
  firstLine/chunkText/toolArg/toolContent/DONE_STATUS/ToolContent`. Already pure;
  the class `AcpRenderer` (line-mode output) rides on it.
- **Session model** (pure, Node-testable): `tui/impl.ts` `PaneImpl` seam,
  `tui/model.ts` `SessionModel`, `tui/acp/model.ts` `AcpImpl` over vendored
  `acp-model`, `tui/state.ts` `applyOps` fold, `tui/view.ts` + `tui/verdict.ts`
  - `tui/acp/lines.ts` (segment/row language as _data_, not paint).
- **Renderer** (Bun-only): `tui/app.tsx` Solid tree + `theme.ts` + `main.ts` shell.

Plus two file-doc contracts: `FleetPaneState` (writer: cli projector; readers:
cli panes, plugin `lanes.ts`, tui) and the herdr pane-report envelope
(`reportSession`/`releaseSession`/`PANE_SOURCE`/`plain`, used by cli + tui).

## 4. Proposed packages — target shape

Owner scope (revised): **existing packages are untouched**; the extraction
material is this PR's new code **plus everything reusable currently sitting
in `packages/cli` and `plugins/herdr`**. Target shape:

- `packages/acp/*` — reusable ACP tooling, imports **nothing** from bro
  code. Internal layering inside the family: `model`/`wire`/`archive`
  (pure) → `view` (renderer-independent) → `tui` (Bun/OpenTUI).
- `packages/<bro-side>` — new bro packages for fleet/herdr glue; may
  depend on `@broject/core` + `acp/*`.
- `packages/cli` — ends as **command wiring**: argv, `loadBroConfig`,
  env, stdout formatting; all logic delegates to package APIs.
- `plugins/herdr` — ends as **thin glue**: herdr workspace/pane/agent
  API calls ↔ bro state ↔ package calls; no model/render/lifecycle mass.
- `packages/providers` — keeps the write side (needs `@broject/core`);
  imports `acp-archive`'s `ArchiveRow` schema so writer/readers share
  one declared contract.

| Package                           | Path                     | Moves in                                                                                                                                                                                                                                          | Public API                                                                                                                                                                                                                                                                                                                                              | Consumers                                                                         |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **`@broject/acp-model`**          | `packages/acp/model`     | `tui/vendor/acp-model/` verbatim (Apache-2.0, ATTRIBUTION/NOTICE, pin `70b8a6d`)                                                                                                                                                                  | `createSession`, `reduce`, `Session`, `Item` union, `ModelEvent`, `sanitise`                                                                                                                                                                                                                                                                            | acp-view's `AcpImpl`                                                              |
| **`@broject/acp-wire`**           | `packages/acp/wire`      | helper half of `providers/acp-render.ts`; the plugin copy deletes to an import                                                                                                                                                                    | `SessionUpdateLike`, `PermissionRequestLike`, `ToolWire`, `ToolContent`, `safe`, `safeBlock`, `clip`, `firstLine`, `chunkText`, `toolArg`, `toolContent`, `DONE_STATUS`, `ALWAYS_KINDS`/`pickOption` perm policy, **`JUDGE_PROMPT_MARK`** (owned here; `providers/acp.ts` imports it for `TYPED_PREAMBLE`), `plain`; plus `AcpRenderer` line-mode class | providers (re-export), session-lines, plugin `acp-watch`, acp-view                |
| **`@broject/acp-archive`**        | `packages/acp/archive`   | `cli/session-feed.ts` lower half; `archiveFile`/path contract from `acp-events.ts`; both duplicated tail pumps (`session-view`+`tui/main.ts`); `readPrompt` `.prompt.md` derivation                                                               | `ArchiveRow`(+kind union), `parseArchiveRows`, `readTailSlice`, `sizeOf`, `TAIL_BYTES`, `tailArchive(path,{offset,widen})`, `rowVerdict`, `eventsVerdict`, `eventsFile(agentsHome,agentId)`, `promptFile(eventsPath)`, `logStem`, `PaneLed`/`LedState`                                                                                                  | providers writer, session-lines, fleet-status (led), acp-tui, herdr-views         |
| **`@broject/acp-view`**           | `packages/acp/view`      | `tui/model.ts`, `impl.ts`, `state.ts`, `view.ts`, `verdict.ts`, `theme.ts`, `acp/model.ts`, `acp/lines.ts`, `acp/conform.ts`(→testkit)                                                                                                            | `Item`/`Op`/`PaneState`, `applyOps`, `PaneImpl`+`pickImpl` registry, `SessionModel`(legacy), `AcpImpl`(acp), `TimeGutter`, fold/settle rules, `verdictOf`/`isJudgeTurn`, `Segment`/`CardLine`/`acpLine`/`acpCardRows`/`itemGroup`, `printLines`/`toolBody*`/`mdPlain`/`mdSource`, `theme`/`ledColor`, `dumpItems`/`copyItem`                            | acp-tui, session-lines (dump/headless), future renderers                          |
| **`@broject/acp-tui`** (Bun-only) | `packages/acp/tui`       | `tui/app.tsx`, `tui/main.ts` generic half                                                                                                                                                                                                         | components: `Pane`, `ToolCard`, `PromptRow`, `VerdictRow`, `AcpToolBody`, `HeaderBar`, `FooterBar`, scrollbox chrome; shell: `createPane`, `mountPane`, `serve({target:{events,agent,worktree}, report:(led,mode)=>void})` — resolved target + report callback in, no herdr/config imports                                                              | plugin `tui/main.ts` glue, published `bunx` entry                                 |
| **`@broject/fleet-status`**       | `packages/fleet-status`  | `cli/fleet-state.ts` whole (doc schema + `PaneLed` re-export); `herdr-projector.ts` classifier (`laneOf`/`events`/`labelFor` projection); `SessionTarget`/`resolveTarget`/`targetKey`/`sessionAgentOf`/`viewVerdict` from `herdr-session-view.ts` | `FleetPaneState`, `parseFleetState`, `fleetStatusPath`, `nextSeq`, `projectFleetStatus`, `SessionTarget`, `resolveTarget`, `targetKey`, `sessionAgentOf`, `viewVerdict`                                                                                                                                                                                 | cli herdr-* commands, plugin `lanes.ts`, session-lines, plugin `tui/main.ts` glue |
| **`@broject/session-lines`**      | `packages/session-lines` | `herdr-session-view.ts` lifecycle minus argv/env — attach `session/load` leg, tail events, render via `AcpRenderer`, report loop                                                                                                                  | `runSessionView({target, out, report, opts})` — resolved target in, lines out, led via callback                                                                                                                                                                                                                                                         | cli `herdr session-view` (thin wrapper), herdr-views `viewCommand` fallback       |
| **`@broject/herdr-client`**       | `packages/herdr-client`  | `session-feed.ts` upper half (`paneArgs`/`reportSession`/`releaseSession`/`sessionMetaArgs`/`SESSION_PANE_AGENT`); `PANE_SOURCE`/`plain` from `herdr-status-view.ts`; `pidAlive`/`agentsJson` from plugin `lib.ts`+`tui/main.ts`                  | spawnSync herdr verbs, pane-report envelope, registry reads (`agents.json`), `pidAlive`, `plain`                                                                                                                                                                                                                                                        | cli herdr-* commands, plugin `lib.ts`, session-lines, plugin `tui/main.ts` glue   |
| **`@broject/herdr-views`**        | `packages/herdr-views`   | `live-views.ts` + `sessions.ts` **decision** layer (discover→converge→ensure/retire/retry; bun probe→command choice)                                                                                                                              | `convergeViews({live, existing, policy}) → Action[]` (spawn/retire/retry), `viewCommand(spec,{bun}) → argv`, `ensureSession`/`retireSession` decisions — all pure over an injected exec/discovery seam                                                                                                                                                  | plugin `reconcile.ts`/`sessions.ts` glue; cli could reuse later                   |

Internal layering (owner's point 6) inside each package:

- `acp/archive`, `acp/wire`, `acp/model`: pure data + IO-at-edge
  (`tailArchive` takes a path, nothing else touches fs).
- `acp/view`: rows in via `feed()`, ops out via `drain()` — no fs, no
  renderer, no herdr. Segments/cards are data; paint is the renderer's.
- `acp/tui`: `components/` (pure Solid) → `shell/` (`mountPane`,
  writer, OSC52, keys; consumes `PaneImpl`) → `serve()` entry (wires
  `tailArchive` + impl + store). `report` is a callback — herdr never
  imported.
- `fleet-status`, `session-lines`, `herdr-views`: decisions/APIs take
  resolved inputs; bro config reads stay outside (cli/plugin inject).
- `herdr-client`: the one place `spawnSync('herdr', …)` lives — pure
  argv builders at the top, exec seam below.

## 5. What stays as glue (not extracted)

- **cli — thin command wiring only**: argv parsing/registration,
  `loadBroConfig` + provider map resolution (the only place config may be
  read — packages take resolved inputs), `HERDR_ENV` checks, stdout
  formatting. Commands become 10–30 line wrappers: `herdr session-view` →
  `session-lines.runSessionView`; `herdr session-feed` → `acp-archive` +
  `herdr-client`; `herdr fleet-status*`/`projector` → `fleet-status`
  project/write calls.
- **plugins/herdr — thin herdr↔bro glue**: `reconcile`/`lanes`/`mirrors`/
  `statuses`/`renderers`/`planes` orchestration (bro↔herdr convergence
  policy IS the plugin's job), `PluginState` file persistence, herdr
  workspace/pane API calls (via `herdr-client`), `acp-watch` (argv →
  `acp-wire` renderer), thin `tui/main.ts` entry (resolve target via
  `fleet-status` → spawn `acp-tui.serve` → `report` callback calls
  `herdr-client`). The plugin keeps **no** model/render/tail/verdict code.
- **providers — writer stays**: `agentTurnPlane`/`agentEventRecord`/
  `pumpTurn`/`acp-worker` need `@broject/core` (bus, paths, private
  files); they import the `ArchiveRow` schema from `acp-archive` so
  writer and readers share one declared contract.
- **`live-views`/`sessions` exec side stays in the plugin** — the
  discovery (`agents.json` read), state persistence, and `herdrTry` exec
  are glue; only the _decision_ layer moves into `herdr-views`.

## 6. Extraction order (each step green on its own)

1. **`@broject/acp-wire`** — pure move; providers re-exports for compat.
   `plugins/herdr/src/acp-render.ts` becomes a 1-line re-export (or relative
   source import). Kills the 646-line copy. Zero deps, zero risk.
2. **`@broject/acp-archive` + `@broject/herdr-client`** — split
   `session-feed.ts` at its natural seam: archive IO → `acp/archive`,
   pane-report envelope → `herdr-client`. Writer (`acp-events.ts`)
   switches to the shared `ArchiveRow`. Path helpers kill 4 naming
   re-derivations.
3. **`@broject/fleet-status`** — `fleet-state.ts` moves whole; the
   projector classifier and `resolveTarget`/`targetKey` follow; cli
   commands become thin wrappers. Three doc readers converge.
4. **`@broject/acp-model`** — vendor → workspace package (attribution
   files travel; sdk as peer/type-only dep — reconcile the `1.5.0` pin
   vs root `^1.7.0`).
5. **`@broject/acp-view`** — the big move; do it ONCE imports 1–4 exist
   so every edge is a package name, not a `../../../` path. This is where
   the §2 duplications converge (one permission text, one PLAN_BOX, one
   `shortBy`, one storm impl — keep both `PaneImpl`s but share internals).
6. **`@broject/acp-tui`** — Bun app last; `app.tsx` + `serve()` shell.
   Plugin `tui/main.ts` shrinks to resolve→spawn→report glue.
7. **`@broject/session-lines` + `@broject/herdr-views`** — cli
   `session-view` and plugin `live-views`/`sessions` hollow out to glue
   in the same pass; their logic lands in packages.

Each step: keep re-exports at the old paths until all call sites move, then
delete the shim. `tui-impl/tui-model/tui-state/pane.test.tsx` tests move with
their code (they're already split Node-safe vs Bun correctly).

## 7. Risks / watch items

- **R1 — plugin can't `import` workspace packages.** `plugins/herdr` sits
  outside `workspaces`. Options: (a) relative `.ts` source imports (works —
  Node 22 strips types; same trick tui uses), (b) give the plugin a
  `package.json`+install step, (c) keep vendoring (the bug we're fixing).
  Decide once; (a) is honest and free.
- **R2 — freezing a young seam.** `Item.vi`/`ToolItem.runs` are impl-specific
  escape hatches the Op contract tolerates. Publishing `acp-view` locks
  them (Hyrum). Acceptable if documented "opaque to the seam", else normalize
  before extraction.
- **R3 — runtime boundary.** `acp-view` must NEVER import `@opentui/*`/
  `solid-js` — port the vendored import-graph test (`test/import-graph.test.ts`
  upstream already asserts this mechanically) so a regression fails in CI.
- **R4 — vendored provenance.** Promoting `acp-model` to a workspace package:
  Apache-2.0 LICENSE/NOTICE/ATTRIBUTION must travel with it, `private` or
  published under a name that doesn't squat the upstream `acp-model` name
  (`@broject/acp-model`). Upstream sync becomes a version bump, not a copy.
- **R5 — two impls, deliberate.** `legacy` vs `acp` parity is the PR's design
  (conform probe enforces coverage). Extraction shares internals but keeps both
  impls and the probe — do not pick a winner.
- **R6 — byte-level output drift.** Converging the 4 permission texts, 3 plan
  blocks, 2 storm engines changes rendered output in edge cases. The
  `acp/conform.ts` probe + `--dump` snapshots are the regression net; run them
  per step, not at the end.
- **R7 — `JUDGE_PROMPT_MARK` is already rot.** `tui/verdict.ts` re-states the
  preamble literal. Move the constant to `acp-wire`; `acp.ts` builds
  `TYPED_PREAMBLE` from it — one source.
- **R8 — `loadBroConfig` reach.** `tui/main.ts` reads cli internals for the
  providers map. Packages take `ProviderLike` in; only the cli glue reads
  config. (The projector already writes `provider`/`model`/`lane`/`events` into
  the fleet doc — the viewer's config read is mostly redundant for the events
  lane; needed only for the rare `session/load` attach leg.)
- **R9 — `session-feed.ts` is two modules.** Archive contract (pure) vs herdr
  report envelope (`spawnSync herdr`, `PANE_SOURCE`). Don't smuggle the herdr
  half into `acp-archive` — that's a bro-integration dependency the package
  must not carry.
- **R10 — `--dump` portability.** `main.ts`'s dump path drags `packages/cli`
  sources that use TS parameter properties (Node's stripper rejects → Bun-only
  anyway). Once the model lives in packages the dump path needs only
  `acp-archive`+`acp-view` and becomes Node-clean for free.

## 8. Monorepo taxonomy — where the new packages land

Owner refinement: **the 23 existing packages are untouched** — no
`packages/bro/` migration, no restructuring. That leaves two questions:
where the new `acp` family lives, and where the new bro-side packages
live.

```
packages/
  acp/               ← NEW grouped family (born grouped, zero conflicts)
    model/ wire/ archive/ view/ tui/
  fleet-status/      ← NEW bro-side packages, flat — same convention as
  herdr-client/        the untouched 23 (uniform `ls`, no second rule)
  herdr-views/
  session-lines/
  <23 existing dirs — untouched>
plugins/             unchanged — connector plugins, different unit
```

Why `acp/` groups but the bro-side four stay flat:

- The acp family is a **closed subtree with a hard rule** — `acp/*` may
  import only `acp/*` + external deps — so the directory boundary _is_
  the enforcement boundary (one import-graph check covers it).
- The bro-side packages (`fleet-status`, `herdr-client`, `herdr-views`,
  `session-lines`) may import anything (`core`, `acp/*`, each other);
  grouping them under a `packages/bro/` dir would create a `bro/` dir
  that pointedly does _not_ contain `cli`/`providers` — more confusing
  than flat. If a future cleanup migrates legacy under `bro/`, these
  four move with it cheaply.
- npm names stay flat regardless (`@broject/acp-model` at
  `packages/acp/model`); dirs carry taxonomy, names carry identity.

Mechanics: `workspaces: ["packages/*", "packages/acp/*"]`; nx has no
`project.json` files and infers projects from workspaces — no change
needed; per-package `tsdown`/`tsconfig` are self-relative; nothing new
is pinned by scripts.

**Enforcement rule (mechanical, in CI):** `packages/acp/**` sources must
not import from `packages/bro`-side paths or `@broject/{core,cli,
providers,fleet-status,herdr-*}` — generalize the vendored
import-graph test the model package already ships. That makes "lighter
core" a gate, not a goal.

## 9. What this buys the core

- `packages/cli` becomes command wiring: `session-feed.ts` splits away
  entirely, `fleet-state.ts` moves whole, `herdr-session-view.ts` (~640
  LOC) and the projector classifier become thin wrappers —
  cli-side session/herdr logic drops to argv+config+stdout.
- `packages/providers` loses `acp-render.ts` (re-export shim only).
- `plugins/herdr` sheds everything but glue: the 646-line copy, the
  whole `tui/` model/render tree, `live-views`/`sessions` decision
  logic, every `../../../packages/**` deep import — what remains is
  herdr API calls + state files + converge orchestration.
- `plugins/herdr/tui` becomes ~one file: resolve target →
  `acp-tui.serve` → `herdr-client.report`.
- Net: the `.events.jsonl` contract becomes ONE schema owned by one
  package with a writer (providers) and readers (session-lines, acp-tui,
  fleet-status) all importing it — the fix for the actual disease this
  PR worked around three different ways. And `acp/*` stands alone as a
  publishable ACP tooling family (`bunx @broject/acp-tui`) that bro
  happens to consume.
