---
parent: sdd
---

# bro-3kyf — spec tree dogfood

## Problem

The `parent:` tree mechanics shipped in bro-gkbe but bro itself had no
spec-of-specs: 17 flat bead specs, no root, no capability layer.

## Design

`specs/project.md` is the root (capability map + filetree); seven
capability specs (`review-gate`, `sdd`, `sessions`, `plans`, `distro`,
`backends`, `retro`) own package paths; each leaf bead spec carries
`parent: <capability>` frontmatter. Capability ids are plain names —
the spec dir is not bead-id-only.

## Plan

- [x] root + 7 capability specs with real ownership filetrees
- [x] parent: frontmatter on all leaf specs
- [x] `bro spec tree` renders the hierarchy (verified live)
