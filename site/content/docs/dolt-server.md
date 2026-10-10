---
title: Beads store on a managed dolt sql-server
description: Embedded-mode bd pays engine open + a store lock per call; a persistent `dolt sql-server` endpoint removes both. Install, cold-start fallback, diagnostics, revert.
---

Default bd runs Dolt **embedded**: every `bd` call opens the database
and takes a store flock (~1s+, serialized). Under orchestrator
concurrency — loop + drive + watch read planes — `bd` calls queue
behind their own lock and ETIMEDOUT. **Server mode** flips it: a
persistent `dolt sql-server` owns the data dir, `bd` hits a socket, and
per-call startup disappears.

## What the setup is

- **Data** — `.beads/dolt/` (server-mode convention; the embedded
  `.beads/embeddeddolt/` content is the same `<db>/.dolt` layout — the
  move is a rename, not a conversion).
- **Endpoint** — `127.0.0.1:<port>`, pinned in `.beads/config.yaml`
  (`dolt.host`/`dolt.port`) and `.beads/dolt-server.port`.
- **Managed lifecycle** — `dolt.auto-start: false` in the `dolt:` config
  block: bd must not spawn an unsupervised twin — endpoint down is a
  fast connection-refused, not a surprise fork. A `systemd --user` unit
  `beads-dolt-<repo>.service` (`Restart=on-failure`) keeps the server up
  across reboots (linger required).
- **Same config file, both paths** —
  `.beads/dolt-server-config.yaml` is the unit's `--config` and what
  `bd dolt start` reuses manually — one port, no drift.

## Install / migrate

```bash
node scripts/beads-dolt-server.ts install            # store at ./.beads or $BEADS_DIR
node scripts/beads-dolt-server.ts install --beads /path/to/.beads --port 37934
node scripts/beads-dolt-server.ts status             # mode, endpoint reachability, unit state
```

`install` is idempotent: moves `embeddeddolt/` → `dolt/`, writes the
server config + port file, flips `metadata.json` to `dolt_mode:
server`, adds the `dolt:` block + `gc.endpoint_*` markers to
`config.yaml`, renders the unit, `systemctl --user enable --now`, then
`bd dolt test`.

## Cold start

Endpoint down (`bd` fails fast with "auto-start is disabled"):

```bash
systemctl --user start beads-dolt-<repo>.service   # managed path
bd dolt start                                     # manual fallback — same config, same port
```

The unit survives reboot only with linger
(`loginctl enable-linger <user>`). Logs:
`journalctl --user -u beads-dolt-<repo>.service` (or
`.beads/dolt-server.log` for `bd dolt start`).

## Revert to embedded

```bash
node scripts/beads-dolt-server.ts uninstall        # unit + endpoint block gone
cd <repo> && mv .beads/dolt .beads/embeddeddolt
# metadata.json: dolt_mode → "embedded", drop dolt_server_host
# remove the dolt: block from .beads/config.yaml
```

`uninstall` leaves the store server-mode pointing at a dead endpoint —
the `mv` + metadata flip is what completes a real revert.
