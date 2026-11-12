---
template: brotocol/spec@2
id: AGT-1
title: One bro, any agent X — the host-neutral agent-plugin contract
status: draft
area: agents
owns:
  - packages/cli/src/host-matrix.ts
  - hooks/
  - hooks.json
  - plugin.json
  - skills/
  - packages/agent-plugins/
  - plugins/
  - scripts/gen-plugins.ts
  - packages/cli/src/commands/plugins.ts
aliases:
  - agent-plugin
  - x-agent
---

# AGT-1 — One bro, any agent X: the host-neutral agent-plugin contract

## Problem

bro reaches agent hosts through nine different plugin shapes — hook
manifests for Claude/Codex/Devin/Cursor, generated manifests for
Cursor, in-process extensions for pi/omp, catalog plugin directories
for opencode/kilo, and a herdr plugin that is not an agent host at
all. The agent-facing logic — what bro *does* inside a session — is
real but implicit: it lives scattered across `hooks/run.sh`,
`host-matrix.ts`, `packages/agent-plugins/adapter-core`,
`scripts/gen-plugins.ts`, nine `plugins/` dirs, 49 skills, and a
handful of marketplace manifests. No spec states what "bro inside
agent X" means independent of X.

The contract exists de facto — `HOOK_MATRIX` declares every host's
event cells, `host-matrix.test.ts` enforces them cell-by-cell, and
`integrations.md` renders the same table — but it is a test fixture
and a docs table, not a declared contract. Three consequences:

- **Archaeology for the next host.** Adding agent X today means
  reading plugins/, adapter-core, gen-plugins, the hook runner, and
  docs to re-derive what the contract even is. The knowledge is in
  code shape, not in a spec.
- **Drift surface.** The matrix, the test, the docs table, and the
  shipped manifests are four renderings of one contract. Only the
  test pins them together; nothing names the contract they serve.
- **No boundary statement.** Which parts of session behavior are
  bro's agent logic (rehydration, nudges, gates, skills, claims) and
  which belong to the host (permission plane, native modes, UI) is
  folklore spread across READMEs — each adapter re-answers it.

## Design

### The contract has four planes

**1. Lifecycle plane — the hook protocol.** Eight bro events form
the shared vocabulary: `session-start`, `post-compaction`,
`pre-compact`, `prompt-submit`, `pre-tool`, `post-tool`, `stop`,
`permission`. Every host maps its native events onto them; every
answer travels the `bro hooks <event>` protocol (stdin payload in,
JSON control out). `HOOK_MATRIX` is the machine form of this plane:
per host, per event — native names, tool matchers, effects
(`context | observe | block | reprompt | rewrite | approve |
notify`), outcome source, stop-refusal mode, sync/async background.

**2. State plane — the repo is the session.** Claims, markers
(`.work`/`.task`/`.act`/`.drill` in the git common dir), mailbox
drops, the spec tree, guard and lesson caches — all durable state
lives on disk in the repository, never inside the host. This is why
one logic serves every X: the state plane is host-blind by
construction. A host contributes only *when* to ask; bro owns *what*
is true.

**3. Surface plane — what the host can show.** Board/status
rendering, model-callable tools, slash commands, skill registries,
toasts and widgets. Capability-tiered by surface kind: manifest
hosts are sync and context-only; extension/plugin hosts are async
and may paint UI, register tools, and hold native refusal slots.
The tier is declared per host in the matrix — never assumed.

**4. Delivery plane — four surfaces, one protocol.** `manifest`
(host-native hooks.json piping stdin to `hooks/run.sh`),
`generated` (same shape, emitted by `gen-plugins.ts`),
`extension` (in-process TS module on the pi/omp API), `plugin`
(catalog module on the opencode/kilo bus). All four terminate in the
same `bro hooks` dispatch; the surface decides transport and timing,
never semantics.

### What a host X must supply

A host satisfies the contract by exactly three commitments:

1. **Cells** — its `HOOK_MATRIX` entry: which native events wire to
   which bro events, with honest `—` gaps where the host lacks a
   surface or bro deliberately leaves one unwired. A declared gap is
   contract; a silent absence is a bug.
2. **Transport** — the surface artifact that carries payloads to
   `bro hooks` (manifest file, generated module, extension, or
   plugin package) plus its install path (marketplace manifest or
   `bro plugins install` client entry).
3. **Opt-in** — participation stays opt-in: `bro.config.json` /
   `.beads/` presence gates context and gates; a missing CLI or a
   timeout resolves to "no opinion", never an error. The one
   exception is the host's own permission answer shape (Cursor
   denies an empty `beforeShellExecution` reply — the adapter must
   still answer).

Everything else — what the hooks *mean*, what state they read, what
the gates decide — is bro's, identical for every X.

### Boundaries (canonized, already enforced)

- **Advisory ≠ enforcement.** Nudges, context injection, re-prompts
  and toasts are UX. Enforcement exists only where the host's own
  `block`/`rewrite`/`approve` slot applies it.
- **bro policy ≠ host permissions.** Stop-gate and merge policy own
  repo state; the host permission plane stays the user's security
  surface. bro answers permission events, never widens them.
- **Opt-in approval is scoped.** `approve` covers `bro`/`bd`
  self-tools only — a workspace opting into bro calling itself, not
  a statement about any other tool.
- **Fail-open, bounded.** Every probe is deadline-bound; the stop
  gate is the single blocking surface and it is one-shot per armed
  aspect per session.
- **Sync vs async is declared.** Manifest hosts block the event on
  `run.sh` (bounded by hook timeout); extension/plugin handlers
  resolve while adapter work continues — the matrix records which.

### The new-host path

X may be anything — a new CLI, an editor, a multiplexer, a phone.
The checklist this spec fixes:

1. Classify the surface: does X have lifecycle hooks? A plugin/extension
   API? Only a shell? Pick the nearest `HookSurface`; a host with no
   hook surface still receives skills + CLI (the degenerate contract —
   everything advisory, nothing gated).
2. Wire events bottom-up: `stop` and `session-start` first (the gate
   and the rehydration carry the most value), then `prompt-submit`,
   `post-tool`, the rest as surfaces allow.
3. Declare cells in `HOOK_MATRIX` + bump `HOOK_MATRIX_VERSION`;
   `host-matrix.test.ts` names every unwired cell.
4. Choose the binding: manifest hosts need only hooks.json +
   run.sh reachability; extension/plugin hosts supply a
   `BroHostBinding` (events, sessionId, cwd, paint/notify,
   refuseStop/stopAlreadyRefused, inject, appendToolResult) and get
   the shared driver lifecycle for free.
5. Install path: marketplace manifest for store-distributed hosts,
   `bro plugins install <x>` CLIENTS entry for module-distribution
   hosts.
6. Dogfood: `hooks.e2e` payload shapes + a live session on X.

### Relation to existing specs

`specs/bro-omp-plugin.md` designed the core+binding+driver split
this contract generalizes; `specs/sdd/` owns the spec engine; the
per-host children (AGT-2…AGT-10) own each host's native mapping.
This spec owns the *contract* — the four planes, the vocabulary,
the boundaries, the checklist.

## Requirements

- **R1** — The four planes, the eight-event vocabulary, the effect
  vocabulary, and the five boundaries above are the declared
  contract; `HOOK_MATRIX` remains their machine form and
  `host-matrix.test.ts` their enforcement.
- **R2** — Every shipped agent host has a child spec
  (AGT-2…AGT-10) mapping its native surface onto contract cells,
  naming what is leveraged natively vs adapted, and listing gaps.
- **R3** — The new-host checklist is sufficient to wire a previously
  unknown X without reading adapter sources: surface → events →
  cells → binding → install → dogfood.
- **R4** — Contract evolution is spec-governed: a cell change bumps
  `HOOK_MATRIX_VERSION` and lands with a Changelog entry here or in
  the affected child spec; the docs table in `integrations.md`
  renders the matrix, never paraphrases it.
- **R5** — Honest gaps are contract: every `—` cell names why (host
  lacks the surface / bro deliberately unwired); silent absence is
  a defect, not a gap.
- **R6** — Degenerate contract: a host with no hook surface still
  gets the portable package (skills + CLI) — advisory-only,
  explicitly declared, never implied.

## Verify

- `bro spec tree` shows AGT-1 as root of the agent-plugin family.
- `host-matrix.test.ts` + `hooks.e2e.test.ts` green — the contract's
  machine form and its payload shapes.
- `site/content/docs/integrations.md` matrix == `HOOK_MATRIX`
  rendering (already generated/verified by the doc check).
- Each child spec's Verify section names its host's live evidence.
- Adding a hypothetical host is exercised at least once as a dry run
  (checklist completeness) before the contract is called stable.

## Changelog

- 2026-11-12 — Initial draft: four planes, eight-event vocabulary,
  boundaries, new-host checklist. Codifies what HOOK_MATRIX +
  adapter-core + run.sh already enforce de facto.
