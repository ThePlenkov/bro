# bro-mk7m2 — docs: close the coverage-audit gaps + generate the command index from the contract

## Problem

From `specs/bro-j1kk2/coverage-audit.md` (2026-10-15):
- Gaps (user-facing surface, no docs page): `bro mesh`, `bro fleet mcp`, `bro fleet provider` / `provider serve` host story, `bro work goal`, `bro trace` (OTLP export).
- Registry drift: `mesh` ships `skills/mesh/SKILL.md` but the registry entry carries no `skill:` field — client adapters never emit it. Must wire `skill: 'mesh'`.
- Also need to "generate the command index from the contract" (j1kk2.8) — the generator reads from the contract/registry and emits `site/content/docs/reference/*` pages + grouped `meta.json`. The generator and check gate exist; they must stay correct and cover gaps.

## Design

1. **Fix mesh registry skill wiring** — add `skill: 'mesh'` to the `mesh` plugin definition in `packages/cli/src/plugins.ts`. The skills tree already has `skills/mesh/SKILL.md` and `bro:mesh` skill exists.
2. **Close coverage gaps with narrative docs** — add curated command pages under `site/content/docs/commands/` for the missing user-facing surfaces where appropriate (following existing patterns). The gaps listed:

- `bro mesh` — federation protocol, spec exists at `specs/mesh/spec.md`. Add `site/content/docs/commands/mesh.md` (and/or ensure reference page is sufficient). Reference page is generated from registry; curated guide adds narrative/why.
- `bro fleet mcp` — MCP server for client hosts (adoption surface). `mcp` command exists in fleet group with skill `mcp`. Add curated guide `site/content/docs/commands/mcp.md` or update/ensure it's covered.
- `bro fleet provider` / `provider serve` — "Claude Code runs on bro" host story. `provider` exists in fleet group with skill `provider`. Add narrative guide `site/content/docs/commands/provider.md` (or expand existing providers.md / add provider.md).
- `bro work goal` — session goal primitive. `goal` exists in work group with skill `goal`. Add `site/content/docs/commands/goal.md`.
- `bro trace` — OTLP export, operator observability. `trace` exists in fleet group with skill `trace`. Add `site/content/docs/commands/trace.md`.

Also ensure the generated reference pages are correct (they come from registry/contract). The generator already handles these commands.
3. **Generate/update command index from contract** — run `npm run gen:command-docs` to regenerate `site/content/docs/reference/*` and `meta.json` from the live registry. Ensure `npm run check:command-docs` passes.
4. **Update root README command tables** if needed to match (design says "Update root README command tables" in bead design).

## Verify

- `npm run build` passes
- `npm run check:command-docs` passes
- `npm test` passes (or run relevant tests)
- Every registry command has a page or is hidden (gate enforced by generator/check)
- Mesh has `skill: 'mesh'` in registry
- New curated command pages exist for gaps where needed

Commands: `npm run build && npm run check:command-docs && npm test`
