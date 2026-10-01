# project — bro spec-of-specs

The root spec: what bro is, and where each capability lives in the
filetree. Children are capability specs; bead-level leaf specs hang
under the capability they serve (`parent:` frontmatter). A spec is a
stable project artifact — it survives the bead that produced it.

## Problem

Beads are intent-to-change and die when done; nothing stable answered
"what is bro made of, and where does each part live". This file is that
answer — the index every capability spec links back to.

## Capability map

| Capability spec | What it owns |
| --------------- | ------------ |
| `specs/review-gate.md` | PR review loop + debt pipeline (`bro act`, `bro debt`) |
| `specs/sdd.md` | spec policy + `specs` facade (`bro spec`, sdd hooks) |
| `specs/sessions.md` | lifecycle hooks, worktrees, drill, loop (`bro work`, `bro drill`, `bro loop`, `bro hooks`) |
| `specs/plans.md` | versioned plan schemas (`bro run`, `bro plan`) |
| `specs/distro.md` | npm publish, packs, adapters, releases (`bro setup`, nx release) |
| `specs/backends.md` | connector/facade seam: task stores, review hosts, sync data-refs |
| `specs/retro.md` | `bro wtf` — failure capture → retro notes → debt |

## Filetree (capability → code)

```text
packages/
  act/        exit gate, PR state, thread mutations        → review-gate
  debt/       collectors, ledger, formula molecules        → review-gate
  core/       connectors/facades, tasks, git, docs         → backends
    src/specs.ts              SpecStore facade contract    → sdd
    src/plan.ts               plan version check + routing → plans
  github/     gh review connector                          → backends
  gitlab/     glab review connector                        → backends
  cli/        bro: plugin registry + command dispatch      → all
    src/commands/spec.ts, spec-connectors.ts               → sdd
    src/commands/{hooks,work,drill,loop,next}.ts           → sessions
  pack/       @broject/bro-pack — client skill packs       → distro
  loop/, convoy/, retro/, drill/                           → sessions/retro
site/         broject.dev                                  → distro
hooks.json, hooks/run.sh                                   → sessions
skills/                                                    → distro (packs)
```

## Invariants

- Every in_progress bead has a spec (file or `spec:` link) — `sdd.mode:
  gate` enforces it in this repo itself.
- Spec filenames name their bead (`<id>.md`); capability specs name
  the capability. `bro spec tree` renders this file as the root.
