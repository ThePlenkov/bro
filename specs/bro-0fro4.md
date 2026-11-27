# bro-0fro4 — archive closed, unreferenced bead specs

## Problem

The legacy `specs/<bead-id>.md` convention leaves closed design records in the
live spec tree indefinitely. The repository documents that a closed bead spec
may move to `specs/archive/` once no code, skill, or documentation references
it, but checking that rule is manual and easy to forget. The archiver must
make this decision reproducible without moving specs that are still normative
or in-flight.

## Design

Add `scripts/archive-specs.ts`, a repository-local, read-only-by-default
sweep. It considers only regular, top-level `specs/<id>.md` files whose stem
looks like a bead id (`bro-…`). For each candidate it:

1. asks `bd list --all --json` once and accepts only a record whose status is
   `closed`; failures and unknown beads are retained and reported;
2. searches repository files for the bead id, excluding the candidate itself,
   `.git`, dependency/build directories, and `specs/archive/`. A match means
   the spec is referenced, including references from the spec README or other
   specs;
3. classifies the candidate as `archive` only when both predicates hold.

The command prints every candidate and its reason and performs no writes by
default. `--apply` creates `specs/archive/` if necessary and uses a checked,
repo-local rename equivalent to `git mv` for each classified file. The archive
is provenance, not a second live spec index; references are not rewritten.
The command never deletes or mass-moves nested/product specs. A later cleanup
step may invoke `--apply` after reviewing the dry-run output.

The classifier is exported as pure functions so tests can exercise closed,
open, and referenced cases without depending on the local beads database.

## Verify

- Unit tests cover: closed and unreferenced → archive; open → retain;
  closed and referenced → retain; and a failed bead lookup → retain.
- Run the script in this repository without `--apply` and confirm it prints a
  dry-run classification without changing the worktree. This PR does not
  apply the migration to the existing spec corpus.
- Run `npm run test:scripts` and `npm run typecheck`; run `npm run check:docs`
  to ensure the published-surface/document checks remain green.
