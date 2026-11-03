# bro-bvipw.5 — serve: one gateway, many providers (per-model routing)

## Problem

`bro serve` answers `/v1/*` from ONE acp provider — the one `serve.backend`
names (or `BRO_PROVIDER_BACKEND` pins). The operator's machine hosts several
working providers — `devin-acp`, `opencode-iceman` — and every one of them
has models a client may ask for. Serving them meant running a second
listener on a second port, and the repo allows exactly one listener per
repo: the second serve is refused with *one host per repo*. So the
operator's choice was "one provider on the gateway", not "the gateway
serves every provider".

The wire already carries the routing key. `/v1/models` advertises ids as
`<entry>/<model>` (`devin-acp/swe-2-high`), and the conductor hands the
requested id to the provider — `providerBare` strips the first segment
before comparing it against the agent's own catalog leaves. The prefix was
already a routing key; nothing read it.

## Design

### Config

`serve.providers` names the OTHER acp entries the gateway exposes:

```json
{
  "serve": { "backend": "devin-acp", "providers": ["opencode-iceman"] },
  "providers": {
    "devin-acp": { "type": "acp", "command": "devin acp --model swe-2-high" },
    "opencode-iceman": { "type": "acp", "command": "opencode acp" }
  }
}
```

The list holds provider NAMES, not entries — the entry itself stays in
`providers`. An exposed name that no registry knows, or that names a
non-acp entry, is a loud startup error naming what IS configured, exactly
like the default backend's own resolution. The default backend is never
re-exposed as its own route.

### Lanes

Every served provider is a LANE: its entry, its model pin, its own acp
pool, and its own conversations.

- The default lane is `serve.backend`. An exposed lane serves ITS entry's
  own model — `BRO_PROVIDER_MODEL` belongs to the default backend, not to
  every provider sharing the listener.
- A lane's pool is warm: one acp child per provider per listener. A dead
  transport drops that lane's conversations, never another lane's.
- Conversations are PER LANE. The conversation key hashes the prefix and
  the first turn — not the provider — so the same key under two providers
  is two conversations, one per provider's own context. A turn never
  leaks across providers.

### Routing

The requested model's FIRST path segment names the lane:

| requested model | lane |
| --- | --- |
| `opencode-iceman/opencode-go/gpt-5` | the `opencode-iceman` lane |
| `devin-acp/swe-2-high` | the `devin-acp` lane |
| `swe-2-high` (bare) | the default lane |
| `unknown-provider/x` | the default lane |

A bare id, or a prefix naming no lane, rides the default: a model the
default's catalog cannot serve is that lane's own verdict, not a routing
error. The prefix names the LANE; the rest of the id is the provider's
own model id, and `providerBare` strips the prefix before the provider
sees it.

A `/v1/responses` request carrying `previous_response_id` rides its
PREDECESSOR's lane — that chain already lives in one provider's context.
The chain ledger records the lane alongside the key and the consumed
count, and pruning looks the session up in that lane.

### The catalog

`GET /v1/models` returns the UNION of every lane's catalog, each row
carrying its own lane's prefix — the ids the router reads. A lane whose
catalog cannot be read is SKIPPED, not fatal: one provider being down
must not blind the other's models. Every lane down is a 502.

### The seam

`AcpSeam.peer` may name the in-process agent outright or resolve it per
spawn label. The conductor resolves the seam ONCE PER LANE, so each lane
gets its own agent and the label it resolves against is the lane's own
(`conductor:<lane>`), never a guess made at request time.

## Verify

- `serve-conductor.test.ts` gains a *one gateway, many providers* suite:
  `/v1/models` lists every lane's models; a model prefix routes the turn
  to THAT provider; a bare model and an unknown prefix ride the default;
  the same conversation under two providers is TWO sessions; one lane
  down still serves the other — the dead lane fails on its own verdict
  (529, unavailable) while the healthy lane answers.
- `conductorConfig` gains: `serve.providers` exposes the other acp
  entries; the backend is never re-exposed; an exposed non-acp entry is a
  loud error.
- Live, one listener on the operator's port: `GET /v1/models` answers 542
  rows (122 `devin-acp/*`, 420 `opencode-iceman/*`); a real
  `claude -p --model devin/swe-2-max` and a real
  `claude -p --model opencode-iceman/opencode-go/iceman-contributor-free`
  both answer `pong`, and the serve journal records
  `conductor.turn backend devin-acp` and
  `conductor.turn backend opencode-iceman` respectively.
