# Emulation log: Brotocol / Brose (y1jtm product-spec model)

Spec: `specs/sdd/BRO-1-brotocol/spec.md`; schema contract emulated
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
  `specs/sdd/BRO-1-brotocol/spec.md`.
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
  `parent: KEY-N`.
- Input: id `BRO-1`, intended parent = the sdd product spec
  (`specs/sdd/spec.md` — a legacy spec with no KEY-N).
- Expected by spec: file under `sdd.dir`, `parent:` naming a KEY-N.
- Actual: placed at `specs/sdd/BRO-1-brotocol/spec.md` — nested under
  the sdd area dir. `parent:` omitted: the parent spec predates the
  KEY-N migration and has no id to name; position supplies the tree
  edge today.
- Gap found: y1jtm does not say whether topic dirs (`specs/sdd/`)
  survive migration as non-spec ancestors, or whether `area`
  frontmatter replaces directory grouping. Proposed wording: "topic
  dirs remain; they are transparent containers — `area` classifies,
  directories only organize."
- Golden case: `parent:` must reference a resolvable KEY-N; a
  pre-migration parent resolves by position until migrated.

## Run 3: coverage — `bro spec check` (real tool, not emulated)

- Invocation: `bro spec check bro-bntld`
- Spec reference: evidence precedence — declared `spec:` link
  outranks discovered files.
- Expected by spec: `link` verdict (bead description carries
  `spec: specs/sdd/BRO-1-brotocol/spec.md`).
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
    BRO-1-brotocol  specs/sdd/BRO-1-brotocol/spec.md
    bro-19g  specs/sdd/bro-19g.md
    …
  ```
- Note: today's walker labels the node by directory name
  (`BRO-1-brotocol`), not by the frontmatter `id:` field — cosmetic;
  post-y1jtm resolution keys on the `KEY-N-` prefix.

## Run 5: lint — emulated schema check over spec.md

- Spec reference: y1jtm required frontmatter `id, title, status,
  area, owns, beads, aliases`; unknown keys fail loud; refs validated.
- Check performed by hand:
  - fields: all seven present, no unknown keys — pass
  - `status: draft` ∈ `draft|active|deprecated|removed` — pass
  - `beads: [bro-bntld]` — bead exists — pass
  - `owns:` — all five paths exist on main — pass; overlaps the
    legacy `specs/sdd/spec.md` "Owns" prose section, but that file
    has no frontmatter owner — no duplicate-owner error
  - `aliases: []` — legal (empty arrays allowed)
  - `parent:` absent — legal for a position-nested node
- Result: schema-valid under y1jtm rules.
- Golden cases: unknown frontmatter key → loud failure; `status`
  outside enum → failure; `beads:` naming a closed bead → warning,
  not error (a spec outlives its beads).

## Graduation notes

- Stage: manual → scripted. Run 3 and 4 already run against the real
  CLI — the bridge parts are real dogfooding, not emulation.
- When `packages/brose` lands: replay Runs 1, 2, 5 as tests —
  allocation, scaffold-under-area-dir, and lint fixtures as written.
- Open question logged to spec: whether `emulation.md` (a part
  subfile) should be indexed as a child spec by today's walker —
  post-y1jtm it's a *part*, not a spec.
