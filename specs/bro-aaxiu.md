# bro-aaxiu — the key travels with the request, not through the process env

Child of bro-t3jiq (specs/bro-t3jiq.md) — stack layer 2.
Base: `stack/router/1-code-health` (PR #923).

## Problem

`packages/brouter/src/decision-model.ts:37` — `proxiedEntry` assigns the
router's token to `process.env.BRO_ROUTER_TOKEN` and names that var in the
api entry's `apiKeyEnv`. The api kind reads its key from the environment at
call time, so two concurrent decisions in one process — two repos, two
router endpoints — can read each other's token: one request may hit the
other's router, and it answers 401 instead of the judgment the decision
asked for.

The shape is wrong, and the router's own token has no business in the
global env.

## The seam

The key must travel with the request instead of through a process-global.
The api kind grows a **runtime-only key field**: the entry carries the key
it will use, the binding reads it from the entry, and the process env is
never written.

**The config never holds a key value.** The config side stays as it is: an
entry names a key SOURCE — `apiKeyEnv` (a variable) or `apiKeyCommand` (a
secret-store command). The runtime field is not a config field: the loader
never picks it, the JSON schema refuses it, and a config that carries one
is refused loudly rather than silently ignored (a committed key is a leak
the operator must hear about).

The order of the key sources at call time:

1. the runtime key (the entry carries it — the router's own token);
2. `apiKeyCommand` (the secret-store lookup);
3. `apiKeyEnv` (the configured variable).

The runtime key wins because it is the most specific: it was handed to this
call, for this request, on purpose.

## Design

### `packages/core/src/providers.ts`

The api kind of `ProviderEntry` grows the field, and the field says what it
is:

```ts
/** The key for THIS call — a RUNTIME field: the config never holds a
 *  key value (it names a source — an env var or a secret-store command).
 *  The key travels with the entry, so two calls in one process cannot
 *  read each other's key. */
apiKey?: string;
```

The parse refuses a config that carries one:

```text
bro.config: providers.<name> carries apiKey — the config cannot hold a key
(use apiKeyEnv or apiKeyCommand) — entry dropped
```

A refused entry is louder than a dropped field: an operator who put a key
in the committed file must learn that the file is wrong before the first
401, not after it.

### `packages/providers/src/systemone.ts` and `openai.ts`

The bindings read the runtime key first — `ApiTarget` carries it, and both
`apiKey()` (the systemone wire) and `authHeaders()` (the openai-compat
wire) take it before the env. The messages stay as they are: they name the
config FIELD, never the value.

### `packages/brouter/src/decision-model.ts`

The proxied entry carries the token:

```ts
function proxiedEntry(model: string, url: string, token: string): ProviderEntry {
  return {
    type: 'api',
    baseUrl: url,
    models: { [model]: 'openai-compat' },
    model,
    apiKey: token,
  };
}
```

`ROUTER_TOKEN_ENV` and the `process.env` write are gone. Two decisions in
one process now hold two keys, each in its own entry.

## Verify

1. The behaviour: the proxied decision still authenticates — the openai wire
   sends `Bearer <token>` ✓ (a test carries the token through the binding
   and reads the header).
2. The regression: two entries, two tokens, one process — each call reads its
   own key, and `process.env` is never written ✓.
3. The config: an entry carrying `apiKey` is refused with a message that
   names the field ✓; the JSON schema refuses it too ✓.
4. The repo's CI: `npm run build`, `npm run typecheck`, `npm test`, the
   `check:*` family.
5. `bro review act status <PR>` — the gate is the verdict.

## Not in this layer

- **The acp kind's key.** The acp binding passes its key to a SPAWNED
  process — a different seam, a different layer.
- **The router's own credential store.** Where the router's token comes from
  (the state file) is unchanged; this layer only changes how it travels.
- **The `fleet` router's lanes.** The fleet's own router reads its keys
  from the config's sources, exactly as before.
