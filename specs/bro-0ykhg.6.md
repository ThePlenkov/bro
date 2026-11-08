# bro-0ykhg.6 — split client adapters out of brouter into their own plugin package

Child of bro-0ykhg (specs/bro-0ykhg.md). Follows bro-lzj2f (the claude-code
model block, specs/bro-lzj2f.md).

## Problem

`@broject/brouter` describes itself as "the served catalog, the client
adapters …, and the protocol clients". The client adapters
(`packages/brouter/src/clients/`, `client-plugins.ts`, `settings.ts`,
`settings-diff.ts`, `brouter client|clients`) serve a different goal: make
Claude Code — the CLI agent, not the Anthropic API — run on other agents
(opencode, Devin, any ACP lane) by writing its model block. That goal breaks
on CLIENT releases (`behavesAs` targets, `modelPicker` schema), not on
routing changes, and it pulls client-version churn into the router's
review and release cycle.

## Design

- New package `@broject/client-adapters` (name open for the operator) with
  its own CLI implementation. The client half of `skills/brouter/SKILL.md`
  moves to a skill under the existing root `skills/` tree, alongside the
  one root `plugin.json`; the package adds no portable manifest or skill
  tree. Generated host adapters continue to point at that same root.
- Moves: `clients/`, `client-plugins.ts`, `settings.ts`, `settings-diff.ts`,
  `client-roundtrip.test.ts`, `scripts/claude-code-live-check.ts`, the
  `client`/`clients` commands.
- Dependency direction: the adapter package reads the catalog through
  brouter's public API (`brouter models --json` / the catalog export);
  brouter never imports the adapters.
- CLI: `brouter client …` stays as a compat alias for one release, printing
  the new spelling; `bro router client …` follows the grouped-CLI contract.

## Verify

- `npm run build && npm run typecheck && npm test` green; the round-trip
  test runs in the new package unchanged.
- `@broject/brouter` has no import from the adapter package (a check in
  `check:contract` or a test).
- `brouter client claude-code` (alias) and the new spelling produce the same
  block byte-for-byte.
