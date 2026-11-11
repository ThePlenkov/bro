---

title: Brotocol — filetree protocol
description: CRUD, search, graph and lint over a configured markdown filetree — plus the spec protocol specialization that powers bro spec.
---

`@broject/brotocol` is the **filetree protocol** layer. A _protocol_ is
a configuration describing how templated markdown documents are
organized in a tree — document glob, directory-index convention,
id/parent frontmatter fields. Brotocol provides the operations over
any protocol you configure; it is a generic engine, not a spec tool
that happens to read files.

```ts
import { specProtocol, tree, graph, lintSpec } from '@broject/brotocol';

const protocol = specProtocol({ dir: 'specs' });
tree(protocol); // ['specs  specs/README.md', '  sdd  …', …]
graph(protocol); // { nodes, edges, diagnostics }
lintSpec(protocol); // spec invariants: lifecycle, template:, KEY-N ids
```

## The document model

- **Flat doc** — a file matching the protocol's `docGlob`.
- **Dir-doc** — a directory holding its index file (the protocol's
  `index` name, or a `legacyIndex` alias). Other `.md` files inside it
  are _parts_ — content, never documents.
- **Parentage** — a `parent:` frontmatter value wins; positional
  dir-doc nesting is the fallback. Both become graph edges, with
  diagnostics for dangling parents and cycles.

## Operations

| Operation       | Returns                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `scan` / `list` | The discovered document set (flat docs + dir-docs, parts excluded)                                |
| `get`           | One document by id — frontmatter parsed, template bound                                           |
| `create`        | New document file via [brose](/docs/brose) `create` — path-safe inside the root, never overwrites |
| `update`        | Frontmatter rewrite — splice-preserving, body bytes untouched                                     |
| `remove`        | Delete a document — path-safe                                                                     |
| `search`        | Match docs by frontmatter fields and title                                                        |
| `graph`         | `{ nodes, edges, diagnostics }` — parent tree + anomalies                                         |
| `tree`          | Human-readable indented render of the graph                                                       |
| `lint`          | Protocol-level checks over the whole tree                                                         |

All operations take the `Protocol` and return structured results;
pure reads never mutate.

## The spec protocol

`specProtocol` is the specialization `bro spec` will implement over
[the facade](/docs/commands/spec). It configures:

| Convention | Value                                               |
| ---------- | --------------------------------------------------- |
| Doc glob   | `*.spec.md` — the spec marker                       |
| Dir index  | `<dirname>.spec.md`; legacy: `spec.md`, `README.md` |
| Id field   | `id` — `KEY-N` shape                                |
| Lifecycle  | `draft → active → deprecated → removed`             |
| Templates  | `brotocol/spec@1` shipped in `templates/`           |

`lintSpec` adds the spec invariants on top of generic `lint`: id
shape, lifecycle values, declared `template:`.

## Dependencies

`@broject/brose` + `node:*` — no bro core, no git, no beads. Those
arrive with the `@broject/spec` plugin that binds the protocol to the
`bro spec` facade and the task store.

## Try it

```sh
npx tsx examples/demo.ts
```

scans the bundled `examples/spec-tree/` fixture and prints the tree
plus resolved edges.
