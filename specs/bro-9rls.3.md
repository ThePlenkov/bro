# bro-9rls.3 — REST surface over the plane catalog

Milestone 3 of `specs/bro-9rls.1.md`. `bro serve` hand-writes its read
routes; this milestone generates a catalog subtree from the same
descriptors the MCP server consumes, so REST and MCP can never
disagree about what a plane exposes.

## Routes

Generated under `/api/v1/planes` (`packages/cli/src/planes/rest.ts`):

- `GET /api/v1/planes` — the index: every registered descriptor with
  `name`, `reads`, `verbs`, and live `capabilities()`. A failed probe
  indexes as incapable — degraded, never an error.
- `GET /api/v1/planes/<plane>` — `list(filter)`; `status` and `limit`
  are the declared spine (`limit` numeric-coerced), every other query
  key passes through to plane-specific filters.
- `GET /api/v1/planes/<plane>/<name>` — when `<name>` is a declared
  read, `read(name, queryArgs)`; otherwise `get(<name>)`. Read names
  are enumerable in the descriptor, so precedence is unambiguous and a
  ref can never shadow the contract.
- `POST /api/v1/planes/<plane>/<verb>` — `exec(verb, args)` where the
  request body IS the args object (absent/empty → `{}`, non-object →
  400). The uniform write shape rides the existing writeGuard —
  `serve.json` bearer token, loopback `Origin`, JSON content-type —
  because POST is already a `WRITE_METHOD` in the pipeline.

## Error vocabulary

Mirrors the descriptor contract exactly:

- `PlaneVerbError` — 400 (client bug: undeclared verb, malformed body).
- `PlaneUnavailable` — 503 (backend can't serve it here — v1's
  declared-but-unwired verbs land here).
- Unknown plane — 404 naming the miss plus the catalog's names.
- `capabilities().read === false` on a GET — 404 naming the plane.
  Absent capability hides the surface; it never fakes an empty list.
- Absent `planeCatalog` dep — the whole subtree 404s like any unwired
  route.

## Compatibility

Every pre-existing route (`snapshot`, `queue`, `ticks`, `mailbox`,
`agents`, webhooks, `/v1/*`) keeps its bespoke shape — the catalog is
additive, not a rewrite. Aliases stay until a client migration exists.

## Tests

`packages/cli/src/planes/rest.test.ts` — index, filter translation,
read-vs-get precedence, get miss, read:false hiding, PlaneUnavailable
503, unknown plane 404, verb dispatch (wired/unwired/undeclared), body
shape, method 405s, absent catalog.

`packages/cli/src/commands/serve.test.ts` — `/api/v1/planes` dispatch:
dep presence, query threading into `list(filter)`, subtree 404.
