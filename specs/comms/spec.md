---
parent: project
---

# comms — agent event bus: publish/subscribe between sessions

## Scope

`bro bus` is the transport under agent communication: a local broker
process on a Unix socket, topics with subscriber-side filters, one-to-many
and many-to-many fan-out, monotonic `seq` cursors, and a bounded replay
ring that replays retained history and reports a gap when requested
events are unavailable.

Reactivity is delivered by pushing onto what bro already owns — the
`postTool` probe drain point (`packages/cli/src/commands/hooks.ts`) — not
by waking a model. Nothing here may stall a session: the broker is
optional infrastructure; publish, probe, and status fail open, while
subscribe reports errors.

## Owns

```text
packages/core/src/bus.ts       broker, client, envelope, filters, ring
packages/cli/src/commands/bus.ts   serve / publish / subscribe / status
skills/bus/
```
