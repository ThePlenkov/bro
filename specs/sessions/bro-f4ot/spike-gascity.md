# Spike verdict — is gascity automatable? (bro-4bkv)

Verdict: **GREEN — viable connector, not degenerate.** `gc` 1.4.2 exposes
a typed, scriptable surface for every contract member; the gap is a model
mismatch (configured agents + routed work, not ephemeral per-step
processes) that the connector absorbs, not the facade.

## Contract mapping

`AgentConnector` members vs `gc` surface (all probed on gc 1.4.2):

| Contract | gc surface | Notes |
| --- | --- | --- |
| `spawn(spec)` | `gc session new <template> --no-attach --json`, then `gc sling <session> <molStep>` | `session new` returns typed JSON: `{session_id, session_name, alias, work_dir, deferred_start}` (`--json-schema` on every command emits result/failure schemas — connector typing is free). Alternative: sling directly to a pooled agent, letting its `work_query`/`gc hook --claim` pick the bead up. |
| `list()` | `gc session list --json --state all`, `gc status --json` | `--state` filter: active/suspended/closed/all. Supervisor unreachable ⇒ `degraded` (probe via `gc supervisor status` before reporting `lost`). |
| `status(id)` | `gc session list --json` filtered by session id/alias | Session states map onto `AgentInfo.state`: active→running, suspended→stopped, closed→exited; registry `lost` still needs a liveness probe (`gc rig status`). |
| `stop(id)` | `gc session close` / `gc session kill` | Idempotent at the connector layer: not-found ⇒ no-op. `kill` force-kills the runtime (reconciler may restart — `close` is the terminal op). `gc runtime drain` is session-internal, not an external stop path. |
| `capabilities()` | `{attach: 'gc session attach', respawn: re-sling, supervisor: 'required'}` | Sessions start via the supervisor's reconciler (`session new --wait-timeout` waits for it), so supervision is required — but lifecycle is city-scoped, see below. |

## Shared-dolt claim contract — satisfiable

- `gc rig add <repo> --adopt` adopts a directory that already has a
  `.beads/` (metadata.json + config.yaml), runs a non-destructive
  idempotent config sync, never reinitializes — the rig's beads DB *is*
  the repo's store, so claims land where `bro fleet` reads them.
- `gc init --dolt-host/--dolt-port/--dolt-database/--dolt-project-id`
  pins a city to an external/hosted Dolt outright — a shared remote
  ledger is natively supported if we ever want it.
- Fallback for unrouted dispatch: `gc sling --force` dispatches even if
  the bead doesn't resolve in the local store — but the preferred path
  is adopt-then-sling so the claim is real, not bypassed.

## Externally-generated config/packs — supported

- `gc init --file city.toml --preserve-existing --no-start` accepts a
  fully pre-authored config — bro can write `city.toml` +
  `agents/<name>/prompt.template.md` itself (`gc agent add --prompt-template`
  scaffolds the same layout) and validate with `gc config show` /
  `gc config explain` (resolved config + provenance) and `gc lint`.
- Packs are git repos cached locally, pinnable to refs (`gc pack
  fetch/list`, `gc rig add --include <pack>`) — a bro-owned pack repo is
  a viable distribution channel later, but inline city.toml is enough
  for v1.

## Supervisor lifecycle — city-scoped on-demand

- The supervisor is a **machine-wide singleton** managing all registered
  cities via one API process (`gc supervisor start/stop/status/run`).
  `bro agents down` must therefore be `gc stop <city>` / `gc suspend` —
  never `gc supervisor stop`, which would kill other cities' agents.
- `gc start <city>` registers + ensures supervisor + reconciles;
  `gc stop` graceful-stops the city's sessions (`--force` skips grace).
  So `capabilities.supervisor: 'required'` and `bro agents up/down`
  map to `gc start`/`gc stop` — on-demand at city granularity.

## Caveats carried into bro-cduq

- **Ephemeral vs configured.** gc agents are templates in city.toml and
  sessions are persistent conversations; bro's `spawn(molStep)` is
  per-step. Connector absorbs this: one worker template per city,
  per-step identity = session alias + `bro/agents.json` registry entry.
- **Two ledgers risk.** A city has its own beads ledger *and* each rig
  has one. Connector must adopt the repo as the rig and route into the
  rig store — never let the city's own ledger become the claim plane.
- **No first-class "respawn".** Registry-entry reuse + re-sling covers
  it; `gc session reset` preserves the bead while restarting the session
  — worth probing during implementation.
- **Remote is free but deferred.** `--city-url`/`--context` and the
  supervisor HTTP API (`/v0/…`, `gc events --follow` SSE) mean a remote
  gascity backend is reachable — out of v1 scope per spec.md.

## Recommendation

Proceed with `bro-cduq` (gascity connector) after `bro-g4vn` lands the
facade. Connector plan: author `city.toml` + worker template → `gc init
--file --no-start` → `gc rig add <repo> --adopt` → spawn = `session new
--no-attach` + `sling` → fleet reads via `session list --json`.
