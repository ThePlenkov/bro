---

title: Packages
description: The @broject/* package map — what to install, what stays internal.
---

bro is a toolkit. The CLI (`@broject/bro`) is the current starting point,
not the only product surface: skills carry policy, portable agent plugins
carry bro into clients, and brouter routes tasks to configured agents through
user-authored Markdown formulas. Use `bro router` or install `@broject/brouter`
independently. bro stays the core; everything else is a connector.

The [marketplace](/marketplace) is generated from each public package's
`bro` metadata (`kind`, `status`, optional `facade`). It groups connectors
by facade and lists capabilities and core separately. Private packages
are excluded; each entry carries its catalog status and links to its source.

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

All packages are ESM-only and require Node ≥ 26.13. Versions release in
lockstep; each package page on npm carries its own README.
