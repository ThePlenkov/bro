# bro-155e — npm docs: per-package READMEs + metadata + site package map

## Context

bro-y89 (sibling session) publishes all `@broject/*` packages. Today only
`@broject/bro` has metadata/docs worth rendering; the eight library
packages have no `README.md`, no `description`, no `keywords`. Once
published, every npm page would show "no readme".

## Scope

- `packages/{act,convoy,core,debt,drill,github,loop,retro}/README.md`
  — compact: one-line pitch, "you probably want @broject/bro" pointer,
  install line, public-surface sketch, link to broject.dev docs.
- `package.json` for the same eight: `description`, `keywords`,
  `homepage: https://broject.dev/docs` (repository.directory exists).
- `site/content/docs/packages.md` — the package map (what to install vs
  internal libs), wired into `meta.json` nav.

## Non-goals

- Publishing, version bumps, OIDC trust — that is bro-y89.
- No docs for `bro packs` — the feature doesn't exist yet (bro-y89 phase 2);
  documenting vaporware is worse than a gap.

## Verify

- `npm run typecheck` unaffected (docs only).
- `meta.json` nav renders; site build not run here (site.yml builds on PR).
- Each README renders on npm: `npm pack --dry-run` includes README.md
  implicitly (npm always ships it).
