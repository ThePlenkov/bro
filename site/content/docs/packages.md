---
title: Packages
description: The @broject/* package map — what to install, what stays internal.
---

# Packages

`@broject/bro` is the product. Everything else is the library surface it
is built from — published so connectors, agent drivers, and experiments
can build on the same primitives instead of forking them.

## Install this

| Package | What it is |
| ------- | ---------- |
| [`@broject/bro`](https://www.npmjs.com/package/@broject/bro) | The CLI. `npx @broject/bro --help` — this is all most people need. |

## Build on these

| Package | What it carries |
| ------- | --------------- |
| `@broject/core` | `gh`/`git`/`bd` wrappers, config + TOML parsing, the plugin contract, doc verbs, task store |
| `@broject/act` | PR review gate — threads, checks, reviewers, exit-gate evaluation, merge slot |
| `@broject/debt` | Review-debt pipeline — harvest merged-PR threads → ledger → beads |
| `@broject/drill` | Scoped descent frames — drill down/up with result + prevention memos |
| `@broject/convoy` | Molecule runner — beads DAG workflows scheduled inside the agent |
| `@broject/github` | GitHub connector — the `reviews` facade over the `gh` CLI |
| `@broject/gitlab` | GitLab connector — the `reviews` facade over the `glab` CLI |
| `@broject/learn` | Lesson store — schema and `bd kv` CRUD behind `bro learn` |
| `@broject/loop` | Autonomous backlog loop — claim beads, spawn agents, drive the gate |
| `@broject/bro-pack` | Default capability pack — skills and formulas installed by `bro setup --pack` |
| `@broject/stack` | Stacked bead→worktree→PR chains — branch-namespace parsing + sync planning |
| `@broject/retro` | Retrospect engine — TOML retro plans → prevention actions |

All packages are ESM-only and require Node ≥ 22. Versions release in
lockstep; each package page on npm carries its own README.
