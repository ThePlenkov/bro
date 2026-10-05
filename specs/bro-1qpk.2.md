---
parent: bro-1qpk
---

# bro-1qpk.2 — plugins .2: kilo adapter — promote .kilo/plugin/bro.ts into generated adapter + global registration

## Problem

`.kilo/plugin/bro.ts` works repo-locally today — a native kilo plugin
(tools + hooks + auto-approve over the bro CLI) — but it is gitignored
(`.kilo/` is repo-ignored), so it exists only in the author's working
tree. Nothing generates it, nothing installs it elsewhere, and
`check:plugins` cannot see it. Milestone 2 of bro-1qpk: make the module
the generated source of truth (same shape as the opencode adapter from
bro-1qpk.1) and teach `bro plugins install|uninstall|list kilo` the
global scope, which for kilo means a manifest registration — the
`plugin` array in `~/.config/kilo/kilo.json` takes `file:///` entries —
not just a file drop.

## Design

### The module — `packages/cli/src/kilo.ts`

The current `.kilo/plugin/bro.ts` is promoted — bin resolution
(checkout walk-up → PATH `bro`), `tool.bro` registration,
`experimental.chat.system.transform` → `session-start` hydration,
`session.idle` → `stop` warn-log, `permission.ask` auto-approve — all
unchanged. Three mechanical adjustments:

- the plugin const `bro` becomes `BroPlugin` so the `.1`
  `isBroAdapter` sentinel (`id: "bro"` + `server: BroPlugin`)
  recognizes kilo materializations — one sentinel covers both adapters
- `client.app.log({service, level, message})` gains the typed
  `{body: …}` envelope — the flat shape never serialized onto the wire
  correctly against the real SDK (`Options<AppLogData>`)
- `permission.ask` reads `input.patterns` first, falls back to the
  declared `input.pattern` (`string | string[]`) — the typed field the
  old code's plural-only read could miss

The module keeps `import { tool } from '@kilocode/plugin/tool'` +
`import type { Plugin }`. That specifier resolves at runtime because
kilo provisions `package.json` + `node_modules` (with
`@kilocode/plugin`) in any config dir that carries a `plugin/` folder —
observed on this machine at both `~/.config/kilo/` and `.kilo/`. Inside
our repo it resolves via a **devDependency** on `@kilocode/plugin`
(typecheck only; the package never ships it — the emitted `dist/kilo.js`
keeps the import external like every other dep).

`src/kilo.ts` joins the tsdown entry list (→ `dist/kilo.js`) and gains
`exports["./kilo"]` — the npm-specifier form kilo's `plugin` array also
accepts.

### `bro plugins` — kilo row in CLIENTS

- **artifact** (first hit): `<pkg>/src/kilo.ts` (checkout) →
  `<pkg>/dist/kilo.js` (tarball) → `<git-root>/plugins/kilo/bro/bro.ts`
- **targets**:
  - global: `$XDG_CONFIG_HOME/kilo/bro/bro.ts` (default
    `~/.config/kilo/bro/bro.ts`) — deliberately NOT `plugin/` or
    `plugins/`: those dirs are auto-scanned by kilo, and a file there
    would double-register against the kilo.json `plugin[]` entry
  - local: `<git-root-or-cwd>/.kilo/plugin/bro.ts` — kilo auto-loads
    `.kilo/plugin/`, so no local manifest edit

File mechanics (sentinel, byte-compare idempotency, `--force` foreign
refusal, atomic write, `--dry-run`) are shared with opencode — they
live in `installClient`/`uninstallClient`/`pluginRows` already.

### Global registration — kilo.json `plugin[]`

`ClientSpec` gains an optional `registration(scope, path, env)` hook
returning `{ registered, register(), unregister() } | null`. kilo
implements it for `global` only:

- the manifest is `<XDG>/kilo/kilo.json` — strict `JSON.parse`; a
  missing file registers against `{}` (created on write with kilo's own
  `$schema` line); a malformed one exits with "not plain JSON — edit
  the `plugin` array by hand" (kilo.jsonc comment support is out of
  scope; kilo merges both files, so writing only `kilo.json` is always
  correct)
- `register()` adds `pathToFileURL(path).href` to `plugin[]` — dedupe,
  so re-install is a no-op; write is atomic (tmp+rename), 2-space JSON
  matching kilo's own formatting
- `unregister()` filters the entry out

Wiring into the shared mutation path:

- `install`: registration is checked **before** the file write (the
  parse fails before anything is touched); on a non-refused outcome a
  missing entry is added — a `current` file that needed registering
  reports `updated` with a note. `--dry-run` reports only.
- `uninstall`: the entry is removed whenever it exists — including the
  `absent`-file case (dangling entry cleanup, reported via note); a
  `refused` file keeps its registration (the install may still be
  live).
- `list`/`stateAt`: kilo global is `installed` only when file bytes
  match AND the entry is registered; a matching-but-unregistered file
  reports `stale` (re-running `install` fixes it).

### gen-plugins — `plugins/kilo/bro/`

New `ADAPTERS` entry emitting `bro.ts` (copy of
`packages/cli/src/kilo.ts`) + generated `README.md`; `ADAPTER_OPTS`
opts out of `skills`/`runSh` like opencode. `check:plugins` then pins
the adapter to the source.

### doctor

No change needed — the `plugins` row consumes `pluginRows`, so kilo
appears automatically.

## Out of scope

- pi adapter (bro-1qpk.3), deep opencode surface (bro-1qpk.4)
- kilo.jsonc parsing, `opencode.json*` project manifests, tuple-form
  `plugin` entries
- kilo skills/commands surfaces — this adapter is the hooks+tool module
- Reworking the module's internals (spawnSync vs async, npx fallback):
  the bead pins current behavior

## Plan

- [ ] `packages/cli/src/kilo.ts`: promoted module (`bro` → `BroPlugin`
      rename only)
- [ ] `packages/cli/package.json`: devDep `@kilocode/plugin`,
      `exports["./kilo"]`; `tsdown.config.ts`: `src/kilo.ts` entry
- [ ] `packages/cli/src/commands/plugins.ts`: `kilo` CLIENTS row +
      `registration` hook (kilo.json read/dedupe/write, file:/// entry)
      wired into install/uninstall/stateAt
- [ ] `scripts/gen-plugins.ts`: `plugins/kilo/bro` adapter
      (bro.ts copy + README, skills/runSh opt-out)
- [ ] `packages/cli/src/commands/plugins.test.ts`: kilo cases —
      artifact ladder, local/global install, kilo.json register +
      idempotent re-install, unregister incl. dangling entry, stale /
      foreign / dry-run, list matrix (temp XDG + cwd fixtures)
- [ ] `npm test` (exact CI command), `npm run check:plugins`,
      typecheck, commit + push + `gh pr create`
