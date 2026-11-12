# Emulation log: Brotocol / Brose (y1jtm product-spec model)

Spec: `specs/sdd/BRO-1-brotocol/BRO-1-brotocol.spec.md`; schema contract emulated
from `specs/sdd/bro-y1jtm.md` (KEY-N, frontmatter, parts). Stage:
**manual**. The emulated tools are the future `brose` engine surface
and the post-y1jtm `bro spec` behavior; today's real CLI stands in
wherever it already implements the contract.

## Run 1: allocation — `brose new` (emulated KEY-N allocation)

- Spec reference: y1jtm "Allocate `max + 1` over allocated numbers on
  main"; `sdd.key` derives deterministically from the repo name.
- Input: main @ `f2e9d280`, `sdd.dir=specs`, repo name `bro`.
- Expected by spec: scan allocated KEY-N on main → none → `BRO-1`;
  persist derived key to `sdd.key` on first allocation.
- Actual: no `*[A-Z]+-N*` files and no `id:` frontmatter anywhere on
  main → allocated **BRO-1**, slug `brotocol` →
  `specs/sdd/BRO-1-brotocol/BRO-1-brotocol.spec.md`.
- Gap found: today's `sdd` config section only parses `{mode, dir}` —
  `sdd.key` written by the emulated allocation would be silently
  ignored by the real parser until y1jtm lands. Proposed wording:
  "sdd.key is allocated by the engine; config parsers tolerate the
  unknown key before the section schema learns it."
- Golden case: allocation on an empty KEY-N repo yields `KEY-1`;
  next allocation yields `KEY-2`.

## Run 2: scaffold — dir spec nested under an area dir

- Spec reference: y1jtm layout `<KEY-N>-<slug>.md` or
  `<KEY-N>-<slug>/spec.md` "under `sdd.dir`"; child spec carries
  `parent: KEY-N`. BRO-1 refines: dir index is `<dirname>.spec.md`.
- Input: id `BRO-1`, intended parent = the sdd product spec
  (`specs/sdd/spec.md` — a legacy spec with no KEY-N).
- Expected by spec: file under `sdd.dir`, `parent:` naming a KEY-N.
- Actual: placed at `specs/sdd/BRO-1-brotocol/BRO-1-brotocol.spec.md`
  — nested under the sdd area dir, renamed after adopting the
  `.spec.md` marker. `parent:` omitted: the parent spec predates the
  KEY-N migration and has no id to name; position supplies the tree
  edge today.
- Gap found: y1jtm does not say whether topic dirs (`specs/sdd/`)
  survive migration as non-spec ancestors, or whether `area`
  frontmatter replaces directory grouping. Proposed wording: "topic
  dirs remain; they are transparent containers — `area` classifies,
  directories only organize."
- Gap found (resolved by the `.spec.md` marker): y1jtm's `spec.md`
  index is ambiguous with parts — a dir spec's `emulation.md` indexed
  as a *child spec* under today's engine. `*.spec.md` = spec, other
  `.md` = part is the mechanical rule.
- Golden case: `parent:` must reference a resolvable KEY-N; a
  pre-migration parent resolves by position until migrated.

## Run 3: coverage — `bro spec check` (real tool, not emulated)

- Invocation: `bro spec check bro-bntld`
- Spec reference: evidence precedence — declared `spec:` link
  outranks discovered files.
- Expected by spec: `link` verdict (bead description carries
  `spec: specs/sdd/BRO-1-brotocol/BRO-1-brotocol.spec.md`).
- Actual: `bro-bntld  link  Brotocol: extract bro's spec engine — …`
  — exit 0.
- Friction: none. The `spec:` evidence path is the bridge between the
  bead graph and the spec tree while discovery still keys on bead ids.

## Run 4: tree — `bro spec tree` (real tool, partially emulated)

- Invocation: `bro spec tree`
- Spec reference: the spec tree nests children under dir specs.
- Expected by spec: `BRO-1-brotocol` resolves as a spec node under
  `sdd`.
- Actual:

  ```text
  sdd  specs/sdd/spec.md
    BRO-1-brotocol  specs/sdd/BRO-1-brotocol/BRO-1-brotocol.spec.md
      emulation  specs/sdd/BRO-1-brotocol/emulation.md
    bro-19g  specs/sdd/bro-19g.md
    …
  ```

  (`emulation` still renders as a child — today's compat rule counts
  any nested `.md`; post-migration it's a *part* since it's not
  `.spec.md`.)
- Note: today's walker labels the node by directory name
  (`BRO-1-brotocol`), not by the frontmatter `id:` field — cosmetic;
  post-y1jtm resolution keys on the `KEY-N-` prefix.
- Engine support shipped in this PR: `<dirname>.spec.md` is a dir
  index (preferred over `spec.md`/`README.md`), `*.spec.md` strips
  its suffix into the id, scaffold writes `<id>.spec.md`.

## Run 5: lint — emulated schema check over spec.md

- Spec reference: y1jtm required frontmatter `id, title, status,
  area, owns, beads, aliases`; unknown keys fail loud; refs validated.
- Check performed by hand:
  - fields: `id, title, status, area, owns, aliases` present, no
    unknown keys — pass
  - `status: draft` ∈ `draft|active|deprecated|removed` — pass
  - `beads:` **absent** — spec files never cite ephemeral work items
    (bead → spec edge only; see spec's format section). Deviation
    from y1jtm's required list, filed as a finding below.
  - `owns:` — all five paths exist on main — pass; overlaps the
    legacy `specs/sdd/spec.md` "Owns" prose section, but that file
    has no frontmatter owner — no duplicate-owner error
  - `aliases: []` — legal (empty arrays allowed)
  - `parent:` absent — legal for a position-nested node
- Result: schema-valid under y1jtm rules modulo the `beads` finding.
- Finding for y1jtm: required `beads:` puts archived/dead references
  in a durable artifact; "linked change beads" should be a task-store
  query, not stored metadata.
- Golden cases: unknown frontmatter key → loud failure; `status`
  outside enum → failure; `beads:` key present → warn "spec must not
  cite ephemeral work items" (or hard error once y1jtm drops it).
- Recorded schema deviations vs y1jtm (its schema rejects
  unconfigured keys — the hand-check cannot pass under y1jtm rules
  with only the `beads` deviation): `beads:` prohibited, `template:`
  added (doc → template pin; not in y1jtm's field list).

## Run 6: validate — `brose validate` (emulated template check)

- Spec reference: Templates — a `.spec.md` declares
  `template: brotocol/spec@1`; validate checks the declared version's
  schema + sections.
- Input: this spec file.
- Expected by spec: pass (frontmatter fields present, required
  sections Problem/Design/Requirements/Verify present).
- Actual: pass by hand-check — `template:` now declared in
  frontmatter, all required fields/sections present.
- Friction: `emulation.md` itself is a part — under the strict rule
  it carries no `template:` and validates as part-of-spec, not as a
  spec doc. Confirms the part-vs-child split needs the `.spec.md`
  marker (a part must never be forced through the spec template).
- Golden cases: missing `template:` → error or `spec@latest`
  (open question); pinned `spec@1` validated against `spec@2` →
  template-drift report; `.md` non-spec file → skipped, never
  validated.

## Real replay — `@broject/brose` + `@broject/brotocol` (2026-…, PR stacked)

The emulated commands now exist. Replays against real binaries:

- **Run 1/6 — scaffold + validate:**
  `brose new --template brotocol/spec@1 --set template=brotocol/spec@1
  --set id=BRO-2 --set title="Demo spec" --out /tmp/brose-new-demo.spec.md
  --templates-dir packages/brotocol/templates`
  produced a frontmatter-complete spec doc; `brose validate` on it →
  clean exit 0. `brose validate` on THIS spec file
  (`BRO-1-brotocol.spec.md`, pins `brotocol/spec@1`, same
  `--templates-dir`) → clean exit 0.
  The bare `brose` bin resolves templates only from `--templates-dir`
  and `<cwd>/.brose/templates/`; the shipped `brotocol/spec@N` dir is
  wired in by `specProtocol`'s `templateDirs` on the API side, so the
  CLI replay passes it explicitly.
  Note: the spec template requires the doc to declare its own
  `template:` — `new` without `--set template=…` fails
  `missing required field: template`, as designed.
- **Run 2/4 — tree + parts:** `tree(specProtocol({dir:'specs'}))`
  renders the real tree — `BRO-1` nested under `sdd`, and
  `emulation.md` is NOT a node: the strict parts rule holds on the
  real store (this file is a part, matching the spec's intent).
  Legacy `spec.md`/`README.md` indexes still resolve as docs via
  `indexAliases`.
- **Graduated:** Runs 1, 2, 4, 5, 6 now have real implementations
  (`brose new`/`validate`, `brotocol scan/graph/tree/lint`). Run 3
  (`check`) remains the bro connector's bead-coverage role — plugin
  land, per the spec's layering.

## Graduation notes

- Stage: manual → scripted. Run 3 and 4 already run against the real
  CLI — the bridge parts are real dogfooding, not emulation.
- When `packages/brose` lands: replay Runs 1, 2, 5 as tests —
  allocation, scaffold-under-area-dir, and lint fixtures as written.
- Open question logged to spec: whether `emulation.md` (a part
  subfile) should be indexed as a child spec by today's walker —
  post-y1jtm it's a *part*, not a spec.

## Real replay — `@broject/spec` connector (2026-11-12, PR #1031)

The plugin layer landed: `specConnector` (name `brose`) registers ahead
of `native` and serves this repo's own `specs/` tree — a live hybrid
of KEY-N protocol docs and ~340 legacy bead specs.

- **tree:** `bro spec tree` (worktree cli) renders `sdd` → `BRO-1` →
  `BRO-2` from frontmatter `id:`s — the path-derived legacy ids
  (`BRO-1-brotocol`) are gone — while every `bro-*.md` bead spec still
  resolves through the merged legacy index. `emulation.md` parts show
  as legacy child specs re-parented by the orphan fixup, matching
  native's view. No dangling-parent diagnostics.
- **check:** `bro spec check bro-bntld.2|.3|.5` → `link` (unchanged —
  the `spec:` link path never touched the connector).
- **drift:** `bro spec drift` → 248 stale rows; `scope()` reads
  `owns:`/`scope:` frontmatter on protocol docs and `specScope()` on
  legacy files.
- **new:** `bro spec new bro-zztest` wrote `specs/bro-zztest.spec.md`
  rendered from `brotocol/spec@1` (`template:`/`id:`/`status:`
  frontmatter, Problem/Design/Requirements/Verify sections) — the
  first spec scaffolded by the engine, not `scaffoldBody`.
- **init:** scratch repo with a `.spec.md` doc → `spec init` detects
  `brose` and writes `connectors.specs: "brose"`; legacy-only and
  tool-layout repos detect `native`/`speckit`/`openspec` as before.
- **Finding (closed in-plugin):** `specTemplateDir` derives from
  brotocol's `import.meta.url` — inside the bundled cli that URL lands
  in cli's dist, so `create` saw `unknown template`. The connector
  resolves `@broject/brotocol` through `createRequire` and prepends
  the real `templates/` dir; `specTemplateDir` stays as fallback.
- **Finding (tooling):** nx's per-project cache does not see
  `@broject/*` source changes through the bundle — a dependency rebuild
  can leave `cli/dist` stale (`--skip-nx-cache` on `@broject/bro:build`
  is the local workaround; CI builds fresh).
