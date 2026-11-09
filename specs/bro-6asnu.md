# bro-6asnu — conductor: auto-route client classifier/fast calls to the direct upstream

## Problem

The serve conductor (spec bro-xeozo) answers every `POST /v1/messages`
through an ACP session — session-grade: `session/new` per call. A
client whose `ANTHROPIC_BASE_URL` lands on it routes its _internal_
calls there too — the auto-mode permission/safety classifier, the
`ANTHROPIC_SMALL_FAST_MODEL` lane, title/topic calls. Those calls
carry a seconds-scale deadline and fail-close on the session spin-up,
deadlocking interactive approvals (retro bro-p0baz). bro-ddksm cut the
hook tax, bro-9ww2q added the doctor warning, bro-xh5jg documented the
reroute — but the conductor itself still swallows the calls it cannot
serve in time. The server knows both lanes; it should route them.

## Design

A **fast lane** inside the conductor: a `/v1/messages` request whose
shape says "client-internal, stateless, deadline-bound" bypasses the
acp session and byte-forwards to the direct Messages upstream — the
same upstream pair the byte proxy would serve (`BRO_PROVIDER_UPSTREAM`
defaulting to api.anthropic.com, keyed by `BRO_PROVIDER_API_KEY` /
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the _server's_ env).
SSE streams through untouched — the wire contract stays the
upstream's, exactly as the plain byte proxy.

**Classification** — both signals must hold:

- `tools` absent or empty — claude-code main turns ALWAYS carry the
  tool catalog; internal calls never do. A tool-carrying request is a
  session turn whatever its cap.
- `max_tokens` ≤ `fastMaxTokens` (default 2048,
  `BRO_PROVIDER_FAST_MAX_TOKENS` overrides) — the field is REQUIRED by
  the Messages API so it is always present; internal calls cap ≤ ~1k,
  session turns ask 32k. A tool-less request asking session-scale
  output (compaction) stays on the session lane — the agent's own
  model should write what its own context re-reads.

Ambiguity always resolves to the session lane — a false fast-lane hit
would answer a real turn with the wrong model, a false session hit
only costs latency the client already budgets.

**Model handling** — the forwarded body is the client's own JSON.
`BRO_PROVIDER_FAST_MODEL` / `serve.fastModel` pins an upstream model
id and rewrites `body.model` before forwarding — the pin exists for
the inherited-lane case: a client with no dedicated classifier knob
sends `model: devin/swe-2-max` (the retro's exact wire), which no
upstream can serve; the rewrite makes the fast lane actually answer
instead of relaying the upstream's model-not-found. Unset → the
request's id forwards verbatim (correct when the client pins a real
upstream id like a haiku; foreign ids still fail fast and loud).

**Arming** — the lane arms on the upstream key pair alone (same
resolution as `providerConfig`) — zero new config for the common
conductor+key setup. Escape hatch `BRO_PROVIDER_FAST_LANE=off|0|false`
or `serve.fastLane: false` returns every call to the session lane.
When no upstream key exists a fast-shaped call still rides the session
lane — post-ddksm `session/new` is the cheap path the pool assumed,
and answering the classifier beats rejecting it; the miss only costs
the old latency.

**Telemetry** — `otelEvent('conductor.lane', { lane })` per
`/v1/messages`: `fast` when forwarded, `session` when conducted, plus
`unrouted: true` when a fast-shaped call lands on the session lane for
lack of an upstream key — the observability for "wire a fast
upstream". The event rides the existing `serve-turns.jsonl` journal
with `conductor.turn`.

**Doctor** — the bro-9ww2q `conductor` warn downgrades to ok when the
live server's env proves the lane armed (any of the three key envs in
the server's own `/proc/<pid>/environ`, or doctor's own env when it
shares the serve env): the classifier call hits the same endpoint but
pays the upstream round-trip, not `session/new`. Armed-but-
`FAST_LANE=off` keeps the warn.

## Plan

- [ ] `serve` config section gains `fastModel` + `fastLane`
- [ ] `ConductorConfig.fast` — lane resolution inside `conductorConfig`
- [ ] `messages()` lane dispatch + `conductor.lane` telemetry
- [ ] buffered forward in serve-provider (model rewrite needs the body
  re-serialized; `providerProxy` streams the raw req)
- [ ] serve.ts — compute the upstream pair regardless of conductor,
  log the armed lane
- [ ] doctor `conductor` check — server-env key evidence downgrades
  warn → ok
- [ ] tests + status.md provider-plane paragraph

## Verifies

- unit: classifier-shaped request (no tools, small cap) forwards to
  the upstream — body, headers, SSE relayed; the model pin rewrites
  `body.model`; `FAST_LANE=off` / `serve.fastLane:false` sends the
  same request to acp; an unrouted fast shape still conducts +
  `conductor.lane` carries `unrouted`.
- unit: a normal turn (tools present or large cap) conducts — acp
  session opened, lane event `session`.
- doctor: the acp-conductor warn reads ok once the server env carries
  an upstream key; `FAST_LANE=off` keeps the warn.
