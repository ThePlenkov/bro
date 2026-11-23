---
parent: bro-1qpk
---

# bro-cl1 — `bro clients` — the agent-client command family; `bro plugins` becomes the registry-only surface

## Problem

`bro plugins` carries two unrelated surfaces under one name:

1. the **BroPlugin registry** — plugins FOR bro (the command table:
   `bro plugins` prints it, `bro plugins --json` emits it);
2. the **client × scope install matrix** (`bro plugins list`) and the
   adapter materializers (`bro plugins install|uninstall`) — commands
   about the AGENTS THAT USE bro.

The two collide further down the road: the matrix is about clients, not
plugins, and the manifest-based clients (claude, codex, cursor — which
consume the repo-root plugin through their own marketplace machinery and
have no adapter module to materialize) have no surface at all. `bro
plugins list` cannot honestly show them, and doctor's plugins row is
blind to whether a manifest client has bro installed.

## Design

### `bro clients` — the agent-client family

| Invocation | Behavior |
| ---------- | -------- |
| `bro clients` / `bro clients list [--json]` | the client × scope install matrix — emitted clients AND manifest clients |
| `bro clients install <client> [--global] [--local] [--dry-run] [--force]` | materialize the adapter (emitted clients only) |
| `bro clients uninstall <client> [--global] [--local] [--dry-run] [--force]` | remove the materialized module |

The whole client machinery (`CLIENTS`, surfaces, install/uninstall,
`pluginRows`, `isBroAdapter`) moves from `commands/plugins.ts` to
`commands/clients.ts` — doctor imports it from there.

### Manifest clients — detected, not materialized

claude, codex and cursor consume the repo-root plugin through their own
marketplace machinery (`known_marketplaces.json` + version cache;
`config.toml` `[marketplaces.*]` + version cache; `plugins/local/<name>`
symlink or a marketplace clone). bro emits no adapter for them, so
`install`/`uninstall` refuse with the client's own install command
instead of an unknown-client error. The registry carries a read-only
probe per client; rows land in `bro clients list` and doctor's plugins
row. Probe states reuse the matrix vocabulary:

- `installed` — the marketplace registration AND a cache copy at or
  above this bro's version (cursor: our manifest at the symlink target
  or in a marketplace clone);
- `stale` — a cache/manifest copy older than this bro's version, or a
  dangling symlink (the checkout it pointed at moved);
- `present` — one half only (cache without registration, or a foreign
  dir at the slot);
- `absent` — nothing.

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CURSOR_CONFIG_DIR` relocate the
probed config roots, matching what each client honors. devin has no
local install surface (cloud sessions) and herdr is this rig's own
multiplexer — neither gets a row.

### `bro plugins` — the registry only

`bro plugins` (no args) and `bro plugins [--]json` stay the BroPlugin
registry table. `bro plugins list [--json]` becomes a registry listing
alias. `bro plugins install|uninstall` keep working as thin aliases
routed to `bro clients install|uninstall` — muscle memory and scripts
keep running, one deprecation line on stderr names the new form.

### Skill + registry entry

The family ships plugin-shaped: a `clients` BroPlugin entry (skill
`clients`) and `skills/clients/SKILL.md`.

## Non-goals

- No emitted adapter for manifest clients — their marketplace owns the
  bytes.
- No devin/herdr rows — no local install surface to probe.
