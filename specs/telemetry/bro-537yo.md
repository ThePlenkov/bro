---
parent: bro-537yo
scope:
  - packages/cli/src/index.ts
  - packages/cli/src/plugins.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/commands/telemetry.e2e.test.ts
  - specs/telemetry/bro-537yo.md
---

# bro-537yo — command-level telemetry + a discoverable `bro telemetry` report

## Problem

Hook probes already journal per-connector timings into
`<git-common>/bro/hooks/perf/<session>.jsonl` (`probeReporter` +
`flushPerf`), and `bro hooks perf` renders the rollup — but the command
is buried under a hidden namespace and the journal only sees hook
events. Nothing measures `bro` commands themselves, so a slow `bd` call
inside `bro act status` or a wedged `bro debt collect` leaves no record
— the operator sees "the CLI hung" with no data.

Evidence that drove this: a session's Stop hook burned ~6.4s wall
(beads probe 3s, drill 1.8s, act 1.2s — parallel, so ~max+overhead) and
`bro hooks perf` showed session-start probes averaging 3–4s with
33–89% probe-timeout rates — invisible until someone greps a file.

## Design

- **command journal** — `<git-common>/bro/hooks/perf/commands.jsonl`,
  same `PerfRow` shape as hook rows: `{ts, event:'cmd', probe:'run',
  connector:'<cmd>', ms, failed?: true}`. `connector` carries the
  command name (`argv[2]`, plus the first non-flag positional —
  `act status` splits from `act threads`). `failed` = nonzero exit —
  it lands in the report's `bad:` count.
- **dispatch timing** — `index.ts` stamps `t0` at entry and registers
  `process.on('exit', code => journalCommand(...))`. `on('exit')` is
  the only hook that sees every termination path — plugins end via
  `process.exit()`, never a return/finally.
- **cheap by contract** — one sync `git rev-parse --git-common-dir` +
  one locked append at exit (~10–20ms). Skipped for meta commands
  (`--version`, `-h`, no cmd) and under `BRO_TELEMETRY=0`. The write
  is wrapped fail-open — telemetry must never change an exit code.
- **`bro telemetry`** — a visible plugin alias over the existing
  `bro hooks perf` report (`--json`, `--session` pass through). The
  report picks `commands.jsonl` up automatically — `readPerfRows`
  globs `perf/*.jsonl`, and `event:'cmd'` rows aggregate as
  `cmd run <name>` probe lines.

## Non-goals

- No cross-session or cross-repo aggregation yet (per-repo rollup is
  what `bro hooks perf` already does).
- No per-subcall timing inside commands (bd/git/gh internals) — the
  connector-probe layer already bounds hook probes; deeper tracing is
  its own bead once this data lands.
- Commands run outside a git repo journal nothing (same contract as
  the hook perf journal).
