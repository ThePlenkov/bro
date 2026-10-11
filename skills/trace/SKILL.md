---
name: trace
description: "Use when an operator wants the session trace journals in an OTel backend — 'send traces to Langfuse/Phoenix', cost attribution per bead/molecule, or debugging a missing OTLP export. Thin wrapper over the bro CLI: `bro trace export` pushes unexported journal lines as OTLP/HTTP-JSON spans. Requires `bro` (npx -y @broject/bro@0)."
---

# /trace (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`.

## What it is

The hooks layer journals every post-tool event per session to
`<git-common>/bro/hooks/trace/<session>.jsonl`. `bro trace export`
pushes the unexported tail of those journals to an OTLP endpoint over
OTLP/HTTP JSON (`POST <endpoint>/v1/traces`) — one trace per session,
one span per journal line, journal fields as `bro.*` attributes. A
cursor in `trace/.export.json` makes repeat exports send only the
delta; span ids are content hashes, so resends dedup server-side.

| Command | What it does |
| ------- | ------------ |
| `bro trace export` | Push all journals' new lines as spans |
| `bro trace export --session <id>` | Push one session's journal only |
| `bro trace export --dry-run` | Print the request payload, POST nothing |
| `bro trace export --json` | Machine-readable summary (+ last error) |

## Policy

- **Off until an endpoint resolves.** Export does nothing without
  `telemetry.otlp.endpoint` in bro.config.* or the standard env names
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
  (env wins). `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`) and
  `OTEL_SERVICE_NAME` merge the same way. `BRO_TELEMETRY=0` kills it
  unconditionally — the same switch as the command journal.
- **The agent never waits on it.** With an endpoint set, the post-tool
  hook respawns `bro trace export` detached at most once per
  `telemetry.otlp.flushMs` (default 60s). A dead collector, DNS
  failure, or 5xx loses that batch only — the cursor's `lastError` is
  the only record, the hook path stays silent by contract.
- **Failures are cursor state, not exits.** A failed POST leaves the
  cursor behind — the next flush resends (at-least-once). `bro trace
  export --json` surfaces `lastError`/`lastErrorAt`; the manual verb
  exits nonzero so an operator run is honest.
- **Attribution is what's journaled.** Spans carry `bro.session` plus
  whatever fields the line recorded — `bead`/`agent` appear when the
  session ran under bro's spawn pins (loop/convoy workers); a field
  absent from the journal simply isn't an attribute.
