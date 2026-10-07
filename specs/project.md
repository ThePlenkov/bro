# project — bro spec-of-specs

The root spec: what bro is, and where each capability lives in the
filetree. Children are capability specs; bead-level leaf specs nest inside
their capability dir — position is the edge, `parent:` frontmatter
overrides it. A spec is a
stable project artifact — it survives the bead that produced it.

## Problem

Beads are intent-to-change and die when done; nothing stable answered
"what is bro made of, and where does each part live". This file is that
answer — the index every capability spec links back to.

## Capability map

| Capability spec | What it owns |
| --------------- | ------------ |
| `specs/review-gate/` | PR review loop + debt pipeline (`bro act`, `bro debt`) |
| `specs/sdd/` | spec policy + `specs` facade (`bro spec`, sdd hooks) |
| `specs/sessions/` | lifecycle hooks, worktrees, drill, loop, agent orchestration (`bro work`, `bro drill`, `bro loop`, `bro hooks`, `bro agents`, `bro fleet`, `bro serve`) |
| `specs/plans/` | versioned plan schemas (`bro run`, `bro plan`) |
| `specs/distro/` | npm publish, packs, adapters, releases (`bro setup`, nx release) |
| `specs/backends/` | connector/facade seam: task stores, review hosts, sync data-refs |
| `specs/retro/` | `bro wtf` — failure capture → retro notes → debt |
| `specs/judgments/` | typed calibrated decisions: judge facade, provider registry, shadow→advisory→enforce trust ladder (`bro judge`) |
| `specs/mesh/` | inter-rig wire contract: envelope, lifecycle, transports (`bro mesh`) |
| `specs/cross-repo/` | bro-side request protocol phases: LOCAL `bro request`, WAIT watcher, REMOTE transports |

## Filetree (capability → code)

Spec layout mirrors the tree: this file is the root; each capability is
a dir spec (`<cap>/spec.md` index) holding its bead specs as children.

```text
packages/
  act/        exit gate, PR state, thread mutations        → review-gate
  debt/       collectors, ledger, formula molecules        → review-gate
  core/       connectors/facades, tasks, git, docs         → backends
    src/specs.ts              SpecStore facade contract    → sdd
    src/plan.ts               plan version check + routing → plans
    src/agents.ts             AgentConnector contract      → sessions
  github/     gh review connector                          → backends
  gitlab/     glab review connector                        → backends
  judge/      judge facade: chain, journal, shadow, replay → judgments
  providers/  provider wire clients (systemone/acp/openai/cli) → judgments
  core/src/{judge,providers}.ts                            → judgments
  mesh/       envelope, peers, thread, local delivery      → mesh + cross-repo
  cli/        bro: plugin registry + command dispatch      → all
    src/commands/spec.ts, spec-connectors.ts               → sdd
    src/commands/{hooks,work,drill,loop,next}.ts           → sessions
    src/commands/{agents,fleet,serve}.ts, agent-connectors.ts → sessions
  pack/       @broject/bro-pack — client skill packs       → distro
  loop/, convoy/, retro/, drill/                           → sessions/retro
site/         broject.dev                                  → distro
hooks.json, hooks/run.sh                                   → sessions
skills/                                                    → distro (packs)
```

## Invariants

- Every non-exempt in_progress bead claimed by this session has a spec
  (file or `spec:` link) — `sdd.mode: gate` blocks missing own claims.
- Spec filenames name their bead (`<id>.md`); capability specs name
  the capability. `bro spec tree` renders this file as the root.
