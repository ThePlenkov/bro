---

name: clients
description: "Use when checking which agents have bro installed, installing or removing the bro adapter for a client (opencode, kilo, pi, omp), or asking why a manifest client (claude, codex, cursor) does or doesn't see bro. Thin wrapper over the bro CLI — mechanics live in `bro clients`."
---

# /clients (bro)

**All mechanics live in the `bro` CLI** (`bro clients`), spec
specs/bro-cl1.md. This skill is policy only.

    10|Two client shapes exist, and the surface treats them differently:

- **Emitted clients** — opencode, kilo, pi, omp: bro materializes an
  adapter module into the client's plugin dirs. `bro clients
  install|uninstall <client>` owns the bytes (idempotent by content;
  uninstall refuses a foreign or hand-edited file without `--force`).
- **Manifest clients** — claude, codex, cursor: they consume the
  repo-root plugin through their OWN marketplace machinery. bro emits
  no adapter for them; `install|uninstall` refuse with the client's
  own install command, and the matrix answers "is it installed" via a
  read-only probe (marketplace registration + cached plugin copy,
  version-compared against this bro).

  20|## Commands

| Command                                                                     | What it does                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `bro clients [list [--json]]`                                               | the client × scope matrix — `installed`/`stale`/`present`/`absent` per client and scope |
| `bro clients install <client> [--global] [--local] [--dry-run] [--force]`   | materialize the adapter; neither scope flag = both                                      |
| `bro clients uninstall <client> [--global] [--local] [--dry-run] [--force]` | remove the materialized module                                                          |

    30|## Policy

- **`bro plugins` is the registry, `bro clients` is the agents.**
  Plugins are FOR bro (the command table); clients are the agents that
  USE bro. The old `bro plugins install|uninstall|list` forms still
  route here — one stderr line names the move.
- **A manifest client's bytes are its marketplace's business.** For
  claude/codex/cursor, updating the install means the client's own
  update flow (or repointing its marketplace at a fresh checkout) —
  never hand-edit the cache copy.
- **`stale` is an update available, not a breakage.** A manifest cache
  older than this bro still works — it just predates the current
  build. Reinstall through the client's flow to refresh it.
- **doctor reads the same probe.** The `plugins` row is informational:
  "not installed" is a choice, never a defect; the row exists so a
  broken install ("I installed it but hooks never fire") has a visible
  verdict.
