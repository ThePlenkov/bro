# bro-hg4l2 — split agent-connectors.ts into one module per backend, registered not hard-coded

## Problem
`packages/cli/src/agent-connectors.ts` is ~5500 lines with native/tmux/gascity/docker/copilot/devin inline and a hard-coded `BUILTIN_AGENT_BACKENDS` set. Adding a backend requires editing the god-file.

## Goal
Split backends into one module per backend under `packages/cli/src/agent-connectors/` (or equivalent), each backend self-registers via `registerAgentConnector`. Replace hard-coded builtin protection with registration metadata (e.g. `builtin: true` flag) so adding backends doesn't require editing the registry/god-file. Preserve all existing behavior, exports, and API surface used by tests and other code.

## Design
- Extract shared types/helpers/registry/orchestration (AgentConnector types, register/unregister, resolveAgentConnector, fleet/session/probe logic, prepareSpawn/commitSpawn, etc.) into `packages/cli/src/agent-connectors/core.ts` or keep in `agent-connectors.ts` as a thin facade.
- Move each backend to its own file: `agent-connectors/native.ts`, `tmux.ts`, `gascity.ts`, `docker.ts`, `copilot.ts`, `devin.ts`. Each imports shared helpers from core and calls `registerAgentConnector(name, factory, matchers, { builtin: true })` (or similar).
- Change `registerAgentConnector` to accept options `{ builtin?: boolean }` and track builtins via a Set derived from registrations (or stored on entries). Replace `BUILTIN_AGENT_BACKENDS` hard-coded set with this.
- Keep `agent-connectors.ts` as the entry point that re-exports everything needed and imports all backend modules to trigger registration (side effects). Maintain backward compatible exports.
- Ensure `unregisterAgentConnector` still refuses to unregister builtins with same warning behavior.
- Update tests if needed? Tests import from `agent-connectors.ts` and use the API - should remain compatible.

## Verify
- `npm run build` (or `tsc`/build as per repo)
- `npm test` (repo test command)
- Manual check: `agentConnectorNames()` still returns all builtins; registration/unregistration behavior unchanged.
