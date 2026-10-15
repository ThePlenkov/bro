# specs/ — convention

Specs are **per-bead design artifacts**: written before code, merged
with the PR, and left as the decision record. They are not
documentation — the site (`site/content/docs/`) is for readers; these
are for the mechanics of what was decided and why.

## What lives at the top level

- **Normative references** — specs cited from code comments, skills,
  or docs (`spec bro-x` in a comment is a load-bearing pointer).
- **In-flight work** — the spec of an open or in-progress bead.
- **Topic dirs** (`mesh/`, `cross-repo/`, `sdd/`, `plans/`, …) —
  curated spec areas, kept whole.

## What gets archived

`archive/` holds closed-bead specs nothing references — provenance,
not reading material. `git mv` keeps history attached; nobody curates
archive rows, nobody deletes them.

Rule of thumb: if a code comment or a skill says `spec bro-x`, that
spec stays top-level for as long as the citation lives. When the last
reference dies and the bead is closed, the spec retires to `archive/`.

## Adding a spec

`specs/<bead-id>.md`, `# <bead-id> — <title>` heading, problem →
design → verify. Reference the parent spec when you're a child bead —
that's how the normative set stays discoverable.
