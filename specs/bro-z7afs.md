# bro-z7afs — acp client: terminal/* capability so agent shells are host-visible

## Problem

bro's ACP client (`packages/providers/src/acp.ts`) declares
`clientCapabilities.terminal: false` at initialize (acp.ts:291) and registers
only `session/request_permission → denyPermission`. An agent driven over ACP
(Devin CLI, Claude Code, kilo) therefore cannot create host-side terminals:
its exec/background shells run inside the agent process and surface only as
opaque tool_call text — or nothing. Owner report 2026-10-16: in the bro host,
agent background tasks are invisible end-to-end while the same work under
Zed renders as live terminals.

The protocol pieces all exist: `@agentclientprotocol/sdk` exposes
`CLIENT_METHODS.terminal_{create,output,release,kill,wait_for_exit}` through
`client().onRequest(...)`; agents (devin binary verified) emit the calls when
the capability is true. Missing: bro-side handlers and the flag.

## Design

New module `packages/providers/src/acp-terminal.ts` — an `AcpTerminals`
registry scoped to one connection:

- `terminal/create` → spawn `command + args` — verbatim argv when `args`
  is non-empty; a lone `command` line (devin puts the whole shell string
  in `command` with no args) runs through `sh -c` — execve of it is
  always ENOENT, which is how invisible tasks happened,
  `cwd`/`env` applied over `process.env` (agent env names on a security
  denylist — `PATH`, `LD_*`, `NODE_OPTIONS`, … — are dropped); capture
  stdout+stderr interleaved into a byte-bounded buffer (`outputByteLimit`
  honored in bytes, truncate from the front on a UTF-8 boundary — never a
  partial character); returns `{ terminalId }`.
- `terminal/output` → `{ output, truncated, exitStatus? }` immediately.
- `terminal/wait_for_exit` → resolve once the exit status is in AND output
  is final ('close', or 'exit' + orphan grace) with `TerminalExitStatus`
  (`exitCode`/`signal`).
- `terminal/kill` → SIGTERM the child, terminal stays valid (per spec:
  output retrievable after kill).
- `terminal/release` → kill if running, drop the entry (pending waiters
  resolve with the real status); id invalid after.
- Unknown `terminalId` → throw (surfaces as a wire error, never silent).
- `dispose()` — kill every live child; wired to `close()` AND the
  transport's abort signal so leaked terminals die with the connection
  even when the caller only drops its peer refs.

Wire-up in `acp.ts`: both `client({ name: 'bro' })` callsites (`withAcp`,
`acpOpen`) chain the five `onRequest` handlers onto one registry instance per
connection; `clientCapabilities.terminal: true`.

## Not in scope

- Rendering terminal content in the conductor SSE stream — `bro-728wl`
  owns `serve-conductor.ts`; this PR makes the terminal plane real so its
  tool_call forwarding has something to resolve.
- `fs/*` capabilities — stay false.

## Verify

- `acp.test.ts`: fake agent calls `terminal/create` mid-prompt for
  `sh -c 'echo …'`, reads `terminal/output`, awaits `wait_for_exit`,
  releases — asserts output text, `exitCode: 0`, and that post-release
  output reads error.
- Registry unit coverage: byte-limit truncation, kill-then-output,
  dispose kills live children.
- Live check (manual): `devin --acp` peer under `acpClient`, prompt it to
  run a background command, observe `terminal/create` arrive and output
  pollable while the process runs.
