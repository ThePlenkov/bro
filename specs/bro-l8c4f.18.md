# Spec: bro-l8c4f.18 — quickstart separates project policy from machine-local config

## Problem

The onboarding surfaces told operators that `bro setup` writes a gitignored
`bro.config.json`:

- `site/content/docs/index.mdx` ("Getting started") — the setup one-liner and the
  follow-up prose both named `bro.config.json` as the per-clone gitignored file.
- `site/content/docs/why-bro.md` — repeated the same model ("the gitignored
  `bro.config.json`", and the beads opt-out pointing at `bro.config.json`).

The writer (`packages/cli/src/commands/setup.ts`) actually writes
`bro.config.local.json`, and the committed project policy lives in
`bro.config.{ts,json}`. The merge order is **local > project > global**
(`packages/core/src/config.ts` — `CONFIG_LAYER_FILES`, `.ts` shadows `.json`).
`site/content/docs/configuration.md` already documents the three layers
correctly, but the quickstart contradicted it — sending operators to edit the
wrong layer.

The same onboarding files also claimed a `Node ≥ 22` floor while the CLI
engines require `>= 22.18` (unflagged type stripping) — a second, related
onboarding drift folded into this bead.

## Design

Docs-only. No runtime code.

- `site/content/docs/index.mdx` (quickstart):
  - `bro setup` comment now says it writes `bro.config.local.json`.
  - Prose names the actual file, separates the gitignored machine-local
    `bro.config.local.{ts,json}` from the committed project policy
    `bro.config.{ts,json}`, states the merge order **local > project > global**
    over `~/.config/bro/config.{ts,json}`, and defers to Configuration.
  - Node floor raised to `≥ 22.18` to match engines.
- `site/content/docs/why-bro.md`: the machine-local contract reference and the
  beads opt-out now point at `bro.config.local.json` — the layer store choices
  belong to.
- `packages/core/README.md`, `packages/act/README.md`: Node floor `≥ 22.18` to
  match engines.
- `site/content/docs/configuration.md` is left as the authoritative three-layer
  page — the quickstart now defers to it instead of restating a wrong model.
- Root `README.md` config section already described the layers correctly
  (committed policy merged over global, under `bro.config.local.json`) — left
  untouched.

## Verify

- `npx tsx --test src/docs.test.ts` from `packages/cli` (and `packages/act`) —
  these validate the `bro docs` CLI verb dispatch and act's docs-path globbing,
  not site pages; they must stay green (no regression from a docs-only change).
- `npm run check:docs` — the AGENTS.md config-quote check; unaffected, must stay
  green.
- Manual read: every onboarding surface now names `bro.config.local.{ts,json}`
  for the gitignored layer, `bro.config.{ts,json}` for committed policy, and the
  merge order local > project > global.

The audit's "documentation check catches the divergence" recommendation is a
future check-script addition — out of this docs-only change's scope.
