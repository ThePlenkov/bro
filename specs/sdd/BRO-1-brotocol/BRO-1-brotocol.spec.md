---
template: brotocol/spec@1
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
- **Brose** — the markdown *template engine*: a template registry
  (dedicated folder), a frontmatter model, template versions, and a
  library API (`parse`/`render`/`validate`) behind a thin `brose`
  CLI (`new` + `validate`). Generic — it knows templates, not
  specs; spec knowledge arrives as brose templates shipped by
  brotocol. A `.spec.md` file is an md file that matches a spec
  template.
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
@broject/spec (bro plugin: spec store, verbs, sdd config, hooks, facade)
    └── @broject/brotocol (filetree protocol: CRUD, search, graph,
                           spec specialization)
        └── @broject/brose (template engine: registry, render, parse,
                            validate, versions, `brose` bin)
```

Core's `SpecStore`/`SpecNode` (the facade interface) stay in
`@broject/core` — they are bro's plugin contract, not the spec
format's contract. What `@broject/brotocol` owns is the *protocol
and its shipped templates*; what brose owns is *template mechanics*;
what the plugin owns is *beads-aware gating*. Brose never depends
on brotocol — shipped templates reach it through registry dirs
(`templateDirs`), so the engine stays generic while the contract
supplies the template pack.

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
- A legacy flat file named `foo.spec.md` re-reads as id `foo`
  (the marker strips as a unit), not `foo.spec`. Old scaffolds never
  wrote the suffix, but an older spec could still carry id
  `foo.spec` — such a file now resolves to id `foo`. Before
  upgrading, grep for `*.spec.md` files whose stripped id already
  exists in the tree and rename the legacy one to
  `foo.spec.spec.md`; the collision is a filename fix, not an engine
  change.
- `spec.md` / `README.md` remain accepted legacy indexes; inside a
  dir spec, other `.md` files are *parts*, not specs — the strict
  part-vs-child rule lands with the y1jtm migration (today's engine
  still counts nested `.md` as children for compatibility).
- Finding for y1jtm: its `<dir>/spec.md` index is ambiguous with
  parts; the `.spec.md` suffix is the unambiguous marker.

### Templates

A `.spec.md` is a brose document declaring its template:

```yaml
---
template: brotocol/spec@1
id: BRO-1
title: …
status: draft
---
```

- **Template = frontmatter schema + section structure + version.**
  The `spec` template ships from `@broject/brotocol` (it IS the
  contract); `policy`/`review` templates follow for the policy class.
- **`brose validate`** checks a doc against its declared template's
  version — fields/types, required sections, anchors. `bro spec lint`
  is validate + tree invariants.
- **Versions.** Templates are `name@version`; a doc pins the version
  it implements. Bumping the template flags implementors as
  template-drifted until re-validated or migrated (`brose` re-render
  assist; y1jtm.6 migration is the spec@1→spec@2 case).
- **Registry.** Project templates live in `.brose/templates/`
  (override by `name@version`); shipped templates come from
  `@broject/brotocol`. Scaffold (`bro spec new`) renders the resolved
  template — `scaffoldBody` in today's connector is the hand-written
  `spec@0` this replaces.
- **Parse/render contract.** `parse(file)` returns `{ frontmatter,
  sectionTree }` — markdown-it's token stream gives heading tokens
  with `map` line ranges (fences and inline `#` handled correctly,
  unlike a heading regex), enough for section structure and
  splice-preserving edits: spec docs must stay byte-stable where
  untouched, a full-doc serializer churns git diffs — and
  markdown-it has none, which suits us (md→tokens only). `render`
  is string template interpolation — an SDK op, not a CLI op.
  Library surface: `parse`/`render`/`validate`/`new`; the `brose`
  bin exposes only `new` + `validate`. A *template* is a
  declarative document schema — `{ frontmatter: zodSchema,
  sections: SectionSpec[] }` — the ProseMirror-schema idea without
  the editor toolkit. Decision: **markdown-it, no ProseMirror** —
  PM's doc model serves WYSIWYG editing (selections, marks), its
  markdown adapter wraps markdown-it anyway, and serialize-the-doc
  loses frontmatter, HTML-comment managed blocks and byte fidelity.
  A spec *editor* UI could adopt PM later — editor concerns are a
  different package.

Additions this spec makes normative:

- **Schema deviations recorded for y1jtm reconciliation.** This spec
  deliberately departs from y1jtm's drafted field list in two places
  and records them so the validator/scaffold/lint contract can be
  amended in y1jtm rather than silently drifted: `beads:` is
  prohibited (below) and `template:` is added (its required-vs-latest
  semantics stay an open question until y1jtm's schema absorbs it).
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
| `@broject/brotocol` | the contract: frontmatter schema (zod per y1jtm), KEY-N/lifecycle invariants, and the spec *templates themselves* (`spec@N`, later `policy@N`…). No fs — runs anywhere | zod only |
| `@broject/brose` | the template engine: template folder/registry, `parse`/`render`/`validate` library API over frontmatter+sections, `name@version` resolution, `brose` bin (`new\|validate`). Generic — usable standalone with no bro | `node:*`, markdown-it, zod. **No `@broject/*` deps** |
| `@broject/spec` | bro plugin + spec store: `bro spec` verbs, `sdd` section, `sddConnector`, index/tree/resolve/scope/drift on top of brose, bead-coverage `check`, specs-facade connector | `@broject/core`, `brose`, `@broject/brotocol` |
| `@broject/openspec` | specs-facade connector for `openspec/` layout (moves from cli) | core |
| `@broject/speckit` | same for `.specify/` | core |
| `@broject/spec-kitty` | future — spec-kitty holds specs + plans + work packages; evaluate whether its lane state is a spec or a task concern | core |
| — (bmad) | no package: methodology reference; optional bridge bead translates BMAD output to beads | — |

Why the template-engine split earns its package: `brose validate`
works in any repo with md docs — specs are just the first template
pack. The template seam is also how repos customize: a
`.brose/templates/` folder overrides the shipped spec template by
`name@version`, and a doc pins the template it implements via
`template:` frontmatter. A doc lagging its template is *template
drift* — a third drift axis beside code drift and spec-ahead.

Facade resolution is unchanged: `connectors.specs` pin → remote →
matchDir → registry order. The plugin registers the brose-backed
connector under `brose` (`native` and `brotocol` remain aliases).
Engine-connector packages load via config `plugins[]`; the BroPlugin
contract today requires a command (`name`+`summary`+`run`), so a
connector-only export needs the contract to admit connectors-only
plugins.

### Extraction plan (incepted slice)

Implementation beads under `bro-bntld`; pure moves first:

1. Engine → `packages/brose` — the markdown template engine:
   frontmatter parsing (the YAML/frontmatter helpers move here),
   markdown-it token-stream section model, template registry +
   `name@version` resolution, `parse`/`render`/`validate`/`new`
   library API, `brose` bin (`new|validate`). No `@broject/*` deps.
2. Contract → `packages/brotocol` — the spec template(s) plus
   invariants: id/parent/scope rules and tree semantics as pure
   validators over brose docs; grows into y1jtm's zod schema.
3. Plugin+store → `packages/spec` — index/tree/resolve/scope/drift
   over brose docs; `bro spec` verbs + `sddConnector` either move
   here or stay in cli adapting it (decide with 2; precedent favors
   cli-keeps-commands). `SpecStore` stays in core.
4. `@broject/openspec` connector package.
5. `@broject/speckit` connector package.
6. Methodology — `skills/sdd` rewritten around the protocol + docs.
7. `bro spec new` KEY-N allocation — blocked on bro-y1jtm landing the
   format (its .2/.5 children).
8. Connector-only plugin shape — blocks standalone connector
   publishing.

Stack order: 1 → 2 → 3 → {4, 5} → 6; 7 waits on bro-y1jtm; 8 gates
the external publishing path.

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
- **R2** — `brose` usable standalone: `npx @broject/brose validate
  <file>` works in a repo with no bro install and no beads; the
  engine imports only `node:*`, `markdown-it` and `zod`.
- **R3** — the specs facade admits third-party engines:
  openspec/speckit connectors ship as their own packages, resolve via
  config plugins or builtin registration, precedence preserved.
- **R4** — the methodology is one document: intake / refine / incept /
  build / review / persist defined against beads + spec tree,
  BMAD-mapped, with an explicit hard/soft enforcement split.
- **R5** — legacy spec material migrates: bead-spec records, sverka
  `NN-slug`, speckit and openspec readers live in their connector
  packages per y1jtm.6 — foreign layouts are connector concerns,
  never engine internals.
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
- Template registry layout: `.brose/templates/` vs `sdd.dir/
  _templates/`; and whether template drift blocks lint or reports
  advisory-only.
- Does `template:` belong in the required frontmatter (every spec
  declares its template) or is absence = `spec@latest`?

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
