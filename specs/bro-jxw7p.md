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

- The part after the slash is the AGENT'S OWN model id, verbatim.
  `providerBare` (`packages/providers/src/acp.ts:99`) strips exactly one
  leading segment, and the remainder must match a catalog leaf of that lane's
  agent (`resolveModelPin`), else `AcpConfigError`. Opencode's leaves are
  themselves namespaced (`opencode/glm-5.3-flash-free`,
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
   route is the first declared route for its entry, else the entry key. The
   `/v1/models` rows carry the primary route; other routes stay routable but
   unadvertised. The catalog never lists one lane's models twice.
7. **The journal names the route, the pool names the entry.** `conductor.*`
   rows carry the ROUTE the request came in on — that is the public identity
   an operator reads. The pool's label stays the entry key, so the seam
   resolves one agent per entry.

### The id contract (unchanged)

| requested model | lane | reaches the agent as |
| --- | --- | --- |
| `opencode-acp/opencode/glm-5.3-flash-free` | the `opencode-acp` route | `opencode/glm-5.3-flash-free` |
| `devin-acp/swe-2-high` | the default lane | `swe-2-high` |
| `devin/swe-2-max` | the default lane (its own key, or its alias) | `swe-2-max` |
| `swe-2-high` (bare) | the default lane | `swe-2-high` |
| `unknown-route/x` | the default lane | `x` — the lane's own verdict |

Only the FIRST segment is bro-side routing. The rest is the agent's own id,
compared verbatim against that lane's catalog.

### The reserved shape: native lanes

This is the VISION the naming convention anticipates — not built now. It
constrains the design above only in that a lane must be transport-agnostic.

Today a serve is one of two mutually exclusive modes (`packages/cli/src/commands/serve.ts:2516-2522`):

- `serve.backend` names an **acp** entry → the conductor answers `/v1/*`;
- otherwise → the **byte proxy** answers `/v1/*`, forwarding to
  `BRO_PROVIDER_UPSTREAM` with the client's session token swapped for the
  real credential. That proxy is Anthropic-Messages-shaped and byte
  transparent; it is env-driven, single-upstream, and does no model routing.

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

The design lands in pieces, each its own PR; the alias mechanism first.

- [ ] `packages/core/src/config.ts` — `serveSection` accepts
      `string[] | Record<string, string>`; `providerNames` yields the route
      → entry pairs; the emitted schema follows.
- [ ] `packages/cli/src/commands/serve-conductor.ts` — `ConductorConfig`
      carries routes (name → entry) beside the backend; `conductorConfig`
      builds the route table, rejecting a duplicate route, a slash in a
      route, and a non-acp entry; the default lane answers to its own key
      plus any declared route for it.
- [ ] `packages/cli/src/commands/serve-conductor.ts` — the lane's pool,
      seam label and session map move to the ENTRY; routes share them. The
      journal's `backend` field becomes the route.
- [ ] `packages/cli/src/commands/serve-conductor.ts` — the `/v1/models`
      catalog advertises each lane under its primary route only.
- [ ] `packages/cli/src/commands/serve.ts` — the startup line lists the
      routes, not the entry keys.
- [ ] `specs/bro-jxw7p.md` — the native-lane vision stays reserved here
      until a PR proposes its transport.

## Verify

- `serve-conductor.test.ts` — the array form behaves exactly as before (a
  route IS the entry key); the map form routes `opencode-acp/…` to the
  `opencode-iceman` entry; the entry key of an exposed lane is NOT routable;
  the default lane answers to its own key AND to a declared alias; two
  entries under one route is a loud error; a route with a slash is a loud
  error; a map value naming a non-acp entry is a loud error.
- Two routes for ONE entry share the ACP pool and the session map — the same
  conversation key under both routes is ONE conversation, and the agent is
  spawned once.
- The catalog lists a lane's models under its primary route only — no
  duplicate rows when a lane has two routes.
- The journal's `backend` field carries the route the request came in on.
- Live, one listener: `GET /v1/models` answers the union of the lanes'
  catalogs under their routes; a real `claude -p --model opencode-acp/…` and
  a real `claude -p --model devin-acp/…` both answer, and the journal records
  the two ROUTES with their own backends.
