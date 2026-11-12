---
template: brotocol/spec@1
id: BRO-2
title: Policy specs — agent docs join the spec tree; sdd skill rewrite
status: draft
area: sdd
owns:
  - AGENTS.md
  - REVIEW.md
  - CONTRIBUTING.md
  - skills/sdd/
aliases: []
---

# BRO-2 — Policy specs — agent docs join the spec tree; sdd skill rewrite

## Problem

BRO-1 defines two spec classes — product specs (`*.spec.md`, KEY-N ids)
and policy specs (fixed-path orientation/binding docs). bro's own repo
practices neither consistently:

- `AGENTS.md` and `CONTRIBUTING.md` carry no spec identity at all.
- `REVIEW.md` carries a `bro:sdd` managed block (the SDD gate rules) but
  no identity — the tree cannot see it as a spec node.
- `skills/sdd/SKILL.md` still teaches the legacy bead-keyed model
  (`<bead-id>.spec.md`); the repo's spec tree has already moved to
  `*.spec.md` + KEY-N.

The methodology is not dogfooded: the repo does not practice what
BRO-1 preaches. This spec is the split of BRO-1's remaining
methodology scope (extraction item 6) — engine extraction is done,
the docs must catch up.

## Design

### Identity mechanism — managed `bro:sdd` block, never frontmatter

Settles BRO-1's open question for the policy class. Fixed-path docs are
read literally by every agent client (Claude, Codex, Cursor, Devin,
humans); YAML frontmatter at the top is not universally tolerated and
these files predate specs. An HTML-comment managed region is inert to
every renderer, machine-parseable, and already proven — `REVIEW.md`'s
gate block is the precedent.

Contract:

- Each policy doc carries exactly one `bro:sdd` **identity region**
  immediately after its title, with YAML-ish `key: value` fields:
  `id`, `title`, `area: policy`, `status` (same lifecycle enum),
  `core: [KEY-N, …]` — the product specs the doc routes an agent to.
- A policy doc may carry additional `bro:sdd` regions for managed
  normative content (REVIEW.md's gate rules are the precedent).
  Regions are self-describing via markers; count is unconstrained.
  The identity region is the only one the tree reads today.
- Policy docs get **KEY-N ids** like product specs — uniform
  `resolve(id|alias)`, and policy requirements become citable anchors
  (`BRO-5#R1` = "the `spec unchanged:` exception"). Allocation follows
  the repo sequence: `AGENTS.md` → BRO-3, `REVIEW.md` → BRO-4,
  `CONTRIBUTING.md` → BRO-5.
- `area: policy` (not a separate `kind:` field) — one field vocabulary
  across both classes; settles the second half of BRO-1's open
  question. Policy specs have no `owns` requirement; instead the
  **explain+bind rule**: a policy spec must name the core specs it
  routes to (`core:` non-empty) — a policy doc naming no core specs is
  incomplete, same defect class as a product spec owning nothing.

### skills/sdd rewrite — two-class model

`skills/sdd/SKILL.md` is rewritten around the BRO-1 model:

- **What counts as a spec** gains the policy class: fixed-path docs
  with `bro:sdd` identity are spec nodes; `spec:` links unchanged.
- Product-spec mechanics documented as they exist: `*.spec.md` marker,
  dir specs, `parent:` frontmatter, `template:` pin, lifecycle
  `draft|active|deprecated|removed`, requirement anchors `R<n>` cited
  `KEY-N#R<n>`.
- Enforcement reality is stated honestly: `bro spec` today runs the
  native connector (bead-keyed discovery + `*.spec.md` dir specs);
  KEY-N allocation, lifecycle lint, and policy-doc discovery land with
  `@broject/spec`. The skill is policy — mechanics claims must match
  what the CLI does now; pending items are marked, not promised.
- `plugins/` generated adapters are regenerated via
  `scripts/gen-plugins.ts` in the same change — a stale manifest ships
  verbatim (REVIEW.md severity rule).

### Engine gap — recorded, not implemented

`specProtocol`'s doc glob is `*.spec.md`; fixed-path policy docs are
invisible to it. Policy-doc discovery is `@broject/spec` / protocol
work (a fixed-path doc class or plugin-side mapping) — out of scope
here, logged as a finding for the plugin bead. Until then identity
blocks are inert text: spec-ahead, covered by the linked beads.

### owns migration

`skills/sdd/` moves from BRO-1's `owns` to BRO-2's — the skill rewrite
is this spec's work, and no path may be owned by two specs. BRO-1's
spec text is amended in the same diff.

## Requirements

- **R1** — `AGENTS.md`, `REVIEW.md`, `CONTRIBUTING.md` each carry a
  `bro:sdd` identity region directly under the title: KEY-N id,
  `area: policy`, title, lifecycle `status`, non-empty `core:` naming
  the product specs it routes to.
- **R2** — Identity lives only in managed `bro:sdd` regions, never in
  frontmatter — every agent client must keep reading the docs
  literally.
- **R3** — `skills/sdd/SKILL.md` teaches the two-class model; every
  mechanic claim matches current `bro spec` behavior, pending-engine
  items marked. Generated `plugins/` adapters regenerated.
- **R4** — `skills/sdd/` is owned by BRO-2 alone; BRO-1's `owns`
  relinquishes it in the same diff.
- **R5** — `emulation.md` logs real `brose`/`brotocol` runs plus
  emulated policy-tree runs; engine gaps become findings, not silent
  omissions.

## Verify

- `brose validate` clean on `BRO-1-brotocol.spec.md` and this spec
  against `brotocol/spec@1`.
- `bro spec tree` shows `BRO-2-policy-specs` nested under
  `BRO-1-brotocol` (real connector already reads `*.spec.md` dir
  specs); `bro spec check bro-bntld.2|.3` → `link`.
- Emulated `tree()` post-`@broject/spec`: the three docs appear as
  `area: policy` roots — golden case for the plugin.
- Hand lint: each identity block's `core:` resolves to real spec ids.
- CI: `check:plugins`/`check:embedded` green after adapter regen;
  markdownlint clean on edited docs.
