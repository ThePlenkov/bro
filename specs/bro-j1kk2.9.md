# bro-j1kk2.9 — specs/: curate live specs into site docs, archive the rest

Owner call (2026-10-15): option (a) — promote curated specs into the
site as design docs, archive the rest under `specs/archive/`, and let
`specs/README.md` carry the convention.

## Policy (the convention README encodes)

`specs/` top level holds only:

- **normative references** — specs cited from code comments, skills,
  or site content (a `spec bro-x` comment is a load-bearing pointer;
  archiving the target rots the citation);
- **in-flight work** — the spec of an open/in-progress bead;
- **topic dirs** (`mesh/`, `cross-repo/`, `sdd/`, …) — already-curated
  areas, kept whole.

Everything else — closed-bead artifacts nothing cites — moves to
`specs/archive/` via `git mv` (history stays attached). Archive rows
are provenance, not docs: nobody curates them, nobody deletes them.

## This pass

- 15 loose specs qualify for archive (closed beads, zero references):
  2szm, 5lfp1, 7z2q, 8o9f8, d6k4v, g0ti, hcx5p, j1kk2.4, j1kk2.5,
  j1kk2.8, j1kk2.10, n59xn, pw69n, ujipn, z76f2.
- `specs/README.md` — the convention above.
- Site gains a Design section (`site/content/docs/design/`): three
  narrative pages distilled from the normative specs — the rig engine
  (`bro-oy3k1.*`), the mesh protocol (`specs/mesh/`, `cross-repo/`),
  the planes layer (`bro-9rls.*`) — each page stands alone and names
  its spec sources; `meta.json` wires the section.

## Non-goals

- Rewriting spec prose into docs verbatim — design pages narrate, the
  spec stays the source of record.
- Touching topic-dir internals.
