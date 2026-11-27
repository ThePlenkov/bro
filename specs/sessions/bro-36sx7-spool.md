# bro-36sx7.11 — hook start/end spool

Status: draft. Parent epic: `bro-36sx7` (hooks perf). Unblocks `bro-izpyk.1`.

## Problem

When a host agent kills a hook at its timeout (~10 s), nothing is recorded:
the Node perf row is never flushed and `run.sh` dies with it. We cannot tell
where bro runs, how long hooks take on real agents, or how often hosts kill
them. Every perf claim so far is synthetic.

## Contract

`hooks/run.sh` appends one line before it launches a bro candidate and one
line after the launch returns. A `start` without a matching `end` means the
host killed the launcher.

- Path: `${BRO_HOOK_SPOOL:-${XDG_STATE_HOME:-$HOME/.local/state}/bro/hooks.spool}`.
  One file per machine, shared by all hosts and projects.
- `BRO_HOOK_SPOOL=0` disables writing.
- Each line is a single `printf` append (< PIPE_BUF, so atomic with
  `O_APPEND`). Write failures are ignored; the hook never fails or waits
  because of the spool.
- No extra processes on the hook path. Use shell builtins only, plus the
  `date +%s` that `run.sh` already runs for `BRO_HOOK_T0` (and one more for
  `end`).
- Early Tier-0 exits that never launch bro write nothing.

### Line format (v1, tab-separated)

```text
v1  <ts>  start  <id>  <host>  <event>  <cwd>
v1  <ts>  end    <id>  <host>  <event>  <rc>  <outcome>  <cwd>
```

- `ts`: unix seconds.
- `id`: `<launcher pid>-<BRO_HOOK_T0>`.
- `host`: `cursor` | `devin` | `claude` | the client the launcher already
  knows | `unknown`.
- `outcome`: `ok` (rc 0) | `nonzero` (all candidates failed fast) |
  `watchdog` (`RUN_BOUNDED_EXPIRED=1`) | `no-cli` (no candidate found).
  `no-cli` is written as an `end` line with no preceding `start`.
- `cwd` is last. Readers split on the first 8 (or 6) tabs, so a tab inside
  `cwd` stays in `cwd`. Unparseable lines are skipped.

## Rotation

The Node hook process (not the shell) rotates the spool after dispatch:
if `stat` shows it larger than 1 MiB, rename it to `hooks.spool.1`, replacing
any existing `.1`. One `statSync` per hook; fail-open.

## Reader: `bro hooks status`

`bro hooks status [--since <dur>] [--json]` (default `--since 24h`). It reads
`hooks.spool` and `hooks.spool.1`, pairs lines by `id`, and prints rows per
`host × event`:

- count, p50 and p95 duration (`end.ts - start.ts`);
- outcome counts: `ok`, `nonzero`, `watchdog`, `no-cli`;
- `killed`: a `start` with no `end`, older than
  `BRO_HOOK_WATCHDOG_S + 5` s, so hooks still running are not counted.

`--json` emits the same rows as an array. An empty or missing spool prints
"no hook runs recorded" and exits 0.

## Out of scope

SQLite ledger, lazy worker, fleet sessions (`bro-izpyk.*`), `.4`, `.7`, `.9`,
`.10`, `.12`.

## Tests

- dash and bash: an `ok` run writes start+end with the same id; a run killed
  by the watchdog writes `outcome=watchdog`; a quick non-zero run writes
  `nonzero`; with no CLI a single `no-cli` end line is written.
- A launcher killed with `kill -KILL` mid-run leaves a start without an end,
  and `bro hooks status` reports it as `killed` once it is older than the
  threshold.
- `BRO_HOOK_SPOOL=0` writes nothing. An unwritable spool path still exits 0
  with unchanged stdout.
- Rotation at > 1 MiB; the reader merges `.1`.
- Reader: a tab inside cwd and garbage lines are tolerated; p50/p95 are
  correct on a fixed fixture.
