---
parent: bro-l8c4f
scope:
  - packages/core/src/config-schema.ts
  - packages/core/src/config.ts
  - packages/core/src/agents.ts
  - packages/cli/src/agent-connectors.ts
  - packages/cli/src/agent-connectors.test.ts
  - packages/cli/src/commands/doctor.ts
  - packages/core/src/providers.ts
---

# bro-l8c4f.6 — explicit credential scope for fleet workers

Parent: `bro-l8c4f` (principal audit — security). Audit evidence at rev 674e3be8.

## Problem

Fleet workers currently inherit broad ambient environment by default:

- Native copies `process.env` + `spec.env` (minus identity/git pins), so unrelated credentials leak to workers.
- Docker writes an env-file from ambient + `spec.env` (minus some host vars) containing almost the entire ambient environment including secrets.
- ACP default-deny is protocol permissions only, not OS sandbox.

The audit requires an explicit credential scope separate from workspace isolation. Trusted-host mode must remain compatible, but its trust boundary must be surfaced. Diagnostics/telemetry must never print secret values.

## Design

### Config shape

Add opt-in strict per-provider/backend env allowlist + explicit secret references. Configuration lives under `agents.<backend>` and/or provider-scoped settings. Keep backward compatible trusted-host mode (current behavior) when strict mode not enabled.

Schema additions:

- `agents.<backend>.envAllowlist` (array of env var names) — allowlist of env vars permitted to pass through
- `agents.<backend>.strictEnv` (boolean, default false) — enables strict mode
- `agents.<backend>.credentialScope` (object) for explicit secret references if needed
- Provider entries may declare allowed env names or credential references

### Policy

- **Opt-in strict mode**: when `strictEnv` is true (or credential scope configured strictly), only explicitly allowed env vars pass through. Unrelated credentials (sentinels) are dropped.
- **Trusted-host mode (default)**: existing behavior preserved for compatibility. Must be surfaced in doctor/config docs with explicit trust boundary.
- **An allowlist alone is inert**: `envAllowlist` without `strictEnv: true` (or `credentialScope`) does not enable filtering — the backend stays trusted-host, and doctor reports it as an explicit warn (inert), never as an enabled scope.
- **The batch marker rides `spec.env` only**: an ambient `BRO_BATCH` is stripped from every worker env (native/tmux/docker env-file) — a marker reaching a worker's own spawns would class them batch and charge the fleet budget (bro-9h86l). Docker `runArgs` env-passing flags (`--env`, `--env-file`, `-e`) are rejected under strict scope the same way.
- **Identity pins must never be overridden**: `agentEnvPins` (BEADS_DIR, BRO_BEAD_ID, BRO_AGENT_ID, BRO_PROMPT_FILE, BRO_SESSION_ID, BRO_AGENT, BRO_MOL_ID, BRO_AGENT_PROVIDER, BRO_AGENT_MODEL, BRO_AGENT_CLASS, BRO_DELEGATED_BY) are always set last and cannot be overridden by `spec.env` or ambient env. This is already enforced; must remain so.
- **Native and Docker identical policy**: both backends enforce the same allowlist/credential scope rules.
- **Diagnostics/telemetry never print secret values**: only log key names, not values.
- **ACP**: protocol permissions remain separate from OS sandbox (no change to permission model).

### Implementation

- Unify env filtering for native and Docker: build allowed env set from allowlist + required provider credentials + identity pins handling
- Block unrelated sentinel credentials in strict mode
- Ensure `spec.env` cannot redirect identity/store pins
- Update docker env-file writing to respect allowlist in strict mode
- Update native spawn env construction to respect allowlist in strict mode
- Surface trust boundary in doctor
- Add regression tests

## Acceptance

- Sentinel credential not belonging to chosen provider absent in strict mode
- Allowed provider credential passed in strict mode
- `agentEnvPins` not overridden by `spec.env`
- Native and Docker have identical policy
- Diagnostics/telemetry only show key names

## Plan

- [ ] Create SDD spec (this file)
- [ ] Define config shape in schema/types
- [ ] Implement unified env filtering in agent-connectors
- [ ] Update native and Docker paths
- [ ] Update doctor to surface trust boundary
- [ ] Add regression tests
- [ ] Verify with `npm run build && npm run typecheck && npm test`
