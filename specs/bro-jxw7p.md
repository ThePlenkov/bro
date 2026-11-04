# bro-jxw7p — serve: route names, aliases, and the shape of the final gateway

## Problem

The gateway's route prefix — the first path segment of a model id, the part a
client asks for — IS the `providers` entry key. `serve.providers` is a
`string[]` of entry names, and each name becomes, unchanged:

- the lane's identity (`lanes.set(name, …)`),
- the model-id prefix the router matches (`routeOf` → `wire.routes.get(head)`),
- the ACP pool's and the seam's spawn label (`conductor:<name>`),
- the `backend` field of every `conductor.*` journal row,
- the prefix of every `/v1/models` row.

So the public name of a provider is welded to the private name of its config
entry. An operator who wants the public name `opencode-acp` must name the
entry `opencode-acp` — and cannot keep `opencode-iceman` (the iceman account
among several opencode accounts) as the entry's own name. The two names want
to be different things: the entry name identifies a CONFIGURATION, the route
name identifies a DESTINATION a client may ask for.

The operator's convention is `<route>/<model>`, with the route naming the
transport class — `devin-acp`, `opencode-acp` — so an ACP lane reads
differently from a native (non-acp) one. That convention only works if the
route is a CHOSEN public name. Derived from the entry key it drifts
immediately: `kilo-cli` is an **acp** entry (`kilo acp`), `dirac` and
`omp-minimax` are acp entries with no suffix at all, and `opencode-free` is a
cli entry that a suffix would have to disambiguate from `opencode-iceman`.

Two facts about the id shape are already settled and must not change:

- The part after the slash is the AGENT'S OWN model id. `providerBare`
  (`packages/providers/src/acp.ts:99`) strips exactly one leading segment —
  the one the router matched — and the remainder is resolved against THAT
  lane's agent catalog (exact leaf, unique family prefix, composite
  `<base>-<level>`, or the spawn-level pin the session reports). Opencode's
  leaves are themselves namespaced (`opencode/glm-5.3-flash-free`,
  `opencode-go/gpt-5.6-luna`, `vercel/…`), so the remainder can contain
  slashes.
- The router's fallback is the DEFAULT lane: a bare id, or a prefix naming no
  lane, rides it.

What is missing is the seam between an entry and its public name.

## Design

### Vocabulary

| term | meaning | scope |
| --- | --- | --- |
| **entry** | a `providers.<key>` config entry | private: the configuration |
| **route** | the public name a client asks for | public: the model id's first segment |
| **lane** | the runtime carrier of an entry | private: the ACP pool, sessions, model pin |

Today all three are the same string. The design separates them: an **entry**
may answer to several **routes**, and a **lane** is per entry — never per
route.

### Config

`serve.providers` accepts two spellings. The array form is today's and keeps
working; the map form declares a public name per entry.

```json
{
  "serve": {
    "backend": "devin-acp",
    "providers": { "opencode-acp": "opencode-iceman" }
  },
  "providers": {
    "devin-acp": { "type": "acp", "command": "devin acp --model swe-2-high" },
    "opencode-iceman": { "type": "acp", "command": "opencode acp" }
  }
}
```

- array `["opencode-iceman"]` → route `opencode-iceman` → entry
  `opencode-iceman`. Identical to today.
- map `{"opencode-acp": "opencode-iceman"}` → route `opencode-acp` → entry
  `opencode-iceman`. The entry keeps its own name; the client sees
  `opencode-acp`.

The schema (`serveSection` in `packages/core/src/config.ts`) widens to
`string[] | Record<string, string>`; the emitted
`packages/cli/schemas/bro.config.schema.json` follows.

### The rules

1. **Routes are what the operator declares.** The map form's keys are the
   routes; an entry's own key is NOT implicitly routable (otherwise the map
   form would not control the public name). The DEFAULT lane is the one
   exception: it always answers to its `serve.backend` key as well, so
   `devin-acp/…` keeps working while `devin/…` is added beside it.
2. **A route names one entry.** Two entries under one route is a loud config
   error — the router would have no honest answer.
3. **A route carries no slash.** `requireLaneName` already says so: the
   router reads the FIRST path segment, so a route with a slash would be
   advertised and unreachable. The rule applies to the map's keys too.
4. **An exposed route must resolve to an acp entry.** `requireAcpEntry`
   already says so, loudly, naming the type. The map form inherits it.
5. **One lane per entry, one ACP child per entry.** The pool
   (`acpLinkPool('conductor:<name>')`), the seam's spawn label
   (`conductor:<name>`) and the session map are per ENTRY. Two routes for one
   entry share them: the second route must not spawn a second agent, and both
   routes must see the SAME conversation — one provider, one context.
6. **The primary route is what the catalog advertises.** A lane's primary
   route is the first DECLARED route for its entry. The `/v1/models` rows
   carry the primary route; other routes stay routable but unadvertised. The
   catalog never lists one lane's models twice. In the ARRAY form the
   declaration IS the entry key (route ≡ entry), so the primary route is
   that key; in the MAP form the entry key is never a fallback — an entry
   with no declared route has no primary route and no advertised rows. The
   DEFAULT lane is the one entry whose key is routable without a
   declaration, so its `serve.backend` key IS its primary route when no
   route is declared for it: `devin-acp/…` keeps being advertised exactly as
   it is today, and a declared alias takes over the advertisement.

   The ONE exception is the `BRO_PROVIDER_CATALOG` pin: it names the entry
   whose catalog answers `/v1/models`, and the rows carry THAT entry's name
   — the uniform catalog vocabulary of bro-wxfls ("rows emit
   `<entry>/<model-id>` ids"). The override picks the SOURCE, not the
   route: its ids keep their source entry's prefix, and a copied id is
   routed by that prefix like any other — it follows whichever route the
   prefix names, or the default lane when it names none.
7. **The journal names the route that ANSWERED, the pool names the entry.**
   `conductor.*` rows carry the route the request was served under — that is
   the public identity an operator reads. For a CHAINED `/v1/responses`
   request that is the PREDECESSOR's route, not the incoming model's prefix:
   a chain already lives in one provider's context, so the answer belongs to
   the lane that holds it. The pool's label stays the entry key, so the seam
   resolves one agent per entry.
8. **A route that names no lane rides the DEFAULT lane.** A bare id, or a
   prefix no lane answers to, is the default lane's verdict — that lane's own
   catalog, or its own error. This is today's behaviour and it stays: the
   gateway must not 400 a client for a model it simply does not route. The
   rule is explicit here so no implementor reads the fallback as a config
   error.

### The id contract (unchanged)

| requested model | lane | resolves against that lane's catalog as |
| --- | --- | --- |
| `opencode-acp/opencode/glm-5.3-flash-free` | the `opencode-acp` route | `opencode/glm-5.3-flash-free` |
| `devin-acp/swe-2-high` | the default lane | `swe-2-high` |
| `devin/swe-2-max` | the default lane (its own key, or its alias) | `swe-2-max` |
| `swe-2-high` (bare) | the default lane | `swe-2-high` |
| `unknown-route/x` | the default lane | `x` — the lane's own verdict |
| a chained `/v1/responses` id | the PREDECESSOR's lane | the predecessor's route, whatever the id asks for |

Only the FIRST segment is bro-side routing: `providerBare`
(`packages/providers/src/acp.ts:99`) strips exactly one leading segment, and
that segment is what the router matched. The remainder is the agent's own id
and is resolved by the agent's catalog, NOT compared verbatim:

1. **exact leaf** — a catalog leaf whose value equals the remainder, or whose
   display name matches it case-insensitively (`resolveModelPin`);
2. **family shorthand** — exactly one leaf whose value starts with
   `<remainder>-`; more than one is an ambiguity error naming the offers;
3. **composite level** — `<base>-<level>`, where `<level>` names a
   `thought_level` leaf (devin's `swe-2-max` is model `swe-2-high` at level
   `max`, never its own catalog id);
4. **spawn-level pin** — the provider command's own `--model`, which the
   session reports back verbatim.

A `[<size>]` suffix is a client-side context opt-in. The RAW id is tried
against the catalog first — an agent may advertise `model[1m]` as its own
option value — and the base id, suffix stripped, is tried only on a miss.
Anything the catalog does not admit is a loud `AcpConfigError`
naming the catalog — never a silent fallback to another model.

### The reserved shape: native lanes

This is the VISION the naming convention anticipates — not built now. It
constrains the design above only in that a lane must be transport-agnostic.

Today a serve is one of two mutually exclusive modes (`packages/cli/src/commands/serve.ts:2516-2522`):

- `serve.backend` names an **acp** entry → the conductor answers `/v1/*`;
- NO `serve.backend` is configured → the **byte proxy** answers `/v1/*`,
  forwarding to `BRO_PROVIDER_UPSTREAM` with the client's session token
  swapped for the real credential. That proxy is Anthropic-Messages-shaped
  and byte transparent; it is env-driven, single-upstream, and does no model
  routing.

A CONFIGURED `serve.backend` naming a non-acp entry is a loud startup error
(`requireAcpEntry`), not a fall-through to the proxy: the operator named a
backend, and naming one that cannot converse must not silently become a
different transport. The proxy is the fallback for a serve with NO backend —
not a third option for a misconfigured one.

So a native (non-acp) provider cannot sit beside an acp one in one listener
today, and `serve.providers` accepts acp entries only. The end state:

- a lane carries a TRANSPORT (conductor vs byte proxy) and a model space;
- the route picks the lane, exactly as it does for acp lanes;
- a native lane's model id after the prefix goes to ITS upstream verbatim —
  the upstream is Anthropic-shaped, so the id is that upstream's model name;
- the `-acp` suffix becomes load-bearing: `devin-acp/…` is a conductor lane,
  `orcarouter/…` is a native one.

The alias mechanism above is transport-agnostic by construction (a route maps
to a lane; only the lane's internals differ), so this extension needs no
change to the routing table, the catalog, or the id contract. It needs a
second transport inside the lane, and a `providers` entry shape that can
carry an upstream plus its credential.

**Rejected for now:** a native lane that speaks a non-Anthropic wire
(chat-completions, systemone). The conductor already speaks three dialects
inbound; adding an outbound OpenAI-shaped transport is a second project, and
the byte proxy's virtue is that it owns no protocol at all.

## Plan

The alias mechanism lands as ONE PR: the pieces are interdependent — a
route table without per-entry lanes would answer a route with a second
agent, and a per-entry lane without the primary-route rule would
advertise the same models twice. The native-lane vision stays reserved
here until a PR proposes its transport.

- [x] `packages/core/src/config.ts` — `serveSection` accepts
      `string[] | Record<string, string>`; `providerRoutes` yields the
      route → entry pairs (and drops a malformed one with a diagnostic);
      the emitted schema follows.
- [x] `packages/cli/src/commands/serve-conductor.ts` — `ConductorConfig`
      carries `routes` (a `RouteBinding` list) beside the backend;
      `conductorConfig` builds the route table, rejecting a duplicate
      route, a slash in a route, and a non-acp entry; the default lane
      answers to its own key plus any declared route for it.
- [x] `packages/cli/src/commands/serve-conductor.ts` — the lane's pool,
      seam label and session map move to the ENTRY; routes share them. The
      journal's `backend` field becomes the route that ANSWERED — the
      predecessor's route for a chained `/v1/responses` request.
- [x] `packages/cli/src/commands/serve-conductor.ts` — the `/v1/models`
      catalog advertises each lane under its primary route only.
- [x] `packages/cli/src/commands/serve.ts` — the startup line lists the
      routes, not the entry keys.
- [x] `specs/bro-jxw7p.md` — the native-lane vision stays reserved here
      until a PR proposes its transport.

### What the implementation added

Three things the design above left open, decided while building it:

- **The route table is a LIST, not a map.** The primary route is "the
  first DECLARED route for an entry", so the declaration ORDER matters —
  a `Record` cannot promise an order across numeric-looking keys. The
  binding carries a `declared` flag: the default lane's own key is
  routable but never DECLARED, so a declared alias takes over the
  advertisement and the implicit key never does. An operator who
  declares the default's own key explicitly (`{"devin-acp": "devin-acp"}`)
  names that same entry, so the advertisement does not change — the
  flag only marks "the operator wrote this one".
- **A route name cannot be a numeric index.** `{"1": …, "0": …}` would
  lose its declared order — JavaScript's own iteration puts integer
  indexes first — so "the first declared route" would name a different
  lane than the operator wrote. Such a route is a loud error (and the
  loader drops it with a diagnostic).
- **A config with no routes means the ARRAY form.** `routeBindings()`
  falls back to "every exposed entry under its own name, the default
  lane under its own key" — a config built before the route table
  existed behaves exactly as it did.
- **The chain remembers the ROUTE, not just the lane.** A chained
  `/v1/responses` request is journaled under the route the predecessor
  answered under, so the journal reads as the operator wrote it — the
  predecessor's route, whatever the incoming model's prefix asks for.

## Verify

- `serve-conductor.test.ts` (config) — the array form behaves exactly as
  before (a route IS the entry key); the map form routes `opencode-acp/…`
  to the `opencode-iceman` entry; the entry key of an exposed lane is NOT
  routable; the default lane answers to its own key AND to a declared
  alias; two entries under one route is a loud error; a route with a slash
  is a loud error; a map value naming a non-acp entry is a loud error; an
  entry with no declared route is not exposed at all.
- `serve-conductor.test.ts` (runtime) — a declared route reaches its entry
  while the entry key rides the default lane; two routes over ONE entry
  share the agent and the conversation (ONE `session/new`); the catalog
  lists a lane's models under its primary route only; the journal's
  `backend` carries the route that answered — the predecessor's for a
  chained `/v1/responses` request.
- `config.test.ts` — `serve.providers` accepts the list and the map; a
  non-string route value is dropped with a diagnostic; a value that is
  neither drops the section; a numeric-index route, a whitespace-only
  route, a route that duplicates another after trimming, and the
  `__proto__` route are all handled without losing a lane.
- A route naming no lane still rides the default lane (no 400 for a model
  the gateway simply does not route).
- Live, one listener: `GET /v1/models` answers the union of the lanes'
  catalogs under their routes; a real `claude -p --model opencode-acp/…` and
  a real `claude -p --model devin-acp/…` both answer, and the journal records
  the two ROUTES with their own backends.
