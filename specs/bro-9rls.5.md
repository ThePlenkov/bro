# bro-9rls.5 — SSE `/api/v1/events/stream` + AsyncAPI

Milestone 5 of `specs/bro-9rls.1.md` — the events plane, live. SSE over
the local broker (`@broject/core` bus), not WebSocket: the stream is
server→client only, `Last-Event-ID` resume is native to the wire, and
no handshake layer exists.

## Routes

- `GET /api/v1/events/stream` — raw-stream route beside the agent-log
  follow leg (below the ServeResponse envelope — the response pipes
  for as long as the client stays and needs `Last-Event-ID` request
  headers `route()` never sees). Read-only: the loopback Host guard is
  the whole boundary — the stream leaks nothing `GET /api/v1/planes`
  doesn't already expose to a same-UID reader. No bus seam or a null
  socket → 503 JSON, never a hang; non-GET → 405.
- `GET /api/v1/events/asyncapi.json` — buffered route through
  `routePlane`; serves the generated AsyncAPI 3.x document. The doc is
  a projection of `EVENTS_TOPICS` in `planes/events.ts` — generated,
  not authored, so a doc/event drift is impossible by construction.

## Cursor + frames

`BusCursor {gen, seq}` renders `<gen>:<seq>` on the frame's `id:` line —
exactly what a browser EventSource echoes back on reconnect.

- cursorless → `since: 0` + `BUS_PROBE_LIMIT` ring tail, then live.
- `<gen>:<seq>` → replay after seq, then live (no tail cap — the ring
  window bounds it).
- foreign gen / window-evicted cursor / truncated catch-up → the
  broker's own `gap` frame, forwarded as `event: gap` — the client's
  cue to re-derive from the planes (the ring is a replay buffer,
  never the record).
- unparseable header → cursorless tail (the `bro bus --since`
  convention — absent means "from now", never a silent resume into
  the wrong seq space).

Domain envelopes emit **unnamed** frames — `id:` + `data:` only, the
topic inside the JSON — so a browser's `onmessage` catches every one.
`gap` is the lone named frame; the `/ui` page listens for it
explicitly. A 30s `: ka` comment keeps proxy timeouts honest.

## Dual-write

`bro notify`/watch drops keep landing in the mailbox (the postTool
drain is unchanged) AND mirror to the bus as a `topic: 'notify'`
envelope when a live broker accepts — inside
`mailboxEvents.publish`, fail-open (`busPublish` resolves
`published: false` on a dead broker; never a publish failure).

## Backpressure

Two hops, same rule: the broker drops a subscriber whose socket
exceeds `SLOW_CONSUMER_BYTES` (a `gap` precedes the next event); the
SSE route drops a client whose `res.writableLength` exceeds 1 MiB —
reconnect resumes through `Last-Event-ID`, gap-or-replay, never a lie.

## Tests

`packages/cli/src/planes/stream.test.ts` — cursor parse, fall-through,
405/503, cursorless tail opts, cursor resume opts, frame shapes
(unnamed envelope vs named gap), close propagation both ways,
subscribe-rejection. `serve.test.ts` — asyncapi.json 200/404/405.
