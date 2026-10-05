---
parent: bro-amn4
---

# bro-amn4.1 — hook perf telemetry: per-probe timings + `bro hooks perf`

## Problem

`bro hooks` costs are felt, not measured — observed 30s on
session-start, 38s on pre-compact, 23s on stop (repo checkout, real
run). The bus already knows every probe it runs (`collectLines`,
`stopGateContributions`) and bounds each at `PROBE_TIMEOUT_MS`, but
nothing records how long a probe actually took, which connector
produced it, or whether the sweep as a whole was the slow part. Until
timings exist, the async audit (bro-amn4.3) has no baseline and no
proof it helped.

## Design

A perf journal next to the existing trace journal —
`<git-common>/bro/hooks/perf/<session>.jsonl` — same lifecycle:
per-session file, locked append via `withFileLock`, bounded, pruned
on first write past `MARKER_TTL_MS`, fail-open (a journal error never
stalls the hook).

```text
{"ts":…,"event":"session-start","probe":"sessionStart","connector":"beads","ms":1820}
{"ts":…,"event":"session-start","probe":"parallelWork","connector":"act","ms":3900,"timedOut":true}
{"ts":…,"event":"stop","ms":23114,"probes":12}          ← sweep total row
```

- **Collection**: `collectLines`/`stopGateContributions` time each
  probe around `probeWithTimeout` and report rows through an optional
  `onProbe` callback — no return-type change (tests and callers keep
  compiling). `connectorHooks` yields `{name, hooks}` pairs so a row
  names its connector.
- **Total row**: the dispatcher writes one row per event with wall
  time + probe count — the number the user feels.
- **Read**: `bro hooks perf` aggregates the session's (or all of
  today's) journal — per `event×probe×connector`: count, avg, max —
  sorted by max desc; `--json` for the raw/aggregated object. This is
  a diagnostic surface, so it reads every perf file when no session
  is named.

## Plan

- [ ] `connectors.ts` — `connectorHooks` returns `{name, hooks}`
      pairs; `collectLines`/`stopGateContributions` accept `onProbe`
      and time each probe (ms, timedOut, failed)
- [ ] `hooks.ts` — `perfFile`/`journalPerf` (lock + bound + prune,
      fail-open), `onProbe` wired into the three sweeps, total row
      per event
- [ ] `bro hooks perf [--json]` — aggregate rows into
      event×probe×connector stats
- [ ] tests — journal writes on a hook run; perf read aggregates;
      connector names land in rows
- [ ] `skills/` — the perf surface documented where hooks already are
