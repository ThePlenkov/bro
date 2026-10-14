# bro-wxfls — conductor: model provenance + catalog under tool-less backends

Follow-up to bro-xeozo. A tool-less acp backend (`devin acp
--agent-type summarizer` shape) advertises no `configOptions` at
session/new — there is no `category: "model"` option to read or set.
Today that makes the conductor useless with a pin:

- `applyModel` throws `no model config option` on ANY configured pin —
  every `/v1/messages` 500s. Unpinned calls answer `model: "unknown"`.
- `GET /v1/models` is empty — the agent's own catalog is the only
  source, and it has none.

## Provenance under a tool-less backend

A fixed-model agent's identity is asserted at configuration time — the
pin (`BRO_PROVIDER_MODEL` → `entry.model`) IS the provenance; there is
nothing to apply and nothing to verify against. The converse surfaces
(`acpPooledTurn`, `acpConverse`) therefore:

- model option advertised → unchanged: `resolveModelPin` +
  `set_config_option`, served id is what the agent reports.
- no model option → the pin label is served as `model` verbatim;
  unpinned stays `'unknown'` (honest — bro cannot know what ran). The
  client's request-model is never trusted: it cannot be honored, so it
  is never reported — the response `model` field says what ran.
- the judge path (`acpOp`) is UNCHANGED — an unhonorable pin still
  throws; a family swap the agent can't refuse is exactly the
  laundering the pin guard exists to stop.

## `BRO_PROVIDER_CATALOG=<name>`

Optional second `providers.<name>` entry whose catalog — the SAME
`providerModels` surface `bro providers models` renders — answers
`GET /v1/models` instead of the backend's. Any provider kind works
(api allowlist, cli `models` template, acp session options): the
catalog names what clients may pick; the backend stays the only thing
that runs. Unset → the backend's own catalog (status quo). Unknown
name = loud startup error naming what IS configured.

`/v1/models` rows emit `<entry>/<model-id>` ids — the uniform catalog
vocabulary, so a copied id re-pins on `/v1/messages` (`resolveModelPin`
strips the prefix and resolves against the backend's own options when
they exist; tool-less backends degrade the pin to a display label and
report their configured label, never the request id).

## v1 deferrals

- Catalog reads are not pooled — `/v1/models` is a control-plane call,
  a fresh `acpModels` spawn per request is acceptable (the warm pool is
  the messages path, bro-xeozo).
- A catalog id that the backend cannot honor does not reroute — one
  conductor conducts one backend.
