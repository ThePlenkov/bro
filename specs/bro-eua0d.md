# bro-eua0d — conductor-side acp terminal surface

bro-z7afs landed the terminal *plane*: `acpInit` declares
`clientCapabilities.terminal: true`, every `acpOpen`/`withAcp` link
registers an `AcpTerminals` registry, and agent `terminal/*` requests
run as host-side children of `bro serve` (packages/providers/src/
acp-terminal.ts). What it did not ship is the *surface* — the registry
rides the link privately, so an operator (or the web UI) cannot see
what the agent's shells are doing. This bead exposes it on the
conductor path, where the long-lived pooled ACP link lives.

## Wire contract (inherited from bro-z7afs / the sdk schema)

Agent→client requests, all `{sessionId, terminalId?…}`:
`terminal/create` `{command, args?, env?: [{name,value}], cwd?,
outputByteLimit?}` → `{terminalId}`; `terminal/output` → `{output,
truncated, exitStatus?}`; `terminal/wait_for_exit` → `{exitCode,
signal}`; `terminal/release` / `terminal/kill` → `{}`.

## Design

- `AcpTerminals` gains the observer surface on top of the landed
  registry — no second implementation:
  - `snapshot(id)` — the `terminal/output` wire shape (`{output,
    truncated, exitStatus}`), also the serve route's plain-GET answer.
  - `follow(id, listener)` — atomic snapshot+subscribe: the returned
    snapshot IS the buffer at registration, live `data` taps fire per
    appended chunk through a per-entry `StringDecoder` (a multi-byte
    character split across pipe chunks never surfaces as U+FFFD), and
    `exit` fires once when the entry completes. A completed terminal
    still follows — snapshot carries the verdict, no callbacks.
    `stop()` drops the taps without touching the terminal. Observer
    taps are guarded: a throwing follower is the consumer's bug.
  - `size` — live count for debug surfaces.
- `AcpPeer.terminals` exposes the link's registry; `acpOpen` returns
  it. `close()` disposes it and a transport abort calls `close()`, so
  the registry (and its children) die with the link.
- `conductorProxy` returns a callable `ConductorProxy` —
  `(req,res)=>…` plus `terminals(): AcpTerminals | undefined` reading
  the pooled `live` peer: undefined before the first link and after a
  transport death, live in between.
- `bro serve` answers `GET /api/v1/terminals/<id>/output` — the
  agent-log route's twin:
  - Bearer `Authorization` or `?token=` against the serve session
    token; 401 otherwise (output can carry secrets — loopback alone
    is not the boundary). Non-GET → 405; unknown id or no conductor
    registry → 404.
  - Plain GET → `200 {output, truncated, exitStatus}` JSON.
  - `?follow` → `text/event-stream`: the snapshot lands as `data:`
    frames, live appends stream, the terminal's completion emits
    `event: exit` carrying the status JSON; an already-final terminal
    emits snapshot + exit immediately. Client disconnect drops the
    taps via `follow.stop()`.
  - `ServeDeps.terminals` is the seam; `realDeps` plugs in
    `conductor.terminals` — a non-conductor serve (byte-proxy or
    none) reports the honest 404.
- `AcpTerminals`, `TerminalFollow`, `TerminalFollower` export through
  `@broject/providers`.

## Verify

- Registry: `follow` returns the atomic snapshot then live data +
  exit; a completed terminal follows with no callbacks; unknown ids
  fail loud; `size` tracks creates.
- Conductor: `proxy.terminals()` is undefined pre-link, the live
  registry post-link — a `terminal/create` through it round-trips a
  real `echo`.
- Serve route over a real socket: 401 unauthenticated / wrong token,
  405 non-GET, 404 unknown id and 404 on a no-registry serve; plain
  GET answers the wire shape; `?follow` streams snapshot → live data
  → `event: exit`; an already-final terminal emits both immediately.

## Exit criteria

While an acp turn's agent runs exec, `GET
/api/v1/terminals/<id>/output` returns live content — final content +
exitCode after; `?follow` streams it end to end. `npm run typecheck`
and `tsx --test` green.
