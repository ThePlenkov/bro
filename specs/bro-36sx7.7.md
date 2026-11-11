---
parent: bro-36sx7
scope:
- packages/cli/src/hooks.ts
- packages/cli/src/connectors.ts
- packages/cli/src/plugins.ts
- packages/cli/src/commands/hooks.ts
- packages/cli/src/commands/trace.ts
- packages/cli/src/commands/goal.ts
- packages/cli/src/commands/want-marker.ts
- packages/cli/src/commands/daemon.ts
- packages/cli/src/commands/drive-pulse.ts
- packages/cli/src/commands/loop-pulse.ts
- packages/cli/tsdown.config.ts
- hooks/run.sh
- scripts/bench-hooks.ts
- packages/cli/src/commands/hooks.e2e.test.ts
---

# bro-36sx7.7 — slim dist/hooks.js entry without the PLUGINS registry

Bead: `bro-36sx7.7` (task) — parent epic `bro-36sx7`. Review item #9
(specs/sessions/bro-36sx7.md, `~/reports/bro-hooks-perf-review.md`).

## Problem

Every `bro hooks <event>` is a fresh Node process on the host agent's
critical path — the host blocks until the hook answers. The only entry
the launcher knows is `dist/index.js`, whose module graph evaluates
`plugins.ts`: the PLUGINS registry — ~81 plugin definitions plus every
command module they mount (`act`, `work`, `doctor`, `daemon`, `serve`,
…), every doc type, and the whole `@broject/*` import surface those
commands pull. The repo's own estimate for that cold start is
~170–300 ms per event (`specs/bro-arm83.md`), paid on every tool call,
prompt, stop, and permission request — and it lands *before* the hook
does any work, so it is pure overhead on the hottest path bro has.

The hook dispatch itself needs a tiny slice of that graph:
`runHooksCommand` (`commands/hooks.ts`) plus the connector plane its
probes call (`sessionStartProbe`, `stopGateContributions`,
`preToolVerdicts`, `postToolLines`, `promptContextLines`,
`parallelWorkProbe` — all `@broject/core` connector facades). Two
things stand between that slice and a registry-free entry:

- `commands/hooks.ts` and `commands/trace.ts` import `loadBroConfig`
  from `plugins.ts` — one symbol, but the import evaluates the whole
  registry module (and, through it, every command module).
- `commands/goal.ts` does the same — it is lazy-imported on
  session-start/stop, so the registry would load on exactly the events
  the slim entry exists to cheapen.
- The drive/loop pulse connectors `await import('./daemon.ts')` on
  every sessionStart/postTool probe — daemon.ts statically imports
  `plugins.ts`, so the registry loaded on every tool call even with a
  registry-free entry, unless the import is gated.
- The connector registrations themselves live at `plugins.ts` module
  top level — skipping `plugins.ts` would silently unregister every
  connector and every hook probe would return nothing.

## Design

A second tsdown entry, `src/hooks.ts` → `dist/hooks.js`, that mounts
`runHooksCommand` directly — no `defineCommand`/`runCommand`, no
PLUGINS table, no doc-verb fallback. `hooks/run.sh` prefers it
everywhere it can resolve one and keeps `dist/index.js hooks` /
`bro hooks` as the stale-dist and foreign-binary fallbacks.

### `connectors.ts` — the connector plane, shared

The built-in `registerConnector` block moves verbatim out of
`plugins.ts` into `packages/cli/src/connectors.ts` (same order — the
comments there note order decides stop-gate block priority). `plugins.ts`
imports it for the side effect, so the main CLI registers exactly what
it did before; the slim entry imports it directly. Every module the
block names (`commands/work.ts`, `commands/spec.ts`, the `*-pulse.ts`
files, `herdr-connector.ts`, `session-cap.ts`, `spec-connectors.ts`,
the `@broject/*` connector packages) was audited: none reaches
`plugins.ts` statically, so the move cannot drag the registry back in.

### `hooks.ts` / `trace.ts` — scoped config, not the registry

`loadBroConfig(dir)` is `loadConfig(dir, pluginConfigSections())` —
all ~40 plugin section schemas applied, which is what drags
`plugins.ts` in. The hook path reads exactly two plugin-owned keys, and
the codebase already has the scoped-section idiom for this
(`loadConfig(dir, { freshness: freshnessSection })` in postmerge.ts,
`{ watch: watchSection }` in watch-pulse.ts, `{ rig: rigSection }` in
rig-pulse.ts):

- `commands/hooks.ts` `guardLines` — `.guard` → `loadConfig(dir,
  { guard: guardSection })`, with `guardSection` taken from the same
  `@broject/guard` dynamic import that already provides `runGuards`
  (guard events pay for the package either way; other events never
  load it).
- `commands/trace.ts` — `.telemetry` → `loadConfig(dir, { telemetry:
  telemetrySection })`; the call sites already re-apply
  `telemetrySection` themselves, and the section is idempotent, so the
  resolved value is unchanged.
- `commands/goal.ts` — `.goal` → `loadConfig(dir, { goal:
  goalSection })` from goal-config.ts, same scoped-section idiom. The
  module stays lazy-imported; only its config read stops reaching the
  registry.

All three keys are plugin configKeys, not `CORE_SECTIONS`, so scoping
the section map resolves them identically — `applySections` runs
`config[key] = schema(raw[key])` per key, and `guard`/`telemetry`/`goal`
each have exactly one schema.

### `src/hooks.ts` — the entry

Replicates the slice of `index.ts`'s `prepare` the hook path actually
needs, in the same order:

1. `import './connectors.ts'` — built-in connectors register at module
   load, ahead of externals, exactly as today.
2. otel command span + `setAmbient` — `otelSpan('bro.cmd hooks')` with
   the same attrs and `endDetached` exit hook `index.ts` installs, so
   `hook.event` spans keep their `bro.cmd hooks` parent. `otel.ts`
   imports only node builtins, so this stays cheap; with no OTLP
   endpoint configured the enqueue drops before any spawn.
3. External plugin connectors — `loadConfig().plugins` non-empty →
   `await import('./plugins.ts')` + `loadExternalPlugins` with the same
   reserved-word set `index.ts` builds (`reservedWords()` +
   `pluginGroups()`). An empty `plugins` list makes
   `loadExternalPlugins` a no-op anyway, so the registry import stays
   dynamic and costs nothing on a stock install — external connectors
   keep firing with full name/configKey collision semantics where they
   are actually configured.
4. `runHooksCommand(process.argv.slice(2))` — argv is already the
   post-`hooks` spelling the plugin's `run` receives, so
   `node dist/hooks.js post-tool` ≡ `bro hooks post-tool`.
   Rejections print the message and exit 1 — `hooks.ts` keeps its own
   fail-open contract and never throws `CommandError`.
5. The `BRO_LOG_TIMESTAMP=1` console wrap, copied verbatim from
   `index.ts` (env-gated; operator subcommands stay byte-identical).

Deliberately absent vs `index.ts`: `journalCommand` on exit (the hook
writes its own perf row via `flushPerf`; bro-36sx7.9 removes the
duplicate for the `bro hooks` spelling too), `registerTelegramSink`
(no sink delivery happens on the hook path — `deliverSinks` is only
reached from `bro notify`/`bus`/`serve`), the doc-verb `fallback`, and
`--version`/`--help` command handling (argv goes straight to
`runHooksCommand`, which already treats unknown events fail-open).

Replicated verbatim: the `BRO_LOG_TIMESTAMP=1` console wrap — it is
env-gated (zero cost unset) and keeps `hooks install`/`perf`/`status`
output byte-identical under the pin; hook answers themselves go through
`writeSync(1)` and were never affected either way.

### Pulse quiescence gate — daemon.ts stays lazy AND unloaded

`drive-pulse.ts`/`loop-pulse.ts` called `await import('./daemon.ts')`
unconditionally inside their sessionStart/postTool checkpoints, and
daemon.ts statically imports `plugins.ts` — so the registry still
cold-loaded on every tool call through the back door. The rearm
decision is already cheap to pre-check: `driveRearm`/`loopRearm`
return `'quiet'` whenever the want-marker is absent, so an absent
marker makes the whole checkpoint definitionally quiet.

The marker path/read helpers (`driveMarkerPath`, `readDriveMarker`,
`loopMarkerPath`, `readLoopMarker`, `DriveMarker`, `LoopMarker`) move
verbatim from daemon.ts to `want-marker.ts` — the leaf module that
already owns `readWantMarker` for exactly this file family — and
daemon.ts re-exports them so its consumers are unchanged. The pulses
now read the marker first and only pay the `daemon.ts` import (and the
registry behind it) on a repo that actually armed `bro drive install`/
`bro loop install`. The gate sits inside the existing try/catch, so a
marker-read failure stays silent exactly like a probe failure.

### `hooks/run.sh` — prefer the slim entry

- Repo dist: the walk-up still keys on `dist/index.js` (the package
  marker), but dispatch prefers `dist/hooks.js` when present —
  `node "$DIR/packages/cli/dist/hooks.js" "$@"` — falling back to
  `node …/index.js hooks "$@"` for a dist built before this entry
  existed.
- PATH `bro`: resolve `command -v bro` through its symlink chain
  (POSIX `readlink`, no `-f` — macOS-safe); when it lands on
  `*/dist/index.js` with a `hooks.js` sibling, run
  `node <sibling> "$@"` — this is the published-install path, where
  the plugin dir has no `packages/cli/dist` and `bro hooks` was the
  only option. A shim that doesn't resolve to a dist file, or a dist
  without `hooks.js` (older release), falls through to `bro hooks`
  unchanged.

The `BRO_HOOKS_NO_FALLBACK=1` bench pin and the watchdog/spool
accounting are untouched — the slim entry is just a different binary
behind the same `run_bounded` call.

### Measurement

`scripts/bench-hooks.ts`'s `dist:` lane repoints from
`dist/index.js hooks <event>` to `dist/hooks.js <event>` — same
dispatch-minus-launcher comparison, now against the entry run.sh
actually prefers. The `runsh:` lane picks the new path up through
run.sh automatically.

## Contract

- `node dist/hooks.js <event>` ≡ `bro hooks <event>` for every event
  argv `runHooksCommand` accepts — same stdin payload, same stdout
  control JSON, same exit-0 fail-open contract.
- Connector registration set and order identical to `bro hooks` —
  built-ins via `connectors.ts`, externals via the same
  `loadExternalPlugins` when `plugins` is configured.
- `.guard` and `.telemetry` config resolution byte-identical (scoped
  sections, same schemas).
- `dist/index.js hooks <event>` keeps working — `bro hooks` is
  untouched; plugins.ts registers the same connectors through the
  shared module.
- `run.sh` falls back cleanly: missing `dist/hooks.js` → `index.js`;
  unresolvable/foreign `bro` → `bro hooks`.

## Tests

- e2e (`hooks.e2e.test.ts`): spawn `dist/hooks.js` directly for a
  session event and an operator event (`perf`) — exit 0, expected
  stdout shape; plus a run.sh scenario asserting the slim entry is
  preferred when both `hooks.js` and `index.js` exist (marker files,
  same pattern as the existing fake-dist cases).
- Unit: `plugins.ts` still registers the built-in connector set —
  existing connector/registry tests cover the move; add an assertion
  that importing `connectors.ts` alone yields the same connector names
  in the same order.
- `npm run build`, `npm run typecheck`, `npm test` (tsx --test — the CI
  command); `scripts/bench-hooks.ts` before/after for the latency
  delta.

## Plan

- [ ] `specs/bro-36sx7.7.md` — this spec
- [ ] `packages/cli/src/connectors.ts` — built-in connector registration,
  moved verbatim from `plugins.ts`
- [ ] `packages/cli/src/plugins.ts` — import `./connectors.ts`, drop the
  moved imports/registration
- [ ] `packages/cli/src/commands/hooks.ts` — `loadBroConfig` → scoped
  `loadConfig(dir, { guard: guardSection })` via the existing
  `@broject/guard` dynamic import
- [ ] `packages/cli/src/commands/trace.ts` — `loadBroConfig` → scoped
  `loadConfig(dir, { telemetry: telemetrySection })`
- [ ] `packages/cli/src/commands/goal.ts` — `loadBroConfig` → scoped
  `loadConfig(dir, { goal: goalSection })`
- [ ] `packages/cli/src/commands/want-marker.ts` + `daemon.ts` — marker
  path/read helpers move to the leaf; daemon re-exports
- [ ] `packages/cli/src/commands/drive-pulse.ts` + `loop-pulse.ts` —
  gate the `daemon.ts` import on want-marker presence
- [ ] `packages/cli/src/hooks.ts` + `tsdown.config.ts` — slim entry →
  `dist/hooks.js`
- [ ] `hooks/run.sh` — prefer `dist/hooks.js` (repo dist + resolved
  `bro` bin); `npm run gen:plugins` refreshes the adapter copies
- [ ] `scripts/bench-hooks.ts` dist lane + e2e coverage
- [ ] build / typecheck / test / bench delta
