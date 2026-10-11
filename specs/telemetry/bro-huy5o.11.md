---
parent: bro-huy5o.11
scope:
  - packages/cli/src/commands/trace.ts
  - packages/cli/src/commands/trace-config.ts
  - packages/cli/src/commands/trace.test.ts
  - packages/cli/src/commands/trace.e2e.test.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/plugins.ts
  - skills/trace/
  - specs/telemetry/bro-huy5o.11.md
---

# bro-huy5o.11 — OTLP export of the session trace journal

## Problem

The hooks layer already journals every post-tool event per session —
`<git-common>/bro/hooks/trace/<session>.jsonl`, one line
`{ts, tool, command?, paths?, ok?}` per landing. That record answers
"what did this session do", but only for bro's own consumers (the learn
matcher). Operators running Langfuse, Phoenix, or any OTLP backend get
nothing: no span waterfall per session, no time-cost rollups, no
per-bead attribution across a fleet.

## Design

- **`bro trace export`** — a new `fleet`-group plugin, one verb:
  `export [--session <id>] [--dry-run] [--json]`. Reads the trace
  journals, maps each unexported line to an OTLP span, POSTs them to
  the configured endpoint over OTLP/HTTP-JSON (`<endpoint>/v1/traces`).
  Cursor `trace/.export.json` records lines-already-sent per journal so
  repeat runs send only the delta (span ids are content hashes, so a
  resend dedups server-side anyway).
- **Off by default.** Export runs only when an endpoint resolves:
  `telemetry.otlp.endpoint` in config, or the standard env names
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
  (env wins — same rule as `BRO_GLOBAL_BEADS`). `OTEL_EXPORTER_OTLP_HEADERS`
  and `OTEL_SERVICE_NAME` merge the same way. `BRO_TELEMETRY=0` is the
  kill switch — same contract as the command journal.
- **Live flush, never a stall.** With an endpoint configured,
  `emitPostTool` throttles a detached `bro trace export` respawn (same
  argv[1]+execPath pattern as `post-merge-run`) at most once per
  `telemetry.otlp.flushMs` (default 60s). The network POST happens in
  the child — a dead collector, a wedged DNS, or a 5xx can only lose
  spans, never stall or fail the hook. Manual `bro trace export` is
  the same code path run synchronously — a failure there is an honest
  exit 1, not silence.
- **Span shape.** One traceId per session file (md5 of the journal
  name); each line → one span named `bro.<tool>`; duration is the gap
  to the next entry's `ts` (last entry: zero). Fields the journal line
  carries become `bro.*` attributes verbatim (`command`, `paths`,
  `ok`, `bead`, `agent`, and any future numeric token/cost fields) —
  the exporter forwards, it never invents. `ok:false` sets the span
  status ERROR. Resource carries `service.name`, `service.version`,
  `bro.repo`.
- **Bead/molecule attribution.** `journalTrace` now stamps
  `BRO_BEAD_ID`/`BRO_AGENT_ID` env pins into the entry when the spawn
  pinned them — loop/convoy workers carry both, so fleet work
  attributes to its bead while interactive sessions simply omit the
  field (absent fields stay absent, same rule as `paths`).

## Non-goals

- No OTLP/gRPC or protobuf — the exporter speaks OTLP/HTTP JSON only
  (all of Langfuse, Phoenix, Jaeger, and the collector accept it).
- No metrics/logs signals — `/v1/traces` is the whole surface.
- No retry queue — the cursor is at-least-once via the journal itself;
  a failed POST just leaves the cursor behind for the next flush.
- Session identity stays the sanitized journal name — backends that
  need the raw id get it via the `bro.session` attribute on each span.
