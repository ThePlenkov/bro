---
parent: distro
---

# bro-vf5 — rebrand: @bro/* + @theplenkov/bro → @broject/* npm scope

## Problem

The `@bro` npm org scope is taken by someone else. The user owns
`@broject` ("BROject — every agent needs a bro"). Today only the CLI
publishes (`@theplenkov/bro`); every internal package is `private:
true`, so nothing technically breaks — but:

- the plugin SDK story (`BroPlugin`, `Connector`, `defineConfig`) needs
  a publishable types package eventually — impossible under `@bro`
- the v0.1 cut (bro-8wk) hasn't shipped; publishing under
  `@theplenkov/bro` first would strand early installs on a dead name
- `bro-scx` already flags the published 0.2.0 dist as stale — a clean
  name break beats shipping a rename shim later

## Design

Scope rename only — identity stays:

- `@bro/<pkg>` → `@broject/<pkg>` for all `packages/*` (incl.
  `@bro/site`)
- `@theplenkov/bro` → `@broject/bro` (published CLI, bin stays `bro`)
- imports `'@bro/x'` → `'@broject/x'`; same for `@theplenkov/bro`
  references in hooks.json, workflows, skills, docs, manifests
- nx project names follow package names (nx reads package.json)
- NOT renamed: binary `bro`, commands, `bro.config.json`, `BRO_*` env
  vars, `.beads` prefix `bro-`, GitHub repo `bro`, types (`BroPlugin`)

Version: keep the current version line; the first publish as
`@broject/bro` is a fresh package, no deprecation shim needed for
`@theplenkov/bro` (0.x, pre-v0.1-cut — documented in release notes).

## Plan

- [x] `packages/*/package.json` + root `site` name + cross-deps
- [x] `import '@bro/*'` / `'@theplenkov/bro'` across `*.ts` (mechanical)
- [x] `nx.json`, `package-lock.json` (npm install regenerates),
      `.github/workflows/{publish,release}.yml`, `hooks.json`
- [x] skills/*.md + README/CONTRIBUTING `npx @theplenkov/bro` refs
- [x] regen `plugins/*` + `skills-data.ts` via `npm run build`
- [x] typecheck + `npm test`; publish stays human-gated (bro-8wk)

Implemented extras: `tsdown.config.ts` `noExternal` regex, `hooks.ts`
`isSelfToolCommand`/self-tool npx patterns, `gen-plugins.ts` `PIN_RE`,
`hooks/run.sh` + plugin copies, `site/` (.mts/.mdx/lock). Hook fallback
pins stay version-pinned (`@broject/bro@0.2.0` — gen-plugins rewrites
the pin to the package version by design); until the first `@broject`
publish the `npx` fallback 404s → `|| true` keeps hooks fail-open.
