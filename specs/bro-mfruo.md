# bro-mfruo — conductor: hard-denied acp client methods are load-bearing assumptions — guard or document

## Problem

The conductor's pooled ACP client (`acpOpen`) and the one-shot ops client
(`withAcp` — judge/chat/models calls) register exactly one agent→client
handler: `session/request_permission`, answered by a silent default-deny.
Every other client method a peer could call — `fs/read_text_file`,
`fs/write_text_file` (both advertised `false` at initialize),
`elicitation/create`, `mcp/message` — is unhandled, so the SDK answers
`method-not-found` without a trace. (`terminal/*` is genuinely served:
`AcpTerminals` registers real handlers and `clientCapabilities.terminal`
is `true`.)

This is safe only while every pooled agent runs a non-interactive
permission mode — the pin rides on `providers.<name>.command` or the
spawned env (e.g. `--permission-mode dangerous`,
`DEVIN_PERMISSION_MODE=dangerous`). If that pin drifts, every write/exec
the agent attempts prompts `session/request_permission`, gets denied, and
the agent stalls or fails with permission-denied — a config trap that
reads like an agent bug. Same shape for unadvertised methods: an
`elicitation/create` call hits method-not-found and only the agent's own
error text remains.

The fleet worker lane already solved this (`acp-worker.ts`): its
permission handler LOGS the denial and names the opt-in, and registered
loggers answer method-not-found for unadvertised calls. The
pooled/one-shot client has neither.

## Design

Guard, not document — option (b) of the bead: a denied or unserved
agent→client call announces itself. One `wiredClient(terminals, by)`
helper builds the client registration shared by `withAcp` and `acpOpen`:

- `session/request_permission` → the same default-deny (reject option
  when offered, else cancel), preceded by `deniedCall` — one stderr line
  for whoever tails the process plus an `acp.denied_call` otel/journal
  row naming `by`, the method, and what was asked.
- `fs/read_text_file`, `fs/write_text_file`, `elicitation/create`,
  `mcp/message` → the same announcement, then
  `RequestError.methodNotFound` — capability honesty beats partial
  emulation (the same rule `acp-worker.ts` encodes in
  `UNADVERTISED_METHODS`, minus `terminal/*`, which `AcpTerminals`
  serves here).

The hint names the trap, not one agent's knob — and it is
permission-ask-specific: "the agent is prompting — its non-interactive
pin is missing from the provider command/env". Per-agent env names rot;
the operator reading `conductor:<backend>` knows which
`providers.<name>` entry to inspect. An unserved call gets a different
why — "never advertised by this client — method-not-found by design" —
because blaming the pin there sends the operator to the wrong config.

## Plan

- [x] acp.ts: `denyPermission(by)` announces via `deniedCall`;
  `wiredClient` registers it plus the unserved-method guards;
  `withAcp` and `pooledClientApp`'s unbridged branch (the `acpOpen`
  path) use it — a bridged link forwards client-bound calls to the
  real client, whose answer is already the honest one
- [x] testkit: `probeClient` (bro-ymbq1) already scripts an arbitrary
  agent→client request mid-prompt — the unserved-call test rides it,
  no new testkit surface needed
- [x] acp.test.ts: pooled-path deny announces + denies; an unserved
  method answers method-not-found and journals `acp.denied_call`
- [x] `npm test` in packages/providers (149 tests) + `tsc --noEmit`
