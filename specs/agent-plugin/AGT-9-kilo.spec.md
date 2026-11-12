---
template: brotocol/spec@2
id: AGT-9
title: kilo — plugin bus, shared transform event, notify-only stop
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/kilo/
  - packages/agent-plugins/kilo/
aliases:
  - kilo
---

# AGT-9 — kilo: plugin bus, shared transform event, notify-only stop

## Problem

kilo (`@kilocode/plugin`) has the thinnest lifecycle surface of any
wired host: no dedicated session-start event, no compaction events,
no pre/post-tool events — one `experimental.chat.system.transform`
carries both session-start and prompt-submit context, `permission.ask`
carries the approve, and `session.idle` is the only stop-adjacent
signal, which kilo **cannot halt**. The spec pins the minimal honest
mapping and the notify-only stop declaration — kilo is the contract's
lowest-capability wired host and the reference for "partial coverage
is still coverage".

## Design

### Surface: `plugin`, async, single generated module

`plugins/kilo/bro/bro.ts` is generated from
`packages/agent-plugins/kilo/src/kilo.ts` (adapter-core folded by
bundle-adapter). The module imports `@kilocode/plugin` — kilo
provisions `package.json` + `node_modules` in any config dir carrying
a `plugin/` folder. Install: `bro plugins install kilo` → global
`~/.config/kilo/bro/bro.ts` + `kilo.json` `plugin[]` entry, or local
`.kilo/plugin/bro.ts` (auto-loaded). Every hook call fail-open.

### Event mapping (HOOK_MATRIX `kilo` row)

| bro event | kilo native | effects |
| --------- | ----------- | ------- |
| session-start | `experimental.chat.system.transform` | context |
| prompt-submit | `experimental.chat.system.transform` | context — **same native event serves both** |
| permission | `permission.ask` | approve |
| stop | `event` → `session.idle` | notify — `stopRefusal: 'none'` |
| post-compaction | — | declared gap: no compaction event exists |
| pre-compact | — | declared gap |
| pre-tool | — | declared gap |
| post-tool | — | declared gap: no tool-result event exists |

`nativeOnly`: `session.created`, `session.deleted`, `tool.bro` —
kilo lifecycle events bro observes for bookkeeping.

### The shared-transform consequence

Because one native event feeds both session-start and prompt-submit,
the adapter must deduplicate internally: the transform fires per
prompt, so "session start" semantics (hydrate once, cache the
snapshot) live in the adapter's cache, not in the host's event
stream. This is the contract's **event-coalescing** case — when a
host merges lifecycle moments, the binding owns the separation. Any
future host with coarse events inherits the same rule: the driver
sees distinct bro events; the binding de-multiplexes native ones.

### Notify-only stop — the floor of the contract

`session.idle` cannot be refused: when bro's stop gate returns
`decision:block`, kilo surfaces it as a warn-level log line and
nothing more (`stopRefusal: 'none'`, effects `['notify']`). The spec
states this plainly — kilo users get the gate's *signal* (log +
the session-start/prompt nudges that carry the same policy) but not
its *enforcement*. Enforcement parity is per-host declared, never
implied; a kilo session that ignores the log is behaving exactly as
specified.

### Native functions leveraged

- **`experimental.chat.system.transform`** — kilo's system-prompt
  transform is the context channel; bro injects hydration/nudges
  through it (the host's own "add context" slot).
- **`permission.ask`** — the self-tool approve lands on kilo's real
  permission hook; scoped opt-in per boundaries.
- **`tool.bro`** — kilo's tool-registration surface hosts a `bro`
  tool (nativeOnly cell) for model-callable status reads.
- **Plugin auto-load** — `.kilo/plugin/` needs no registration;
  global installs register in `kilo.json` — two install scopes,
  both through `bro plugins install`.

## Requirements

- **R1** — The shared-transform dedup stays in the binding: session
  hydration caches once per session, prompt nudges fire per prompt —
  never let the coalesced event double-inject.
- **R2** — Stop stays `notify`-only — do not synthesize a reprompt
  kilo cannot deliver; `stopRefusal: 'none'` is the declared floor.
- **R3** — `plugins/kilo/bro/bro.ts` stays generated; `check:plugins`
  clean; the `@kilocode/plugin` import resolves only inside kilo's
  plugin environment (never a hard dependency of the module).
- **R4** — `permission.ask` approve stays scoped to `bro`/`bd`
  self-tools.
- **R5** — Declared gaps (compaction, tool events) stay declared —
  if kilo ships the events upstream, this spec gains cells, not
  silent wirings.

## Verify

- `host-matrix.test.ts` kilo row green — the sparsest row, all gaps
  explicit.
- Adapter unit tests + `check:plugins` clean.
- Live: kilo session shows transform-injected context on start and
  prompts, `bro`/`bd` approve on permission.ask, gate findings as
  warn logs on idle (no reprompt expected or faked).

## Changelog

- 2026-11-12 — Initial draft under AGT-1: plugin surface, shared
  transform event dedup, notify-only stop floor, declared gaps.
