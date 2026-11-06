---

parent: bro-olfvd
scope:
- packages/brouter/src/catalog.ts
- packages/brouter/src/clients.ts
- packages/brouter/src/clients/claude-code.ts
- packages/brouter/src/gateway.ts
- packages/brouter/src/cli.ts
- packages/brouter/src/index.ts
- packages/cli/src/commands/serve-client.ts
- packages/core/src/config.ts

---

# bro-6knxt — brouter M1: the client layer (claude-code pilot)

## Problem

The router serves its catalog; the client throws most of it away.

Measured against the live gateway: `GET /v1/models` answers **547**
rows (123 `devin-acp`, 424 `opencode-acp`), and Claude Code 2.1.309
keeps **89**. The filter is the client's, in its discovery path:

```js
ee.data.data.filter(le => /(claude|anthropic)/i.test(le.id));
```

An honest id — `devin-acp/swe-2-high` — is not an Anthropic id, so it
never reaches the picker. The client offers a second path that does NOT
filter: its own `modelPicker.options` settings block, whose rows are
curated rows taken verbatim. Proven in a live PTY session: a
claude-code pointed at the gateway with three curated rows showed them
verbatim, and `replaceBuiltInOptions: true` replaced the built-in
lineup with Default + the curated rows.

So the model list a user sees is decided by the client's regex, not by
the router. The router's answer — "here is what I serve" — never
arrives.

The fix is a client-side RENDERING of the router's catalog: the router's
served models, expressed in the client's own vocabulary, written into
the client's own settings. That rendering is client knowledge, and it
has no home in bro (spec bro-olfvd) — hence this package.

## Terms

- **served model** — one model the router offers: `{id, label?,
  description?, source?}`, `id` the honest `<entry>/<model>`.
- **client adapter** — the per-client seam: the id, the title, the
  settings file it reads, the settings key that carries the model block,
  how the block is rendered, how the settings merge, and the wiring the
  client needs to reach the router.
- **model block** — the adapter's rendering of the served models.
- **family** — the model family an id names (`fable` / `opus` /
  `sonnet` / `haiku` / `other`), read off the id's TEXT.

## Design

### The package

`packages/brouter` — `@broject/brouter`, a bin (`brouter`), ESM, no
dependency on bro's CLI, beads, or the bus. It reads the router's
catalog over HTTP (the router is a process; the catalog is its
answer), so the client half works against any router, not only bro's.

### The adapter seam

```ts
export interface ClientAdapter {
  readonly id: string;
  readonly title: string;
  /** the settings file the client reads (the default path) */
  readonly defaultSettingsPath: string;
  /** the settings key that carries the model block */
  readonly settingsKey: string;
  /** the block, in the client's vocabulary */
  renderModelBlock(models: ServedModel[]): Record<string, unknown>;
  /** the wiring (env) the client needs to reach the router */
  wire(router: RouterEndpoint): Record<string, unknown>;
}
```

The merge is generic and non-destructive: the block lands under
`settingsKey`; every other key of the settings file survives. A client
that needs more than one key overrides the merge — the seam allows it
without touching the shared helper.

`wire` returns ENV only. The router's token is a credential: it never
enters a settings file (the file is world-readable to the user's own
tools, and a settings file is the wrong place for a secret). The
credential rides the client's own credential mechanism.

### The claude-code pilot

`modelPicker`:

```jsonc
{
  "modelPicker": {
    "options": [
      {
        "model": "devin-acp/swe-2-high",
        "label": "devin-acp/SWE-2",
        "description": "devin-acp",
        "behavesAs": "claude-opus-5-5"
      }
    ],
    "replaceBuiltInOptions": true
  }
}
```

- `model` — the honest id, verbatim. The client sends it as-is.
- `label` / `description` — the catalog's own; the client falls back to
  the id when they are absent.
- `behavesAs` — the model whose CLIENT-SIDE handling this row borrows
  (prompt profile, capability, effort defaults, context window). A row
  without it is a model the client does not know: the client shows the
  warning "isn't recognized · context assumed to be 200k tokens". The
  mapping is by family, and it is the client's business — a client
  release retires the mapping, not the catalog.
- `replaceBuiltInOptions: true` — the picker shows Default + the
  served models; the built-in lineup (and the client's own filtered
  discovery) is hidden. Without it the served models are ADDED after
  the built-in lineup, and the filtered leftovers stay visible.

`wire` — `{"env": {"ANTHROPIC_BASE_URL": "<router url>"}}`.

### The catalog reader

The router's answer, read over HTTP: `GET <url>/v1/models` with the
session token as the API credential (`x-api-key` + `Authorization:
Bearer`) — the same credential the provider plane demands, reads
included.

The endpoint and the token come from the router's state file — the
repo's `<git-common-dir>/bro/serve.json` (`{pid, url, dir, token}`),
the same discovery rule the fleet uses. The path is one function, so
M4's move of the server moves the path with it.

A router that is not up is an honest error naming the state file — not
an empty catalog. A short catalog is distinguishable from a whole one:
the reader reports what it dropped.

### The CLI

```text
brouter models [--json]              the served catalog
brouter clients [--json]              the client adapters
brouter client <id> [--write] [--settings <path>] [--json]
```

`brouter client claude-code` prints the model block (JSON — the block
IS the config). `--write` merges it into the client's settings file
(default: the adapter's path), atomically (tmp + rename), preserving
every other key, and reports the path and the row count.

`bro serve client` delegates to the same code — bro's spelling of the
same surface.

## Plan

- [x] `packages/brouter` — package.json (bin `brouter`), tsconfig,
  tsdown, README
- [x] `src/catalog.ts` — the served model, the family, the payload
  parser
- [x] `src/clients.ts` — the adapter interface, the registry, the
  generic merge
- [x] `src/clients/claude-code.ts` — the pilot adapter
- [x] `src/gateway.ts` — the catalog reader (state file → URL + token →
  the rows)
- [x] `src/cli.ts` — the bin
- [x] `src/index.ts` — the exports
- [x] tests — the family, the payload parser, the adapter rendering,
  the merge, the reader (a stub HTTP server), the CLI
- [x] `bro serve client` — the bro-side delegation
- [x] `serve.client` config section — the settings path + the client
  command, per client
- [x] the skill — `skills/brouter/SKILL.md`

## Verify

- `npx tsx --test packages/brouter/src/*.test.ts` — the unit suite.
- `npx tsc --noEmit -p packages/brouter/tsconfig.json` — the types.
- `npx nx run @broject/brouter:build` — the build (bin + dts).
- Live: `brouter client claude-code --write` against the running
  gateway, then a claude-code session's `/model` picker shows the
  served models (the PTY harness reads the rendered screen).

## Non-negotiables

- **The id is the id.** No re-spelling, no protocol in the id, no
  invented names. A label is a label.
- **No credential in a settings file.** The token rides the client's
  credential mechanism; `wire` writes env only.
- **The merge never eats.** Writing the model block preserves every
  other key of the client's settings.
- **Absent = off.** A client adapter that is not registered changes
  nothing; `brouter client <unknown>` is an error naming the known ids.
- **No bro dependency.** The package must run without beads, without
  the bus, without a git repo.

## Risks named up front

- **The client's model knowledge moves.** `behavesAs` targets are
  pinned to a client version; a retired target makes the client warn
  again. The mapping is per-adapter, so the fix is local.
- **The block grows.** A router serving hundreds of models writes
  hundreds of rows into a settings file the client parses at startup.
  The block is regenerated, not accumulated — a rewrite replaces it.
