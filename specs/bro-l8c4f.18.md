---
parent: bro-l8c4f
scope:
  - packages/cli/src/commands/setup.ts
  - packages/cli/src/commands/setup.test.ts
  - scripts/check-docs.ts
  - site/content/docs/index.mdx
  - site/content/docs/why-bro.md
  - README.md
  - CONTRIBUTING.md
  - packages/*/README.md
  - packages/*/package.json
---

# bro-l8c4f.18 — onboarding contract: setup writes the local layer, Node floor is engines

Parent: `bro-l8c4f` (principal audit — reliability, product niche,
integrations). Closes the audit's onboarding-config findings: the
quickstart teaches a config model the code does not implement, and the
documented Node floor is below what `engines` requires.

## Problem

Two onboarding lies, both verified against
`674e3be`:

1. **Wrong config layer.** `site/content/docs/index.mdx` says
   `bro setup` "writes bro.config.json" and that the file is "written
   per-clone and gitignored". `writeConfig` in
   `packages/cli/src/commands/setup.ts` writes
   `bro.config.local.json` — the gitignored machine-local layer (spec:
   specs/bro-9vmx.md) — and deliberately never touches the committed
   project file. `why-bro.md` repeats "the gitignored
   `bro.config.json`" and tells operators to opt out in
   `bro.config.json`, steering machine-local store choices into the
   committed policy layer. Worse, nothing *makes* the local file
   gitignored in a user repo: setup writes it but adds no exclude
   entry, so "gitignored" is only true in this repo (`.gitignore`
   carries `bro.config.local.*`), not in a fresh setup target.
2. **Node floor below engines.** The site, `packages/core/README.md`,
   `packages/act/README.md`, and every other package README say
   "Node ≥ 22"; root and `packages/cli` `engines.node` require
   `>=22.18` (unflagged type stripping). Library packages declare
   `>=22` — an unverified promise of early-22.x support. Nothing
   checks the claims, so they rot.

## Design

- **`bro setup` enforces the exclusion it documents.** After the local
  config write (and on the `bro.config.local.ts` shadow path), setup
  appends `bro.config.local.*` to `.git/info/exclude` — the same
  machine-local mechanism `ensureDebtDirExcluded` (packages/debt) and
  `bd init --stealth` already use. Skip quietly outside a worktree;
  warn (never fail) when the exclusion can't be applied or the file is
  already tracked. `check-ignore` first: a repo that already covers
  the pattern is left alone.
- **Docs name the real contract.** index.mdx says setup writes
  `bro.config.local.json`, shows the committed project layer
  (`bro.config.{ts,json}`) as a separate thing, and points at
  /docs/configuration for the local > project > global merge.
  why-bro.md's opt-out names `bro.config.local.json`. Every Node
  requirement states the engines floor (`>= 22.18`) — site, package
  READMEs, CONTRIBUTING.md.
- **One minimum.** Every workspace package's `engines.node` becomes
  `>=22.18` — the docs check has a single floor to compare against and
  no early-22.x support is promised anywhere.
- **`check:docs` pins the contract.** Two new checks in
  `scripts/check-docs.ts`: (a) every `Node ≥ x` / `node >= x` /
  `node-%3E%3Dx` badge claim in the doc set equals the root
  `engines.node` floor; (b) no doc line presents the committed
  `bro.config.json` as setup-written or gitignored (the
  `bro.config.local.*` spellings are stripped before matching), and
  index.mdx must name `bro.config.local.json`.
- **Smoke fixture.** `writeConfig` is exported; setup.test.ts asserts
  the created filename is `bro.config.local.json`, the file is
  `git check-ignore`-clean inside a fixture repo, the exclude entry
  lands, a committed `bro.config.json` survives byte-for-byte, and an
  already-covered pattern isn't duplicated.

## Plan

- [x] Write spec (this file)
- [x] `packages/cli/src/commands/setup.ts`: `ensureLocalConfigExcluded`
      + export `writeConfig`; call the guard on every write path
- [x] `packages/cli/src/commands/setup.test.ts`: the smoke fixture
- [x] Docs: index.mdx, why-bro.md, README.md, CONTRIBUTING.md,
      `packages/*/README.md`
- [x] `packages/*/package.json`: `engines.node` → `>=22.18`
- [x] `scripts/check-docs.ts`: Node-floor + setup-filename checks
- [ ] `npm run build && npm run typecheck && npm test &&
      npm run check:docs`, commit, push, PR
