# bro-j1kk2.12 — release pins track the plugin's own major

Bead: `bro-j1kk2.12` (P2) — spawned from PR #537 review. The 1.0
decision changes the advertised major, but runtime fallbacks and skill
prerequisites still pin `@broject/bro@0` — a 1.x plugin would spawn the
0.x line and a 0.x-era doc would tell users to install the wrong line.

## Surface

- `packages/cli/src/agent-connectors.ts` — `broSpawnArgv`'s npx
  fallback hardcodes `@broject/bro@0` (the one runtime pin that picks
  which line a spawned worker runs).
- `skills/*/SKILL.md` — 38 `@broject/bro@0` mentions, mostly the
  frontmatter `Requires` line — static authored text, no generator
  coverage today.
- Already covered: `refguard.ts`/`githooks.ts` interpolate
  `${version}` at emit time; `gen-plugins.ts` `VERSIONED_SOURCES`
  rewrites exact-version pins in hooks/opencode/pi sources to
  `plugin.json`'s version — both self-tracking, no change needed.

## Design

- `broSpawnArgv` derives the major pin from `VERSION`
  (`@broject/bro@<major>`) — major-pin semantics preserved (any patch
  of the current line satisfies it), the pin can never lag a release
  again.
- `gen-plugins.ts` gains a major-pin sweep: `skills/*/SKILL.md` get
  `@broject/bro@<n>` rewritten to `plugin.json`'s major. At `0.x` the
  rewrite is a no-op; the day plugin.json reads `1.0.0` every skill
  flips to `@1` with the same commit that bumps the version —
  drift-free, caught by `check:plugins` if a skill pins another major.

## Verify

- `npm run gen:plugins` is a no-op on the current tree (0.x → `@0`).
- Unit tests assert the dynamic pin (`agent-connectors.test.ts`
  derives the expected major from `VERSION`, not a literal).
- `npm run build`, `npm run typecheck`, `npm test`.
