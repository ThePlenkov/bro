# Gas City ownership (BRO ↔ Gas City)

This is the integration runbook for the Gas City backend. Gas City is a
**complement**, not Gas Town, and there is no second scheduler — BRO remains
the orchestrator/facade; Gas City provides session/runtime/supervisor mechanics.

## Single owner per lifecycle

| Phase | Owner | Notes |
| --- | --- | --- |
| **Claims / assignment** | **BRO** | Claims live in the shared beads store (`.beads/` dolt). Repo adopted as a rig so the rig's beads DB is the repo store. `gc sling --force` is never used. BRO enforces dedup (live session on step refuses second spawn; foreign claim refuses spawn). |
| **Spawn / bootstrap** | **BRO orchestrates; gc executes** | BRO decides when/if to spawn (policy/dedup/serialization). BRO bootstraps city/rig, writes per-step agent config (`agents/<molStep>/`, `work_dir = repoRoot`). Gas City owns provider command via `city.toml` and execution inside sessions. If a provider-resolved worker would ride gc, spawn is refused (gc owns provider). |
| **Retry / respawn** | **BRO** | BRO decides respawn based on registry+state. Reuse agentId on same molStep; if session alive use `gc session reset`, else create new. Claim rebinding happens as needed via shared store. |
| **Reconciliation / liveness** | **BRO + gc (cooperative)** | gc reports via `gc session list --json`; supervisor via `gc supervisor status --json`. BRO maps: closed→exited, active→running, suspended→stopped. Missing session → `lost` only if supervisor verifiably running; if supervisor unreachable → degraded (omit/unknown), never guess. |
| **Shutdown / stop** | **BRO requests; gc terminates** | BRO calls `gc session close` (terminal). Idempotent; close fails but session gone → clean stop; close fails and session lives → error (do not mark stopped). **Never** `gc supervisor stop` (machine-wide). City stop only via `gc stop <city>`. |
| **Gate / admission** | **BRO enforces** | Spawn serialized/deduped across registry+claim planes. Indeterminate liveness → spawn fails with `SpawnError` and MUST NOT re-claim/rebind/start. Policy checks (mutable config, provider rules) enforced by BRO. |

## Lifecycle diagram (with recovery)

```mermaid
sequenceDiagram
  participant BRO
  participant GC as Gas City (gc)
  participant Store as Shared Beads Store

  BRO->>GC: ensure city/rig (init if needed, rig add --adopt, gc start)
  BRO->>GC: write per-step agent (agents/<molStep>/, work_dir, env pins)
  BRO->>Store: claim/check ownership (dedup)
  alt session alive
    BRO->>GC: gc session reset <id>
  else
    BRO->>GC: gc session new <agent> --alias <molStep> --no-attach
    GC-->>BRO: session_id (or error; on parse error -> close orphan)
  end
  BRO->>GC: gc sling <molStep> <molStep> (no --force)
  BRO->>GC: gc session submit <prompt>
  GC->>Store: work routed via rig (shared store)
  loop reconcile
    BRO->>GC: gc session list --json; gc supervisor status --json
    GC-->>BRO: sessions/supervisor state
    BRO->>BRO: map states; lost only if supervisor running+missing else degraded
  end
  alt stop requested
    BRO->>GC: gc session close <target>
    alt session gone
      GC-->>BRO: ok/absent
      BRO->>BRO: mark stopped/clean
    else close fails but lives
      GC-->>BRO: error
      BRO->>BRO: do NOT mark stopped (error)
    end
  end
```

**Recovery cases:**
- **Crash mid-spawn:** partial registry entry; reconciliation treats missing as lost only if supervisor running.
- **Orphan session:** `session new` returns unparseable JSON → BRO closes by alias.
- **Sling failure:** session closed, entry gets `spawnError`, respawn-able per policy.
- **Supervisor down:** degraded read (no false `lost`); spawn blocked on indeterminate liveness.
- **Foreign claim:** no owned registry entry + claimed elsewhere → spawn refused.

## Conformance evidence

- **Stub (fake-gc):** `packages/cli/src/agent-connectors-gascity.test.ts` covers duplicate spawn, foreign claim, respawn/reset, list mapping, lost vs degraded, stop idempotency, config/env.
- **Real-gc (versioned):** opt-in conformance via `BRO_REAL_GC=1` against a real `gc` binary; tests record `gc --version` and run a minimal versioned suite. Evidence captured as test output/artifacts for the pinned version.
