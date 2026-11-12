# Emulation log: BRO-2 policy specs (agent docs + sdd skill)

Spec: `specs/sdd/BRO-1-brotocol/BRO-2-policy-specs/BRO-2-policy-specs.spec.md`.
Stage: **mixed** — engine ops run real (`brose`, `brotocol`, current
`bro spec`); policy-doc tree membership is emulated until
`@broject/spec` lands. Parent: BRO-1.

## Run 1: scaffold — `brose new` (real)

- Command: `brose new --template brotocol/spec@1 --templates-dir
  packages/brotocol/templates --out specs/sdd/BRO-1-brotocol/
  BRO-2-policy-specs/BRO-2-policy-specs.spec.md --set id=BRO-2 …`
- Expected: dir spec nested under BRO-1's dir; template sections
  rendered.
- Actual: scaffold written; sections Problem/Design/Requirements/
  Verify rendered from `brotocol/spec@1`.
- **Finding (brose UX)**: `--template <ref>` does not pin the
  `template:` frontmatter field itself — `new` failed with
  `missing required field: template` until `--set
  template=brotocol/spec@1` was passed redundantly. The ref the user
  already declared should be written into the doc. → bead candidate
  for `@broject/brose`.
- Golden case: `brose new --template X` output always validates
  against X without extra `--set`.
- **Resolved (bro-bntld.4, [#1033](https://github.com/ThePlenkov/bro/pull/1033))**:
  root cause was the shipped templates declaring `template:` as a
  `required` field — engine provenance masquerading as author data.
  Dropped from `fields:` in `brotocol/spec@1` and `spec@1`; `create()`
  still pins `name@version` last. Re-verified: `brose new` without
  `--set template=` creates a doc that validates clean.

## Run 2: validate — `brose validate` (real)

- `brose validate` on `BRO-1-brotocol.spec.md` and this spec against
  `brotocol/spec@1` → both exit 0, no diagnostics.
- Golden case: a spec doc declaring `template: brotocol/spec@1`
  with all required fields + sections validates clean.

## Run 3: tree — `bro spec tree` (real, repo CLI build)

- Invocation: `node packages/cli/dist/index.js spec tree` (the
  repo's own build — the globally installed `bro` 0.3.0 predates
  `.spec.md` discovery and shows neither BRO spec; merged ≠ live).
- Actual:
  - `BRO-1-brotocol` shows as dir spec under `sdd`, with
    `emulation.md` counted as a child spec (known compat behavior —
    part-vs-child strictness lands with y1jtm).
  - `BRO-2-policy-specs` initially rendered at **root**, not under
    BRO-1: `parent: BRO-1` frontmatter named the spec's logical id,
    but today's connector derives node ids from **path names**
    (`BRO-1-brotocol` dir → id `BRO-1-brotocol`), so `BRO-1` dangled.
- **Fix applied**: `parent:` dropped — positional nesting inside
  `BRO-1-brotocol/` already supplies the edge; explicit `parent:`
  returns when the engine resolves frontmatter `id:` (post
  `@broject/spec`).
- **Finding (identity gap, known)**: today's tree id is
  path-derived (`BRO-1-brotocol`), while the spec's frontmatter
  declares `id: BRO-1`. KEY-N frontmatter identity is the BRO-1
  contract; path-derived ids are compat. → already tracked by the
  y1jtm/BRO-1 migration scope; restated here as the reason
  `parent: KEY-N` cannot be used yet.
- Golden case: post-`@broject/spec`, `bro spec tree` shows
  `BRO-2` nested under `BRO-1` via resolved frontmatter ids.

## Run 4: coverage — `bro spec check` (real)

- `bro spec check bro-bntld.2 bro-bntld.3` → both `link` — the beads'
  `spec:` declarations count even though the spec file is unmerged
  (declaration outranks discovery; resolution is drift's audit).
- Golden case: bead → spec citation works the day the bead is
  written, before the spec lands.

## Run 5: policy docs in `tree()` (emulated)

- Spec reference: BRO-2 Design — identity region after title,
  `area: policy`, `core:` non-empty.
- Input: AGENTS.md/REVIEW.md/CONTRIBUTING.md with `bro:sdd` identity
  blocks (ids BRO-3/BRO-4/BRO-5).
- Expected by spec: `tree()` returns three `area: policy` roots
  alongside product specs; `parent:` none (they are roots); each
  `core:` list resolves to real spec ids.
- Actual: **impossible today** — `specProtocol`'s doc glob is
  `*.spec.md`; fixed-path `.md` docs are invisible. Emulated by hand:
  identity blocks are inert text; nothing breaks.
- Gap → finding for `@broject/spec`: protocol needs a fixed-path
  policy-doc class (or the plugin maps conventional paths onto
  protocol docs). Not implemented here by design.
- Golden case: `bro spec show BRO-4` renders REVIEW.md's identity +
  gate regions; `core:` entries resolve.

## Run 6: explain+bind lint (emulated)

- Spec reference: BRO-2 R1 — `core:` non-empty, resolves to real ids.
- Actual: hand-check at implementation time — each block's `core:`
  must name specs that exist in the tree (BRO-1, BRO-2, and the
  legacy `specs/sdd/*.md` specs where relevant). A policy doc naming
  no core specs is incomplete.
- Golden case: lint flags a policy block with empty/dangling `core:`.
