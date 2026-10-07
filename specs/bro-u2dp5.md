# bro-u2dp5 — drop the vulnerable @sverka/cli pin for the actively published sverka

## Problem

`@broject/bro` declares `"@sverka/cli": "^0.1.27"` as a **runtime**
dependency (the bundled `bro check` fallback executor). Every published
consumer of `@broject/bro` therefore installs
`@modelcontextprotocol/sdk@1.30.1` — inside the vulnerable range
`>= 1.12.0, < 1.31.0` of
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
(MCP TypeScript SDK: OAuth client could send credentials to an
authorization server chosen by the MCP server). Verified via OSV: `1.31.0`
carries no advisories.

The root `overrides` entry in `package.json`
(`"@modelcontextprotocol/sdk": "^1.31.0"`, added by #327) floats *this*
repo's tree to 1.32.1 — and does nothing for consumers, because npm
`overrides` only apply at the installing project's root.

The bead's original mitigation was "bump `@sverka/cli` once a release with
a relaxed pin ships" (upstream issue
[sverka-dev/sverka#319](https://github.com/sverka-dev/sverka/issues/319)).
That framing is stale:

- `@sverka/cli` is **deprecated**: *"Renamed to 'sverka' — install with:
  npm i -g sverka (or bunx sverka)"*, last modified 2026-10-04.
- the actively published successor `sverka@0.2.10` (modified 2026-10-06,
  not deprecated) declares `"@modelcontextprotocol/sdk": "1.31.0"` — the
  **fixed** version. `npm ls` on a fresh `sverka@0.2.10` install resolves
  exactly one sdk, `1.31.0`, and `npm audit` reports 0 vulnerabilities.
- every version of the deprecated line, including the newest
  `@sverka/cli@0.1.35`, still pins `1.30.1`.

So the pin can be retired now, not waited on: move the runtime dep to
`sverka` and the consumer-side vulnerability goes with it. Waiting on a
relaxation in a deprecated package trades a live advisory for a dead
line.

## Design

**One-line dependency move, plus the paths that name the old package.**
`bro check` resolves its executor binary from three node_modules-shaped
locations (`repoLocalBin`, `bundledBin`, and the `.bin` shim fallback),
all of which hardcode the `@sverka/cli` package layout
(`node_modules/@sverka/cli/dist/bin.mjs`). The new package keeps the same
`dist/bin.mjs` entry but at `node_modules/sverka/dist/bin.mjs`.

Resolution must accept **both** layouts, preferring the current one:

- package-entry probe order: `sverka` → `@sverka/cli` (the legacy path is
  a consumer's own pinned install — repos still on `@sverka/cli@0.1.x`
  must keep resolving, exactly as they do today);
- `.bin/sverka` shim probing and `PATH` lookup are unchanged — the bin
  name did not change across the rename;
- the bundled fallback is what actually ships, so it resolves to
  `sverka`.

Both package entries are spawned through `process.execPath` (unchanged)
so Windows `.cmd` shims never reach `spawn`.

**The dependency bump is load-bearing beyond the pin.** `sverka@0.2.x`
also moves the `@sverka/*` sub-packages to `0.2.x` and gains
`sverka workflow`/`discover` commands. bro does not import sverka's API
— it only spawns `sverka run --format json` and parses the envelope
(`{"command":"run","data":{planId,status,steps[]},durationMs}`). That
envelope is unchanged in 0.2.x, confirmed against a real `sverka run
--format json` on a generated config; the `COLLECTION_FAILED` retry
path sverka's bundle still emits is intact. So the change is a
subprocess contract, not an API contract — but it is a real upgrade of
the executor, hence the e2e smoke below.

**Root `overrides` for the sdk stays.** It is still the right defence for
*this* repo's tree (and for the legacy `@sverka/cli` install a consumer
might keep around); it just stops being the only line of defence.

## Plan

- [x] spec (this file)
- [x] `packages/cli/package.json`: `@sverka/cli@^0.1.27` → `sverka@^0.2.10`
- [x] `check.ts`: probe `sverka` before `@sverka/cli` in `repoLocalBin`
      and `bundledBin`; comments and the not-found install hint name the
      current package
- [x] `check.test.ts`: bundled-entry assertion covers the `sverka` path;
      a new test pins the legacy `@sverka/cli` fallback order
- [x] `skills/check/SKILL.md` + spec `bro-eqgx.md` wording: name the
      current package
- [x] `npm run build && npm run typecheck && npm test` (the exact CI
      commands)
- [x] dogfood: `bro check` against a tmp sverka project through the
      bundled fallback, real `sverka` on disk
- [x] consumer proof: `npm pack` the CLI, install the tarball into a
      clean project, `npm ls @modelcontextprotocol/sdk` → `1.31.0` under
      `@broject/bro`, `npm audit` → 0 vulnerabilities, and the installed
      `bro check` runs a real sverka project (3 steps ok → exit 0;
      injected step failure → exit 1)
- [ ] PR; act gate; merge

## Out of scope

- Relaxing the pin upstream (sverka#319) — moot for bro once the
  deprecated line is no longer a dependency.
- Removing the root `overrides` entry.
- `bro check` gaining sverka 0.2-only capabilities.