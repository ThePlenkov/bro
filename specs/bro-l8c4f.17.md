---

parent: bro-l8c4f
scope:
- site/content/docs/
- README.md
- scripts/
- contract/
- package.json
- .github/workflows/ci.yml

---

# bro-l8c4f.17 — npm onboarding names commands the published CLI does not have

The docs teach the grouped `bro <group> <member>` surface (`bro review
debt`, `bro flow convoy`) plus commands that only exist on `main`, while
`npm i -g @broject/bro` installs 0.2.5 — whose dispatcher resolves flat
plugin names only. The documented copy/paste path fails at the first
command: `unknown command: review`.

Verified on the published tarball: `PLUGINS` holds flat names (`debt`,
`act`, `convoy`, `next`, `loop`, `fleet`, `agents`, `status`, `notify`,
`watch`, `drive`, `serve`, `bus`, `check`, `cleanup`, `drill`, `unwind`,
`retrospect`, `wtf`, `learn`, `judge`, `guard`, `work`, `stack`, `spec`,
`setup`, `doctor`, `sync`, `sweep`, `query`, `mesh`, `run`, `plan`,
`plugins`, doc nouns `task`/`store`). New on main — grouped dispatch and
the commands `daemon`, `resume`, `provider`, `mcp`, `pulse`, `rig`,
`telemetry`, `trace`, `acp`, `sinks`, `queue`, `goal`, `dogfood`,
`providers`, `request`, `wait`, `stamp`, `contract` — plus new subs
(`stack publish|merge`, `agents log`, `drill park|wake`).

## Change

1. **`contract/published.json`** — a checked-in manifest of the
   npm-published CLI surface:
   `{ package, spec, version, next, commands: {name: [subs…]}, docTypes,
   docVerbs, generatedAt }`. `next` is the announced upcoming release
   (`0.3.0`, per whats-new). Refreshed by the new
   `npm run gen:published` script — packs and installs the published
   tarball into a temp prefix inside a non-git scratch dir, then parses
   `bro --help` (and per-command usage output) for names and
   subcommands. A snapshot, never fetched at check time.

2. **Generated reference pages carry the release boundary** —
   `scripts/gen-command-docs.ts` reads `contract/published.json` and
   emits an `npm` row on every command page: `0.2.5`, `0.2.5 — new in
   0.3.0: publish, merge` when the current surface grew subs, or
   `unreleased — lands in 0.3.0`. Unparseable subs degrade to a
   command-level verdict.

3. **Stable onboarding pages run on the published tarball** —
   `site/content/docs/index.mdx` and `README.md` copy/paste paths switch
   to the flat spellings the permanent compat aliases guarantee
   (`bro debt status`, `bro convoy run`, `bro act wait`); a version-
   boundary note on each page states npm `latest` (0.2.5) vs the
   grouped/main surface that ships in 0.3.0. Unreleased commands and
   subcommands cited anywhere in the docs carry an explicit
   `0.3.0`/unreleased mark; curated pages that name unreleased commands
   get a boundary line under their title block.

4. **`scripts/check-onboarding.ts` + CI step** — the isolated-fixture
   regression check: `npm pack @broject/bro@latest` →
   `npm i -g --prefix <tmp>` → assert install/`--version`/`--help`, then
   extract every `bro …` / `npx @broject/bro …` command line from the
   onboarding pages and assert each leading token resolves on the
   published CLI (`bro --help` output) and each second token is a
   recorded published subcommand, flag, or placeholder. A lagging
   `contract/published.json` version warns — refreshing the manifest is
   a release chore, not a PR blocker.

## Invariants

- The grouped CLI is canonical and never rolled back. Flat spellings
  are permanent compat aliases — docs may teach either surface, but
  pages carrying the npm-install path show only what dispatches on
  `latest`.
- The check never _executes_ documented commands — several published
  commands (`bro watch`, `bro sync`, `bro doctor`, `bro fleet`) treat
  `--help` as "run it" and have real side effects. Verification is
  dispatch-level parsing of help output, never invocation of the doc'd
  argv.
- `contract/published.json` is a snapshot: `check:*` stays hermetic to
  the checkout; only `gen:published` and `check:onboarding` touch the
  registry.
- Out of scope (flagged, not fixed): skills and plugin-marketplace
  hooks resolve `npx @broject/bro@0` → 0.2.5 while speaking grouped
  syntax — the durable fix there is the 0.3.0 release itself, which is
  owner-gated. `npm run check:onboarding` needs network; CI already
  requires it (`npm ci`).

## Rejection test

- `check-onboarding` on the pre-fix docs fails —
  `unknown command: review` reproduced as a line-level verdict — and
  passes after the fix.
- `npm run check:command-docs` after regeneration emits `npm` rows:
  `daemon`, `pulse`, `providers`, `sinks`, `rig`, `stamp`, `queue`,
  `wait`, … read `unreleased`; `stack` reads
  `0.2.5 — new in 0.3.0: publish, merge`.
- Every `bro …` token sequence named on the stable pages resolves
  against `contract/published.json` — including `bro plugins install
  omp` and `bro stack publish|merge`, which get marks instead.
