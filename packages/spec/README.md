# @broject/spec

`@broject/spec` — the **bro plugin binding** for the spec engine:
Write Brose. Follow the Brotocol. It implements the core `SpecStore`
facade (`hasSpec`/`scaffold`/`remedy`/`policy`/`tree`/`scope`) over
[`@broject/brotocol`](../brotocol)'s spec protocol and
[`@broject/brose`](../brose)'s templates, so `bro spec` verbs and the
SDD hook probes keep consuming one facade and never name a tool.

The exported `specConnector` (name `brose`) registers ahead of the
built-in spec connectors: it claims projects whose `sdd.dir` carries
`*.spec.md` docs and defers to explicit tool layouts (`.specify/`,
`openspec/`) exactly like `native` does. Legacy `<id>.md`-only trees
keep resolving to `native` — migration is opt-in by adopting the
marker.

## Hybrid tree

During migration a spec dir mixes two formats, so the store merges
two views keyed by file path:

- **protocol docs** — `*.spec.md` + dir-doc indexes, ids from
  frontmatter `id:` (KEY-N specs) — authoritative on collision;
- **legacy index** — `<id>.md` flats, `<dir>/spec.md` dir specs,
  `parent:`/`scope:` frontmatter — fills every file the protocol glob
  does not see.

Child edges that named a dir-spec id later claimed by a frontmatter
`id:` are re-parented to the dir-doc now owning the directory, so the
merged `tree()` never reports a dangling parent.

## Example

```ts
import { specConnector } from '@broject/spec';
import { registerConnector } from '@broject/core';

registerConnector(specConnector); // before the native connector
```

`scaffold(id, { parent, title })` renders `brotocol/spec@1` through
brose `create` — a dir-doc parent nests the child positionally, a
flat parent writes the `parent:` frontmatter edge, and a legacy-only
parent gets the same edge written after creation.

## API

```ts
import { specConnector, hasSpecFile, specScope, indexSpecDir } from '@broject/spec';
```

The `legacy.ts` helpers (`repoRoot`, `validBeadId`, `specDirAbs`,
`findSpec`, `specFilePath`, `specScope`, …) are the shared spec-dir
index the `native` connector and the drift audit also consume.
