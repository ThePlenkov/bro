# bro-y89 — publish all @broject/* packages + bro-pack for `bro setup`

## Problem

`@broject/*` workspace libs are `private: true` — historically drift, not
design: the published cli manifest referenced them (npm dependencies tab
404s), and the plugin SDK can't ship typed surface to external authors.
User decision: publish all packages, and move capability distribution to
gascity-style **packs** — `bro setup` installs a default pack.

## Design

### Phase 1 — publish every lib (this bead's PR scope)

- Drop `private: true` from `packages/{act,convoy,core,debt,drill,github,
  loop,retro}` (`site` stays private).
- Intra-workspace refs become real `dependencies` (not devDeps, not `*`) —
  nx release stamps lockstep versions; publish order handled by nx.
- cli keeps tsdown `noExternal` bundling: `npm i @broject/bro` stays one
  self-contained file (fast npx). Libs are published for SDK/standalone
  consumers (`@broject/core` Connector/TaskStore types, `@broject/github`
  review host, etc.).
- `nx.json release.projects` → all publishable packages (lockstep).
- `publish.yml`: iterate non-private `packages/*` with the same
  E404-guarded `npm publish` (or `nx release publish` if it covers OIDC).
- `prepare-for-release`: `0.0.0` placeholders + `npm trust github` per
  package (human approves each web-auth URL once).
- CONTRIBUTING/AGENTS: publish model — bundled cli + published libs.

### Phase 2 — `@broject/bro-pack` + `bro setup --pack` (follow-up bead)

- Extract today's embedded plugin payload (`skills/`, `hooks.json`,
  `plugin.json`, formulas — what `gen-plugins` materializes into
  `skills-data.ts` + `plugins/*/bro/`) into a publishable pack package.
- `bro setup` prefers installing the default pack (npm) with the embedded
  payload as offline fallback.
- Packs become independently versioned capabilities; community packs get
  a registry-shaped install path.

## Plan (phase 1)

- [ ] un-private 8 manifests + real intra-deps
- [ ] `release.projects` all packages; verify `nx release version` stamps
      lockstep + rewrites intra-dep specs
- [ ] `publish.yml` multi-package publish (E404 guard, dependency order)
- [ ] `prepare-for-release` placeholders + `npm trust` per package (human OTP)
- [ ] docs: CONTRIBUTING publish model, README install notes
- [ ] release `0.3.0` (minor — new published surface) ships all packages

## Phase 2 checklist (not this PR)

- [ ] pack package skeleton + version-sync with gen-plugins
- [ ] `bro setup --pack [name]` → npm-install pack, fallback embedded
- [ ] deprecate embedded-only path once packs are proven
