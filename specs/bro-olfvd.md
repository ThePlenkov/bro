---

scope:
- packages/brouter/
- packages/core/src/brouter.ts
- packages/core/src/config.ts
- packages/cli/src/commands/serve-client.ts
- skills/brouter/

---

# bro-olfvd — brouter: the router as its own package

## Problem

bro is one thing: the agent-workflow rig — skills, hooks, scripts, the
PR-to-merge loop, the fleet, the beads ledger. The model router is a
different thing that grew up inside it: `bro serve` fronts ACP agents
behind Anthropic/OpenAI dialects, keeps a conversation on ONE acp
session, paces each lane against the provider's own wall, and serves a
catalog of models.

Three facts make "inside bro" the wrong home for the router:

- **The router is not the rig.** A router that fronts ACP agents is
  useful to anything that speaks Messages API — an editor, a script, a
  REPL, another agent. bro's value is its workflow; the router's value
  is its protocol. One package that is both drags the workflow half's
  dependencies (beads, the bus, the fleet ledger) into every consumer
  that only wants to talk to a model.
- **The name is already taken.** `brouter` is the repo's model-centric
  routing registry (spec bro-n1p0s): `brouter.models.<id>` names the
  provider that serves a model id. The package takes the name the
  config section already uses — one word, one meaning.
- **The client half has no home at all.** A thin client needs its model
  list rendered in ITS vocabulary: Claude Code's `modelPicker`, Codex's
  `config.toml`, a future client's own shape. That rendering is CLIENT
  knowledge — the client's model catalog, the client's settings schema —
  and none of it belongs to the workflow rig.

The forcing symptom is small and sharp: the gateway serves 547 models
and Claude Code shows 89 — because the client filters its own discovery
by `/(claude|anthropic)/i`. The honest ids (`devin-acp/swe-2-high`)
never reach the picker. The fix is not a filter bypass but a client
rendering the router's catalog in the client's own words — and that
rendering needs a home that is not bro.

## Terms

- **router** — the process that serves models: the dialects, the lanes,
  the admission gate, the catalog.
- **lane** — one provider entry the router fronts (`devin-acp`,
  `opencode-acp`); the routing target of a request.
- **served model** — one model the router offers, by its honest id
  `<entry>/<model>`.
- **client** — a thin consumer of the router (Claude Code, Codex): it
  holds the model list in its own vocabulary and talks Messages API.
- **client adapter** — the per-client seam: where the client reads its
  settings, which key carries the model block, how the block is
  rendered from the served models, how the settings merge, and the
  wiring (env) the client needs to reach the router.
- **model block** — the adapter's rendering of the served models: the
  one thing a client needs to know the router's catalog.

## The boundary

brouter owns:

- the served catalog — which models the router offers and which lane
  serves each;
- the client adapters — the model block per client, the settings merge,
  the wiring;
- the protocol clients — an acpx-like ACP client (a session you can
  drive), and `ask` (send a message to an ACP agent, print the answer);
- eventually the gateway itself.

bro keeps:

- the agent workflow — skills, hooks, the fleet, the beads ledger, the
  review loop;
- the beads/bus/fleet primitives brouter borrows (core stays shared).

The dependency direction is one-way: **bro depends on brouter, never
the reverse.** brouter must stay usable without beads, without the bus,
without a git repo. Anything brouter needs from bro lives in
`@broject/core` (published, shared) or moves into brouter.

## Surfaces

| Command                         | What it does                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `brouter models`                | the served catalog — every model the router offers, by honest id                      |
| `brouter clients`               | the client adapters — each client's settings path, model block key, wiring            |
| `brouter client <id> [--write]` | render the model's block for a client; `--write` merges it into the client's settings |
| `brouter serve`                 | the router itself (M4 — `bro serve` delegates to it)                                  |
| `brouter ask`                   | send a message to an ACP agent through the acp client, print the answer (M5)          |
| `bro router …`                  | the bro-side wrapper — the same surfaces, bro's spelling                              |

## The config

`brouter.models` — already in bro.config.json (spec bro-n1p0s) — is the
operator's model list: which models the router serves, and which lane
serves each. Two readings, one section:

- **as a registry** (today): "who serves model X" — the resolver's
  input, consulted when a request names a model.
- **as a whitelist** (M2): "which models exist" — the served catalog is
  exactly the declared routes, not the union of every lane's
  advertisement. The operator's list is the router's list.

The declaration stays the operator's own vocabulary — a route is
`{provider, model}`, opaque, vendor-blind.

## Milestones

Each milestone is its own bead with its own spec — SDD gates the code.

1. **M1 — the client layer.** The abstract `ClientAdapter`, the
   claude-code pilot, the `brouter` CLI (`models` / `clients` /
   `client <id> --write`), the catalog reader. `bro serve client`
   delegates to it. (bro-6knxt)
2. **M2 — the served catalog.** `brouter.models` as the whitelist: the
   gateway serves the declared routes, not the union.
3. **M3 — the interactive setter.** Choosing the models is a dialogue,
   not a config edit — a picker over the live catalog that writes the
   declaration.
4. **M4 — the gateway moves.** The conductor's router half becomes
   `brouter serve`; `bro serve` delegates. Incremental: the plane
   surfaces stay where they are until the move is proven.
5. **M5 — the protocol clients.** The acpx-like ACP client (a session
   you can drive) and `ask` (the shortcut to a message).
6. **M6 — the TUI/REPL.** A terminal surface over the router — the
   acp-viewer's UI is the reference.

## Non-negotiables

- **Honest ids, always.** `<entry>/<model>` — no protocol, no
  re-spelling, no invented names. A client may present the model under
  its own label; the id stays the id.
- **Vendor-blind.** A client adapter knows ONE client's vocabulary. No
  client's model knowledge leaks into the shared catalog module, and no
  provider's semantics leak into the client layer.
- **Absent = off.** No declaration, no behavior change. A declared route
  to an unconfigured provider is a config error, never a skipped entry.
- **The client's filter is the client's business.** The router serves
  the truth; how a client presents it is the adapter's. The router never
  renames a model to survive a client's regex.
- **One writer per tree.** brouter's own state files live in the git
  common dir, and a cleanup never removes a live session's directory.
- **Incremental, never big-bang.** The conductor is ~180KB of
  broker-coupled code; it moves in its own milestone, not inside a
  refactor wave.

## Risks named up front

- **Two homes for one config.** `brouter.models` in bro.config.json and
  a brouter-owned config file would drift. One section, one file: the
  repo's config layers, read by both CLIs.
- **A package that needs the repo.** brouter must stay runnable outside
  a git checkout (a router in a container has no beads). Anything that
  assumes `.git` belongs to bro, not brouter.
- **The client's model catalog moves.** `behavesAs` maps a served model
  onto a model the client version knows; a client release retires the
  mapping. The mapping is the adapter's business and is version-pinned.
- **Two routers, two truths.** While the gateway lives in bro and the
  catalog reader in brouter, the served catalog has two producers. M2
  makes the declaration the single producer; M4 moves the producer.
