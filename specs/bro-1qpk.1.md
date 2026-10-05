---
parent: bro-1qpk
---

# bro-1qpk.1 — 'bro plugins install|uninstall|list' facade + opencode global/local adapter

## Problem

bro already IS an opencode plugin — `packages/cli/src/opencode.ts` is a
complete native adapter (hook bus → `bro hooks` control objects,
fail-open, async spawns). What does not exist is the install mechanics:
nothing places that module into opencode's plugin dirs. Every client
bro supports today (devin/claude/codex/cursor adapters under
`plugins/<client>/bro/`) relies on a marketplace or manual symlink —
there is no `bro`-owned verb that answers "put bro into this agent,
here or everywhere."

Milestone 1 of bro-1qpk: the `bro plugins` command grows a client-
adapter surface (`install` / `uninstall` / `list` over `--global` /
`--local` scopes) and the opencode adapter becomes materializable —
the same module gen-plugins can emit into `plugins/opencode/bro/` for
repo-distributed installs and `bro plugins install` can write into a
client's plugin dir.

## Design

### Command surface — `bro plugins <sub>`

The `plugins` plugin's `run` routes on argv[0]:

| Invocation | Behavior |
| ---------- | -------- |
| `bro plugins` | unchanged — the BroPlugin registry table (name, skill, config, src, plan) |
| `bro plugins list [--json]` | client × scope install matrix: `installed`/`stale`/`absent` + resolved target path |
| `bro plugins install <client> [--global] [--local] [--dry-run]` | materialize the adapter into the client's plugin dirs; neither scope flag = **both** |
| `bro plugins uninstall <client> [--global] [--local] [--dry-run] [--force]` | remove the materialized file; neither scope flag = both |

`stale` = installed content differs from the artifact this bro would
write (upgrade path = re-run `install`, which reports `updated`).
`install` on a current file is a no-op (`already installed`) —
idempotent by content, not by existence.

`uninstall` refuses to remove a file that is not recognizably ours
(the shipped module carries the `server: BroPlugin` / `id: 'bro'`
sentinel); `--force` overrides. A foreign or hand-edited file is never
silently deleted.

### Clients registry

A `CLIENTS` table in the command module maps client name → adapter
descriptor (artifact resolver + per-scope target dirs). `.1` ships
`opencode` only; `.2` (kilo) and `.3` (pi) add rows. An unknown client
errors with the known list — same UX as `bro run` kind routing.

### opencode targets — plural `plugins/` dirs

opencode auto-loads `.ts`/`.js` files from `plugins/` subdirs
(singular `plugin/` is backwards-compat only, per current opencode
docs — the bead's singular path is stale):

- global: `$XDG_CONFIG_HOME/opencode/plugins/bro.ts` (default
  `~/.config/opencode/plugins/bro.ts`)
- local: `<git-root-or-cwd>/.opencode/plugins/bro.ts`

No manifest edit — the plugin dir IS the registration convention for
this client.

### The materializable module

Artifact source resolution (first hit wins):

1. `<pkg>/src/opencode.ts` — dev checkout / tsx run; also the file
   gen-plugins copies into `plugins/opencode/bro/bro.ts`
2. `<pkg>/dist/opencode.js` — the npm tarball entry (`exports["./server"]`);
   self-contained: opencode.ts imports node builtins only, so the
   bundle has no internal chunks — written out as `bro.ts` (JS ⊂ TS)
3. `<git-root(cwd)>/plugins/opencode/bro/bro.ts` — repo-distributed
   adapter, e.g. a marketplace clone where the CLI runs via npx

All three carry identical hook behavior; the byte-content compared for
`stale` is the first resolvable source.

### Runtime resolution inside the materialized module

`src/opencode.ts` gains the full ladder the bead asks for
(local-dist → PATH → npx-pinned, mirroring `.kilo/plugin/bro.ts`):

1. `options.command` override (unchanged — the test seam)
2. bundled sibling `./index.js` | `../dist/index.js` (unchanged —
   covers the npm `plugin: ["@broject/bro/server"]` config-entry form)
3. **walk-up** from the module dir for `packages/cli/dist/index.js` —
   a materialized `bro.ts` inside a bro checkout
   (`.opencode/plugins/`, `plugins/opencode/bro/`) resolves the
   checkout's build; same walk `.kilo/plugin/bro.ts` and
   `hooks/run.sh` already do
4. PATH `bro` passing the `bro hooks` probe (unchanged)
5. **`npx -y --prefer-offline @broject/bro@<pin> hooks`** — gated on an
   `npx --version` probe, pinned to the module's own version via the
   `VERSIONED_SOURCES` rewrite in gen-plugins (`packages/cli/src/
   opencode.ts` joins that list, so `gen:plugins`/`--sync-version` and
   `check:plugins` keep the pin equal to plugin.json's version)

Each tier still probes launchability before selection; a failed probe
falls through — fail-open is the contract.

### gen-plugins — the repo-distributed adapter

New `ADAPTERS` entry `plugins/opencode/bro/` emitting `bro.ts` (copy of
`packages/cli/src/opencode.ts`) and a generated `README.md`. opencode
plugins do not consume `skills/` links or `hooks/run.sh`, so the emit
loop gains a per-adapter opt-out (`shell`/`skills` flags defaulting
true — existing adapters unchanged). `check:plugins` then enforces
the adapter staying byte-equal to the shipped module.

### doctor

One informational `plugins` row in `bro doctor`: per known client, the
installed scopes (`opencode: global,local` / `opencode: absent`). Always
`ok` — absence is a choice, not a defect; the row exists so a broken
install ("I installed but the hooks never fire") has a visible verdict.

## Out of scope

- kilo adapter (bro-1qpk.2), pi adapter (bro-1qpk.3), deep opencode
  surface v2 (bro-1qpk.4)
- Writing opencode.json `plugin` arrays — unneeded: dir convention
  covers both scopes
- A `plugins` config section or skill — the command is self-describing;
  plugin-shape convention stays satisfied by the existing registry entry

## Plan

- [ ] `packages/cli/src/opencode.ts`: walk-up local-dist tier +
      npx-pinned fallback tier
- [ ] `packages/cli/src/commands/plugins.ts` (new): CLIENTS table,
      artifact resolution, install/uninstall/list incl. `--dry-run`,
      `--force`, `--json`; registry table moves here (PLUGINS injected
      by the registry to avoid the import cycle)
- [ ] `packages/cli/src/plugins.ts`: `plugins` plugin `run` delegates
      to the command module
- [ ] `scripts/gen-plugins.ts`: `plugins/opencode/bro` adapter
      (bro.ts copy + README, skills/run.sh opt-out) +
      `src/opencode.ts` in VERSIONED_SOURCES
- [ ] `packages/cli/src/commands/doctor.ts`: `plugins` row
- [ ] `packages/cli/src/commands/plugins.test.ts`: flag routing, scope
      defaults, install/idempotent/stale/uninstall (incl. foreign-file
      refusal + --force), list matrix, artifact source precedence —
      all on temp HOME/git-root fixtures
- [ ] `npm test` (exact CI command), `npm run check:plugins`,
      typecheck, commit + push + `gh pr create`
