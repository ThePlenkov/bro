# bro-0opqd — homebrew formula installs the npm tarball, not a source build

## Context

`Formula/bro.rb` in ThePlenkov/homebrew-brew builds from the GitHub tag
tarball (`npm ci` + `npm run build` + pruned `npm install`). `@broject/bro`
publishes `files: ["dist"]` — a self-contained tarball whose dist is
bundled (workspace libs inlined) and whose deps (`@broject/bro-pack`,
`@sverka/cli`, `smol-toml`) all resolve from npm. OIDC trusted publishing
is now the release path, so the registry tarball can be the install
artifact — the deferred item from bro-uq6ou.

## Scope

- `Formula/bro.rb` (ThePlenkov/homebrew-brew, separate PR): `url`/`sha256`
  point at `https://registry.npmjs.org/@broject/bro/-/bro-<v>.tgz`;
  `install` becomes the standard node-formula `npm install *std_npm_args`
  + the existing `write_env_script` node-pinning wrapper. No source build.
- `.github/workflows/homebrew.yml`: the bump source becomes the npm
  registry. Ordering after publish.yml is the registry itself — the
  resolve step polls `npm view @broject/bro@<v> dist.tarball` (~30 min)
  before computing sha256, so the human-pushed-tag path (publish +
  homebrew run in parallel) and the release-tag dispatch both converge.
  `url`/`sha256` seds replace the whole assignment line and the version
  parse accepts both tarball shapes, so a mid-migration formula still
  bumps.

## Non-goals

- No `workflow_run` chaining on publish.yml — polling is the ordering
  primitive; it also covers retry/manual dispatch and human tag pushes.
- Formula stays gated on `HOMEBREW_TAP_TOKEN`; absent → warn + skip.

## Verify

- `npm run check:docs`, `check:plugins`, `check:embedded`, build,
  typecheck, `npm test` — workflow/docs only, all must stay green.
- Tarball mechanics smoke: `npm install --prefix <tmp> <tarball>` then
  `<tmp>/bin/bro --version` (same install shape the formula drives).
