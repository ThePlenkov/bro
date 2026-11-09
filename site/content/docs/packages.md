---

title: Packages
description: The @broject/* package map — what to install, what stays internal.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

bro is a toolkit. The CLI (`@broject/bro`) is the current starting point,
not the only product surface: skills carry policy, portable agent plugins
carry bro into clients, and brouter has its own source-built standalone CLI
(not yet published on npm). bro stays
the core; external systems connect through facades.

The [marketplace](/marketplace) is generated from each public package's
`bro` metadata (`kind`, `status`, optional `facade`). It groups connectors
by facade and lists capabilities and core separately. Private packages
are excluded; unpackaged plans are explicitly labeled planned. These are
source-tree capabilities, not a claim that every command is on npm latest.
`@broject/core` still contains gh/git/bd wrappers: a separate Beads
connector package is a plan, not today's package boundary.

See [the toolkit hub](/) for the four product surfaces. The table below
is a quick guide, not the complete catalog.

## Install this

| Package                                                      | What it is                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`@broject/bro`](https://www.npmjs.com/package/@broject/bro) | The CLI. `npx @broject/bro --help` — this is all most people need. |

## Build on these

| Package             | What it carries                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `@broject/core`     | `gh`/`git`/`bd` wrappers, config + TOML parsing, the plugin contract, doc verbs, task store |
| `@broject/act`      | PR review gate — threads, checks, reviewers, exit-gate evaluation, merge slot               |
| `@broject/debt`     | Review-debt pipeline — harvest merged-PR threads → ledger → beads                           |
| `@broject/drill`    | Scoped descent frames — drill down/up with result + prevention memos                        |
| `@broject/convoy`   | Molecule runner — beads DAG workflows scheduled inside the agent                            |
| `@broject/github`   | GitHub connector — the `reviews` facade over the `gh` CLI                                   |
| `@broject/gitlab`   | GitLab connector — the `reviews` facade over the `glab` CLI                                 |
| `@broject/linear`   | Linear connector — the `tasks` facade over Linear GraphQL API                               |
| `@broject/jira`     | Jira connector — the `tasks` facade over the `atlassian` CLI (Cloud/Data Center)            |
| `@broject/learn`    | Lesson store — schema and `bd kv` CRUD behind `bro self learn`                              |
| `@broject/loop`     | Autonomous backlog loop — claim beads, spawn agents, drive the gate                         |
| `@broject/bro-pack` | Default capability pack — skills and formulas installed by `bro setup --pack`               |
| `@broject/stack`    | Stacked bead→worktree→PR chains — branch-namespace parsing + sync planning                  |
| `@broject/retro`    | Retrospect engine — TOML retro plans → prevention actions                                   |

All packages are ESM-only and require Node ≥ 22.18. Versions release in
lockstep; each package page on npm carries its own README.
