---
parent: project
---

# comms — agent event bus: publish/subscribe between sessions

## Scope

`bro bus` is the transport under agent communication: a local broker
process on a Unix socket, topics with subscriber-side filters, one-to-many
and many-to-many fan-out, run-scoped `{gen, seq}` cursors, and a bounded replay
ring that replays retained history and reports a gap when requested
events are unavailable.

Reactivity is delivered by pushing onto what bro already owns — the
`postTool` probe drain point (`packages/cli/src/commands/hooks.ts`) — not
by waking a model. Nothing here may stall a session: the broker is
optional infrastructure; publish, probe, and status fail open, while
subscribe reports errors.

## Owns

```text
packages/core/src/bus.ts       broker, client, cursors, retention window
packages/core/src/events.ts   the event contract itself (the `events` facade)
packages/cli/src/commands/bus.ts   serve / publish / subscribe / status
skills/bus/
```

The envelope and the filter shape are `events.ts`'s, not `bus.ts`'s: the
bus is one provider of the `events` capability, so the contract is named
by domain and lives above the transport. `bus.ts` keeps only what the
transport owns — the socket, the framing, `{gen, seq}` cursors and the
ring — and narrows the facade's envelope to a `BusRecord`.
