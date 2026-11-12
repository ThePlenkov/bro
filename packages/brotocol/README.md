# @broject/brotocol

Brotocol — the **filetree protocol**. A *protocol* describes how
templated markdown docs are organized in a configured filetree (doc
glob, dir-doc index convention, id/parent frontmatter fields); brotocol
provides the operations over it — `scan`/`get`/`create`/`update`/
`remove`/`search`/`graph`/`tree`/`lint`. The **spec protocol**
(`*.spec.md` docs, `<dirname>.spec.md` dir-docs with `spec.md`/
`README.md` legacy indexes, KEY-N ids, the `draft|active|deprecated|
removed` lifecycle) is a specialization shipped as `specProtocol` plus
the `spec@N`/`brotocol/spec@N` templates in `templates/`.

```ts
import { specProtocol, tree, graph, lintSpec } from '@broject/brotocol';

const protocol = specProtocol({ dir: 'specs' });
tree(protocol);   // ['specs  specs/README.md', '  sdd  specs/sdd/spec.md', …]
graph(protocol);  // { nodes, edges, diagnostics }
lintSpec(protocol); // spec invariants: lifecycle, template:, KEY-N ids
```

Docs: a file matching `docGlob` is a flat doc; a directory holding its
`<dirname>.spec.md` index (or a legacy alias) is a dir-doc — other `.md`
files inside it are *parts*, never docs. Parentage: a `parent:`
frontmatter value first, positional dir-doc nesting second.

## Example

```sh
npx tsx examples/demo.ts
```

scans `examples/spec-tree/` and prints the tree plus resolved edges.

## API

```ts
import { scan, get, create, update, remove, search, graph, tree, lint, specProtocol, lintSpec } from '@broject/brotocol';
```

All operations take the `Protocol` and return structured results; pure
reads never mutate. `update` is splice-preserving — only the frontmatter
block is rewritten.
