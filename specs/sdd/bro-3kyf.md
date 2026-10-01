# bro-3kyf — spec tree dogfood

## Problem

The `parent:` tree mechanics shipped in bro-gkbe but bro itself had no
spec-of-specs: 18 flat bead specs, no root, no capability layer.

## Design

`specs/project.md` is the root (capability map + filetree); seven
capability dir specs (`<cap>/spec.md`) own package paths; leaf bead
specs nest inside their capability dir — position is the edge. Capability ids are plain names —
the spec dir is not bead-id-only.

## Plan

- [x] root + 7 capability specs with real ownership filetrees
- [x] leaf specs nested in capability dirs — position is the parent edge
- [x] `bro spec tree` renders the hierarchy (verified live)
