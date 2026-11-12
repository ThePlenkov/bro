# bro-izpyk.3 — fleet F3: ClaimFacade, arming/occupancy migration, orchestrate exclusivity

Governing spec: `specs/sessions/bro-izpyk.md` (branch `devin/1792972271-fleet-spec`),
section "Claims and conflicts" + the `orchestrate` mode row. Builds on F1
(`specs/bro-izpyk.1.*`, ledger) and F2 (`specs/bro-izpyk.2.md`, modes).

## Scope

Claims are **leases on resource URIs** — `worktree:<path>`, `branch:<name>`,
`task:<id>`, `pr:<n>`, `path:<glob>`, `role:<name>@<project>` — held by a
`(host, sid)` session in the machine-wide ledger. This slice lands:

1. **The first `ClaimFacade` provider** — `claimsFacade()` in core over the
   same `ledger.db` sqlite the F1 store owns (`claims` table, prepared in
   F1a). Wired through `FacadeMap.claims` on the built-in ledger connector.
2. **Lease semantics** — TTL + holder pid liveness + heartbeat renewal on
   hook-event ingest; release on session end, provable holder death, or
   TTL-expired-and-dead.
3. **`task:*` delegation** — resolves the session's project dir (ledger
   session row `cwd`, else caller `dir`), reads the bead through
   `facade('tasks')`/`taskStore`, and lets the bd claim stay the source of
   truth: `claim` performs `store.claim(id)` only when the bead is
   unassigned, reports the standing assignee as `conflict` otherwise;
   `release` clears the assignee only when it is ours. `list` does not
   enumerate `task:*` — bead enumeration stays on the tasks facade.
4. **`bro claim` CLI** — `claim|release|list` for the calling session
   (env/`--session`/`--host` resolution, same contract as `bro mode`),
   with resource shorthings (`worktree`, `branch`, `pr <n>`, `path <g>`,
   `role <name>`, `task <id>`).
5. **`role:orchestrator@<project>` exclusivity** — `bro mode orchestrate`
   (CLI path and the post-tool hook bind) acquires the exclusive role
   claim or refuses with the standing holder; leaving orchestrate (any
   other mode set, `off`, `clear`) releases it. Spawned workers
   (`BRO_AGENT_ID`) can never take the role — the same veto
   `isOrchestratorSession` encodes.
6. **Conflict policy by mode** — claim conflicts are *reported*, never
   thrown: `claim()` returns `{ok:false, conflict}`. Observe-mode callers
   surface notes; the orchestrator-role path refuses explicitly (the spec's
   "refused or queued" for the exclusive role). Pre-tool guard blocking
   stays opt-in and is not wired in F3 — no project config key exists yet;
   documented as follow-up.
7. **Consumer migration** — the hook-driven supervisor rearm paths
   (watch/rig/drive/loop pulse connectors and the daemon rearm decisions,
   all of which already run inside hook events with `ctx.sessionId`) gate
   on `orchestratorRoleAllows`: `BRO_AGENT_ID` unset AND the role claim is
   unclaimed or held by this session. A held-by-other role quiets the
   rearm — that is the exclusivity the spec asks for. CLI install guards
   (`bro watch --every`, `drive/loop install`, `resume`, `rig`, `pulse`,
   dogfood) keep the synchronous `BRO_AGENT_ID` veto: they are explicit
   operator invocations, a sessionless operator terminal has no
   `SessionKey` to hold a claim against, and the hook rearm paths — the
   automatic ones — now carry the real check. Documented, not silently
   skipped.
8. **Arming/occupancy migration (partial, honest)** — `armSession`'s
   post-tool path dual-writes ledger claims beside the marker files:
   `work` arms → `worktree:<cwd>` (detail = armed detail), `task` arms →
   `task:<bead>` (already the bd claim's job — the facade call is
   idempotent verification). Markers remain the gate-time truth in F3
   (per-session aspect arms are a different concern than resource
   leases); `agents.json` occupancy stays for spawned-agent liveness.
   Claim TTLs (default 24h) plus hook-event heartbeat renewal give the
   claims plane the same "live while the session works" semantics the
   marker mtime window gives today. Full marker→claim read migration is
   F4/F5 scope — noted in Deviations.

## Semantics

- `claim(resource, session, {ttlMs, exclusive, pid, pidStart, detail, dir})`
  - `task:*` → tasks delegation (above); never writes a claims row.
  - `role:*` defaults `exclusive: true`; everything else defaults shared.
  - `ttlMs` default `CLAIM_DEFAULT_TTL_MS` (24h); `0`/negative → no expiry.
  - Same-session re-claim renews (`lease_until`, `pid`, `detail`,
    `exclusive` update; `claimed_at` keeps the first stamp).
  - Conflict rule: the new claim fails iff a *different* live session
    holds the resource AND (`new.exclusive` OR `existing.exclusive`).
    Shared+shared coexist.
- Liveness (`claimLive`): a row is dead when its session row is `ended`
  or derived-`interrupted` (last event before boot — the same rule
  `bro sessions` uses); when it carries a holder pid, `pidAlive(pid,
  pidStart)` is the verdict (provable death releases early — stricter
  than the spec's "TTL expires and pid is dead", documented); pid-less
  rows additionally die when `lease_until` passed and the session has
  been silent past the freshness window.
- Heartbeat: `ingestSessionRow` renews every `ttl_ms`-bearing claim of
  the firing `(host, sid)` — any hook event is the heartbeat, exactly
  the spec's rule. The claims table gains `pid`, `pid_start`, `ttl_ms`,
  `detail` columns via `ALTER TABLE` migration for pre-F3 databases.
- `release(resource, session)` deletes the `(resource, host, sid)` row;
  `task:*` delegates (clears assignee only when it is ours and the bead
  is not closed).
- `list(q)` sweeps dead rows then returns live ones filtered by
  `project` / `session` / `resource` prefix. `task:*` enumeration is not
  performed — documented on the facade.

## Files

- `packages/core/src/claims.ts` — contract extension (optional row/opts
  fields, `orchestratorRoleUri`, TTL constant).
- `packages/core/src/claims-store.ts` — NEW: `claimsFacade()` provider.
- `packages/core/src/ledger-store.ts` — claims columns migration,
  `ClaimsStoreOps` on `LedgerStore`, heartbeat renewal in ingest.
- `packages/core/src/connectors.ts` — `claims` provider on the ledger
  connector (memoized singleton like `ledgerSingleton`).
- `packages/core/src/index.ts` — exports.
- `packages/cli/src/commands/claim.ts` — NEW `bro claim`.
- `packages/cli/src/commands/orchestrator-role.ts` — NEW shared
  session→role-claim gate for hook paths.
- `packages/cli/src/commands/mode.ts` — orchestrate acquire/release.
- `packages/cli/src/commands/hooks.ts` — bindModeCommand claim path +
  armPostTool claim dual-write.
- `packages/cli/src/commands/{watch-pulse,rig-pulse,drive-pulse,loop-pulse,daemon}.ts`
  — role gate on rearm decisions.
- `packages/cli/src/plugins.ts` + contract schema — `claim` plugin.
- `specs/bro-izpyk.3.md` — this file.
- Tests: `claims-store.test.ts` (core), `claim.test.ts`, `mode`/
  orchestrator + hooks arming tests (cli).

## Verification

- `npm run build`, `npm run typecheck`, `npm test`.
- Live smoke: `bro claim worktree` → `bro claim list` → second-session
  `role:orchestrator@<project>` refusal → `bro mode orchestrate` acquire
  → `bro sessions`/`bro claim list` shows the row → release round trip.
- `task:*` smoke against the repo's own beads store.
