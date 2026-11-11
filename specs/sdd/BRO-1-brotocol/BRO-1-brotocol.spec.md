---
id: BRO-1
title: Brotocol — bro's native spec engine
status: draft
area: sdd
owns:
  - packages/core/src/specs.ts
  - packages/cli/src/spec-connectors.ts
  - packages/cli/src/spec-drift.ts
  - packages/cli/src/commands/spec.ts
  - skills/sdd/
aliases: []
---

# BRO-1 — Brotocol: bro's native spec engine

## Problem

bro's SDD capability is wedged inside `packages/cli`: the `SpecStore`
contract lives in `@broject/core`, while the four spec connectors
(native/speckit/openspec/agent), the drift engine, the `bro spec`
verbs and the `sddConnector` hook probes all live in cli source
(~1.8k lines, ~1.4k lines of tests). The capability cannot ship
separately: another rig cannot run the engine without the whole CLI,
and a connector author cannot publish an engine without touching
`packages/cli`.

bro-y1jtm (spec `specs/sdd/bro-y1jtm.md`) elevates the model to
product specs — KEY-N identity, lifecycle, owns, conformance. That
model deserves a named, versioned home and a method around it:
today bro enforces "spec before code" but carries no decomposition
method. How an intent becomes a spec, a spec becomes work, and the
work lands back on the spec is the operator's habit, not a protocol.

The stack — methodology, format, engine, plugin, connectors — is one
product. Two names carry it:

**Write Brose. Follow the Brotocol.**

## Design

### Identity

- **Brotocol** — the contract: the product-spec format (schema, KEY-N
  and lifecycle invariants, parent/part/requirement-anchor semantics)
  and the methodology described below. A philosophy and a schema,
  not a program.
- **Brose** — the spec-management engine that implements the
  contract: the file store, index, resolution, lint, drift and a
  standalone `brose` CLI usable in any repo without bro or beads.
- **`@broject/spec`** — the bro plugin binding the engine to bro:
  `bro spec` verbs, the `sdd` config section, `sddConnector` hook
  probes, the specs facade binding.
- **Spec-engine connectors** — per-tool packages satisfying the same
  facade on foreign layouts. Brose is the default engine, never the
  only one.

`bro spec` stays the CLI noun inside bro — enforcement speaks the
resolved engine's language. Outside bro, `brose` is the tool name.

The dependency direction never inverts:

```text
@broject/spec (bro plugin: verbs, sdd config, hooks, facade)
    └── brose (engine: fs/git store, tree, lint, drift, `brose` bin)
        └── @broject/brotocol (contract: schema, types, invariants)
```

Core's `SpecStore`/`SpecNode` (the facade interface) stay in
`@broject/core` — they are bro's plugin contract, not the spec
format's contract. What `@broject/brotocol` owns is the *document*
contract; what brose owns is *operations on files*; what the plugin
owns is *beads-aware coverage and gating*.

### Methodology (the protocol)

Two decomposition axes, kept apart on purpose:

- The **spec tree** holds every durable project document, in two
  classes. *Product specs* describe what the system is; *policy
  specs* — `AGENTS.md`, `REVIEW.md`, `CONTRIBUTING.md` — describe
  how to think and work here: they explain the project, its core
  specs and its philosophy, and their first job is orientation —
  the entry points that route an agent into the spec tree. Same
  lifecycle class: persistent, owned, lintable. Policy specs keep
  their conventional paths (clients read `AGENTS.md` at the root;
  relocating them breaks the contract) and gain spec identity via
  frontmatter or a managed block — the `bro:sdd` markers y1jtm.7
  installs in REVIEW.md are the same idea. A spec is the textual
  RFC of the project; a policy doc is the constitution and the
  reader's guide, aimed at agents.
- The **bead graph** decomposes the *work*: epic → task → subtask,
  with dep edges. Transient; closes.

Cross-references are **one-directional: bead → spec**. A bead
declares its spec with `spec:` (the evidence path the gate already
reads) and may cite requirement anchors. The spec never names beads:
beads are swept and archived, specs persist — a durable document
citing ephemeral work items is rot by design. The reverse direction
(spec → open change beads) is a *derived* lookup: engines query the
task store for beads citing this spec, exactly what spec-ahead
conformance needs. Never force the two trees into a 1:1 mapping.

Phases, BMAD-mapped onto bro primitives:

1. **Intake** — an intent lands as a spec: `bro spec new` allocates a
   KEY-N id (post-y1jtm), status `draft`. No code yet.
2. **Refine** — requirements are listed inside the spec with stable
   anchors (`BRO-1#R3`); every open point is named — settle now,
   spike it, or leave it to the implementers. (BMAD refine-equivalent.)
3. **Incept** — the spec is sliced into beads: each bead cites the
   requirement anchors it covers; dep edges record order. The slice
   is reviewed before it is accepted. (BMAD incept-equivalent — the
   output is beads, not a second ticket tree.)
4. **Build** — a claimed bead needs spec evidence (the existing
   coverage gate). Spec-ahead is permissible only while a linked
   change bead is open (y1jtm conformance rule).
5. **Review** — the act gate plus lint decide conformance of the PR
   diff on two axes: code ↔ product spec AND code ↔ policy spec (a
   violated AGENTS.md rule is a defect of the same class as a
   spec-divergent behavior — REVIEW.md is already the gate's
   yardstick). `spec unchanged: <reason>` is the reviewed exception,
   not a loophole.
6. **Persist** — the bead closes; the spec stays on main, lifecycle
   moves `draft → active`. Decision history is the spec's git history
   plus optional `decisions/` parts — never another ticket-shaped
   spec series.

Enforcement axes — what is hard and what is soft:

- **Hard (facade + gate):** spec coverage (`check`), ownership lint,
  conformance verdicts, citation validity — CI-able, exit-coded.
- **Soft (prompt + guard):** methodology discipline. Refine and
  incept are nudged into context, never blocked — a guard cannot
  prove a refinement was honest.

BMAD is the methodological reference, not a component: its
initiative→epic→story vocabulary maps onto spec-tree + bead-graph,
and its pluggable ticket store has no beads backend. BMAD's
`tickets.toml` never owns status in bro — beads do. A later bridge
bead may translate BMAD output into beads; nothing else is adopted.

### Format

The Brotocol format **is** the y1jtm native schema, adopted by
reference (not restated): KEY-N identity with max+1 allocation,
required frontmatter (`id, title, status, area, owns, aliases` —
no `beads`, see below), optional `parent` / `superseded-by`, parts
as subfiles referenced `KEY-N/part`, lifecycle
`draft|active|deprecated|removed`, and no archival on bead closure.

Layout refines y1jtm's to one marker:

- **A spec is any `*.spec.md` file.** Flat spec:
  `<KEY-N>-<slug>.spec.md`. Dir spec: `<KEY-N>-<slug>/` whose index
  is `<KEY-N>-<slug>.spec.md` (repeated-name index, BMAD-style).
- `spec.md` / `README.md` remain accepted legacy indexes; inside a
  dir spec, other `.md` files are *parts*, not specs — the strict
  part-vs-child rule lands with the y1jtm migration (today's engine
  still counts nested `.md` as children for compatibility).
- Finding for y1jtm: its `<dir>/spec.md` index is ambiguous with
  parts; the `.spec.md` suffix is the unambiguous marker.

Additions this spec makes normative:

- **No `beads:` in spec frontmatter.** Divergence from y1jtm's
  required-fields list: a spec must never cite ephemeral work items —
  the change-link lives only on the bead (`spec:`), and engines
  invert it. Findings for y1jtm to fold back: drop `beads` from the
  required schema; "linked change beads" is a task-store query, not
  stored metadata.
- **Requirement anchors.** `## Requirements` items carry stable
  anchors `R<n>` cited as `KEY-N#R<n>` from beads and from other
  specs — the link between the two trees.
- **Policy specs.** Durable orientation documents (`AGENTS.md`,
  `REVIEW.md`) join the tree as spec nodes at their conventional
  paths — identity via frontmatter or a managed block, `area:
  policy`, no `owns` requirement. Their normative content is
  two-fold: *explain* (the project, its core specs, its philosophy)
  and *bind* (rules the review gate can check) — a policy spec
  that names no core specs is incomplete, same class of defect as
  a product spec owning nothing it should.
- **Emulation log** as a spec part: `KEY-N-<slug>/emulation.md`
  records spec-emulation runs (skill spec-emulation), turning into
  golden cases for the real engine.

Open question, explicitly not normative: `requires:` — cross-spec
requirement edges. Defer to a post-y1jtm schema extension rather than
invent syntax here.

### Packaging

| package | role | deps |
| ------- | ---- | ---- |
| `@broject/brotocol` | the contract: format types, frontmatter schema (zod per y1jtm), KEY-N/lifecycle invariants, pure validators over parsed docs. No fs — runs anywhere | zod only |
| `@broject/brose` | the engine: fs/git SpecFileStore — index, tree, resolve, scaffold, scope, drift — plus the `brose` bin (`new\|tree\|lint\|drift`). Usable standalone | `node:*`, zod, `@broject/brotocol`. **No other `@broject/*` deps** |
| `@broject/spec` | bro plugin: `bro spec` verbs, `sdd` config section, `sddConnector`, bead-coverage `check`, the specs-facade connector that adapts a brose store to core's `SpecStore` | `@broject/core`, `brose` |
| `@broject/openspec` | specs-facade connector for `openspec/` layout (moves from cli) | core |
| `@broject/speckit` | same for `.specify/` | core |
| `@broject/spec-kitty` | future — spec-kitty holds specs + plans + work packages; evaluate whether its lane state is a spec or a task concern | core |
| — (bmad) | no package: methodology reference; optional bridge bead translates BMAD output to beads | — |

Why the contract/engine split earns its package: connector authors
and other tools can validate or render Brotocol documents without
pulling a file store; brose stays installable in repos that will
never run bro and ships its own `brose` bin.

Facade resolution is unchanged: `connectors.specs` pin → remote →
matchDir → registry order. The plugin registers the brose-backed
connector under `brose` (`native` and `brotocol` remain aliases).
Engine-connector packages load via config `plugins[]`; the BroPlugin
contract today requires a command (`name`+`summary`+`run`), so a
connector-only export needs the contract to admit connectors-only
plugins.

### Extraction plan (incepted slice)

Implementation beads under `bro-bntld`; pure moves first:

1. Contract → `packages/brotocol` — frontmatter parsing, id/parent/
   scope rules, tree semantics as pure validators; grows into y1jtm's
   zod schema when that lands.
2. Engine → `packages/brose` — the native engine parts of
   `spec-connectors.ts` + `spec-drift.ts`, refactored to take
   `specDir`/`repoRoot` as parameters (zero `@broject` deps) + the
   `brose` bin; `SpecStore` stays in core.
3. Plugin seam — `bro spec` verbs + `sddConnector` either move to
   `packages/spec` or stay in cli adapting the engine (decide with 2;
   precedent favors cli-keeps-commands).
4. `@broject/openspec` connector package.
5. `@broject/speckit` connector package.
6. Methodology — `skills/sdd` rewritten around the protocol + docs.
7. `bro spec new` KEY-N allocation — blocked on bro-y1jtm landing the
   format (its .2/.5 children).
8. Connector-only plugin shape — blocks standalone connector
   publishing.

Stack order: 1 → 2 → {3, 4, 5} → 6; 7 waits on bro-y1jtm; 8 gates the
external publishing path.

### Relationship to bro-y1jtm

bro-y1jtm designs the model Brotocol adopts; this spec names and
packages it — a complement, not a rival. y1jtm's implementation
children land in the extracted package. If y1jtm is superseded,
Brotocol's format section falls back to today's bead-spec
conventions; the decoupling stands either way.

## Requirements

- **R1** — `bro spec` surface unchanged: verbs, `sdd` section, facade
  semantics and hook probes keep working through the move; a pure
  refactor verified by existing tests.
- **R2** — `brose` usable standalone: `npx brose tree` works in a
  repo with no bro install and no beads; the engine imports only
  `node:*`, zod and `@broject/brotocol`. `@broject/brotocol` itself
  never touches fs.
- **R3** — the specs facade admits third-party engines:
  openspec/speckit connectors ship as their own packages, resolve via
  config plugins or builtin registration, precedence preserved.
- **R4** — the methodology is one document: intake / refine / incept /
  build / review / persist defined against beads + spec tree,
  BMAD-mapped, with an explicit hard/soft enforcement split.
- **R5** — legacy spec material migrates: bead-spec records, sverka
  `NN-slug`, speckit and openspec readers live in the engine per
  y1jtm.6.
- **R6** — beads cite spec anchors `KEY-N` / `KEY-N#R<n>` via `spec:`:
  coverage shows in `bro spec check`; engines derive spec → bead
  lookups from the task store (format-level; post-y1jtm).

## Open questions

- Does `bro spec` stay in cli (every package today leaves commands
  there) or does `@broject/spec` own the plugin wholesale?
- Connector-only `BroPlugin`: `isPlugin` requires `run` — admit
  connectors-only exports or give each engine package a trivial
  `bro <engine> info` command?
- `requires:` cross-spec edges — post-y1jtm schema extension.
- spec-kitty spans both axes (specs AND work packages) — its connector
  may need a tasks-facade side too.
- How much of `bro spec check`/`drift` is bead-aware (plugin) vs
  pure-spec (brose): coverage over beads stays in the plugin; drift
  over git history is pure and lives in brose.
- Policy-spec mechanics: does a fixed-path doc carry frontmatter
  (not every client tolerates frontmatter in AGENTS.md) or a
  `bro:sdd`-style managed identity block; and whether `area: policy`
  vs a separate `kind:` field classifies it.

## Verify

- Emulation log: `specs/sdd/BRO-1-brotocol/emulation.md` — runs that
  become golden cases for the real engine (allocation, scaffold,
  coverage, lint, tree-with-parts).
- This PR, real tool: `bro spec check bro-bntld` → `link` (the
  `spec:` evidence path in the bead description); `bro spec tree`
  shows `BRO-1-brotocol` as a spec node under `sdd`.
- Post-extraction: `npm run build && npm run typecheck && npm test`
  unchanged; contract tests over all connectors; `bro doctor` /
  `bro spec init` detection identical.
- Epic acceptance: `npx -y @broject/bro` in a bare repo resolves
  `brotocol` as the specs engine; a repo with
  `plugins: ["@broject/openspec"]` resolves openspec;
  `bro spec check|tree|drift` output identical to pre-move.
