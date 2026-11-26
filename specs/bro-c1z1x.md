---
parent: project
---

# `bro skills add|update|remove`

## Problem

The project lockfile already describes external Agent Skills, but the bro
facade only exposes reconciliation and sync.  Users must know the upstream
`skills` CLI, and the external `typesafe-ai` skill is incorrectly committed
under bro's owned `skills/` tree.

## Design

Add mutating `bro skills add <source>`, `update <source>`, and
`remove <source>` commands.  They delegate fetching, hashing, lockfile
maintenance, and materialisation to the pinned `skills` CLI, using the
project `.agents/skills` vendor tree (never bro's `skills/` tree).  Add uses
the source directly; update and remove resolve a source to the skill names
recorded in `skills-lock.json`, so a repository source can cover multiple
skills.  A failed or unresolvable source is an explicit command failure.

## Verify

Unit tests inject the spawn runner and exercise argv plus source-to-lock
resolution.  A scratch project round-trip verifies add/update/remove invoke
the pinned CLI and leave no owned-tree materialisation.  Build, typecheck,
and the CLI command tests are run.
