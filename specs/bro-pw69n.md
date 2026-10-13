# bro-pw69n — devin as an ACP provider + dogfood e2e proof

`providers.devin-acp` makes devin a session-grade worker: `{type:
"acp", command: "devin acp"}` rides the spec bro-5hx1.1 spawn surface —
`bro acp-worker` drives `devin acp` over stdio, `autoApprove` answers
its `session/request_permission` calls, `sessionRm` reaps the session
from the operator's history on exit. This is the claude-through-devin
lane: the acp session's model is devin's (claude-backed), no separate
subscription required.

Any host that resolves `providers.devin-acp` — claude, devin, a fleet
spawn — gets the same worker shape.

## `bro self dogfood run --provider <name>`

Pins the worker engine for the run. The pin is recorded on
`state.provider` and passed to BOTH `spawnStepAgent` calls:

- the runner spawn in `cmdRun` (`provider` on the spec)
- the analyst spawn in `advanceRun` (`provider: fresh.provider` — the
  lock-held re-read carries it, so a lazy advance honors the pin too)

A provider is not a backend: `--backend` still picks the transport
connector (native/tmux/docker), the provider supplies the argv worker
inside it (`bro acp-worker --command "devin acp" <promptFile>`).

## `bro providers models` — the provider/model catalog

Every host's model picker needs one answer: which models exist, named
as `<provider>/<model-id>`. `bro providers models [name…]` renders the
union across the registry — `api` entries enumerate their `models`
allowlist, `acp` entries enumerate `session/new` model `configOptions`
live over the protocol (devin acp's picker list == bro's list), `cli`
entries run a configured `models` template (`"models": "opencode
models"`) plus their pinned `model` deduped.

Claude reaches the same surface natively: `commands/models.md` ships
`/bro:models` — no host-specific wiring, the command shells out to
`bro providers models`.

## e2e evidence

A live `bro self dogfood run core-workflow --provider devin-acp` must
show: registry row carrying `provider: devin-acp`, the runner's
`bro acp-worker` argv in the spawn record, the run closing `[done]`
with a verdict under `<git-common>/bro/dogfood/<run-id>/`.

## Non-goals

- Per-agent provider override (`--analyst-provider`) — one pin covers
  both steps until a real need appears.
- acp worker capabilities beyond `autoApprove`/`sessionRm` — the entry
  schema already covers them.
