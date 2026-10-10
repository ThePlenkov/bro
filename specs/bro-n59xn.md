# bro-n59xn — beads store on a managed dolt sql-server: embedded per-call times out under loop+drive+watch concurrency

## Problem

Every `bd` call pays embedded-dolt open+lock (~1s startup plus the
flock on `.beads/embeddeddolt/.lock`). Under loop+drive+watch the
orchestrator's own read planes become the load: `bd` calls ETIMEDOUT in
waves (`spawnSync bd ETIMEDOUT` across `bro watch` planes) while 7+
concurrent `bd show` processes queue behind the store lock. sverka
already runs the fix — a managed `dolt sql-server` endpoint
(`dolt.auto-start: false`, `gc.endpoint` markers in
`.beads/config.yaml`): `bd` hits a socket, not a file lock, and per-call
embedded startup disappears entirely.

## Design

Server-mode store, externally managed lifecycle. bd supports it
natively: `metadata.json` `dolt_mode: "server"` +
`dolt_server_host`, port pinned via `.beads/dolt-server.port` and the
nested `dolt:` block in `config.yaml` (`mode`, `host`, `port`,
`auto-start: false`). `dolt.auto-start: false` is the operative key —
with an unreachable endpoint `bd` fails fast ("Dolt server auto-start is
disabled") instead of spawning an unsupervised twin. The port file, not
`metadata.json`, carries the port (`dolt_server_port` is deprecated —
cross-project leakage).

- **Data** — `mv .beads/embeddeddolt .beads/dolt`. The server-mode data
  dir convention is `.beads/dolt/`; the embedded `<db>/.dolt` layout is
  identical underneath, so the move is a rename, not a conversion.
- **Endpoint** — `127.0.0.1:<port>` per store, pinned in
  `config.yaml` (`dolt.host`/`dolt.port`) and `dolt-server.port`.
  `dolt-server-config.yaml` is the server's own YAML (`listener`,
  `cfg_dir`) — the same file `bd dolt start` generates, so the manual
  fallback and the managed unit bind the same port.
- **Lifecycle** — `systemd --user` unit `beads-dolt-<repo>.service`
  (`Type=simple`, `Restart=on-failure`, `ExecStart=dolt sql-server
  --config <beads>/dolt-server-config.yaml`, cwd `.beads/dolt`) — the
  shape `bd dolt start` uses, but supervised and linger-persistent.
  `bd dolt start` remains the manual cold-start fallback.
- **Markers** — `gc.endpoint_origin` / `gc.endpoint_status` in
  `config.yaml`, same convention as sverka's `managed_city`: declares
  the endpoint externally managed and verified.
- **Installer** — `scripts/beads-dolt-server.ts` performs the whole
  move idempotently (`install`/`status`/`uninstall`) so cold start and
  other machines reproduce it: data-dir move, config/metadata writes,
  unit render + `systemctl --user enable --now`, `bd dolt test`.
- **Store-stamp cache** — `packages/learn` keys its lesson snapshot on
  `.beads/embeddeddolt/<db>/.dolt/noms/manifest`; a moved store yields
  no stamp and silently disables caching. Scan `.beads/dolt/` too —
  server-mode writes bump the same noms manifest.

## Plan

- [x] spec (this file)
- [x] `packages/learn/src/connector.ts` `storeStamp`: recognize
      `embeddeddolt/` and `dolt/` roots (+test)
- [x] `scripts/beads-dolt-server.ts` — install/status/uninstall
- [x] `site/content/docs/dolt-server.md` — cold-start runbook (+meta.json)
- [x] migrate the live `~/projects/bro/.beads` via the installer
      (dogfood), verify `bd` under concurrent load — 8 parallel
      `bd show` ≈1.5s total, `bro watch` planes all resolve

## Out of scope / approximations

- The `.beads/` dir is gitignored — config.yaml/metadata.json edits and
  the systemd unit are machine state, not PR content; the PR carries
  spec + installer + doc + the connector fix.
- `bd dolt stop` kills whatever the pid file names — under systemd that
  races `Restart=on-failure`; lifecycle is `systemctl --user` only.
- Rollback: `uninstall` removes the unit; reverting to embedded is a
  manual `mv dolt embeddeddolt` + metadata/config flip, documented in
  the site page — rare enough to not be a flag.
