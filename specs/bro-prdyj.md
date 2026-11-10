# bro-prdyj — the new `@broject/rig` package needs its `bro` metadata

## Problem

`site/catalog.ts` builds the package catalog from every
`packages/*/package.json` and validates each package's `bro` metadata:

```ts
const pkg = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
if (pkg.private) continue;
entries.push({ ...validateBroMetadata(pkg.bro), ... });
```

`packages/rig` landed in PR #618 (`refactor(rig): extract the lifecycle
engine into @broject/rig`, spec bro-jamp7) **without** that block. It is
a public package (no `private: true`), so the catalog reads it and the
metadata is `undefined`:

```text
Error: packages/rig/package.json: [
  {
    "expected": "object",
    "code": "invalid_type",
    "path": [],
    "message": "Invalid input: expected object, received undefined"
  }
]
```

`npm run check:docs` is a step of the `build-test` CI job, and it runs
**before** the build — so the gate dies on every branch that merges
today's `main`, `main` included. The whole repo is red: no PR can go
green, and the failure looks like a catalog bug rather than a missing
field.

## Design

The metadata is what the catalog and the site render: the package's
**kind** and its **status**.

`@broject/rig` is the lifecycle engine — the verdict ladder, the
ready-set read, the item→worktree resolution — a leaf package that the
planes and the ACP consume without spawning the CLI. It is not a
connector (it serves no facade of its own) and not a user-facing
capability (the capabilities are the verbs: loop, stack, drill, mesh).
It is **core**, the same kind as `@broject/core` and `@broject/command`,
and it is **beta**, like every other package in the repo.

```json
"bro": {
  "kind": "core",
  "status": "beta"
}
```

One field, in the shape every sibling package already uses.

## Plan

- [x] `packages/rig/package.json` — the `bro` block: `kind: core`,
      `status: beta`.
- [x] `npm run check:docs` — the catalog holds again (27 public
      packages, 5 planned entries) and the AGENTS.md claim check and
      the doc contract pass.
- [x] the CI gate that was red repo-wide (`build-test` → "Check AGENTS.md
      config claims") is green again.
