# bro-64gr — dir specs: the spec tree IS the filetree

## Problem

Spec trees were parent-pointer only: flat `specs/<id>.md` files with
`parent:` frontmatter. The tree existed in metadata, not on disk — a
spec could not be a folder of files (design.md, api.md, fixtures), and
the hierarchy was invisible to `ls`, grep, and reviewers browsing the
repo.

## Design

Native spec resolution is positional:

- A spec for `id` is `specs/<id>.md` **or** `specs/<id>/` — a directory
  whose index is `spec.md` (preferred) or `README.md`.
- Any spec-bearing entry nested inside a dir spec inherits its parent
  by position: `specs/sdd/bro-19g.md` → parent `sdd`;
  `specs/sdd/facade/spec.md` → id `facade`, parent `sdd`.
- `parent:` frontmatter still wins when present — a spec may keep a
  flat file and point at its parent (or override positional).
- `hasSpec(id)` resolves the id anywhere in the tree, not just at
  `<id>.md`; `spec new <id> --parent <p>` scaffolds inside `<p>/` when
  the parent is a dir spec.
- Non-index `.md` files in a dir spec are children; a subdir without an
  index does not become a node, but nested specs under it attach to the
  nearest spec-bearing ancestor.

Dogfood: bro's own specs/ reorganized — capability specs became
`<cap>/spec.md`, leaf bead specs moved into their capability folder,
`parent:` frontmatter dropped where position carries it.

## Plan

- [x] reorganize specs/ → `specs/<cap>/spec.md` + `specs/<cap>/<id>.md`
- [x] this spec lives positionally at `specs/sdd/bro-64gr.md`
- [x] native connector: recursive index, positional parents, dir hasSpec
- [x] `spec new --parent` writes inside dir specs (+ same-id collision refuse)
- [x] tests: dir spec detection, nested parents, frontmatter override
- [x] sdd SKILL.md documents the dir convention
