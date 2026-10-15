---
title: Mesh — rig-to-rig work federation
description: The vendor-neutral envelope that lets sovereign agent rigs request work from each other — a request to a foreign rig, never a patch in its tree.
---

A **rig** is any project workspace run by an orchestrator — a bro
instance, a gascity crew, anything that can read and write a work
store. Mesh is the third adapter axis: providers carry calls *into*
model services, planes expose rig state *out* to clients, and mesh
moves work *between* rigs.

The rule that defines it: **foreign findings become requests, never
patches.** A rig that spots work in another repo posts an envelope to
its peer; the peer's `bro mesh inbox` decides. Nobody edits a tree
they don't own.

## Envelope (`mesh/1`)

A request is a record, not a session. `to` must be a non-empty rig URI
(`mesh://<org>/<repo>`) — an absent or wildcard recipient is malformed,
never a broadcast. Lifecycle messages (`request → claim → result`, or
`accept`/`reject`) share one `thread` — the request id.

On beads-backed transports the envelope *is* a bead: `v`/`kind`/
`thread`/`from`/`to` ride `mesh:<field>:<v>` labels, title and body are
the bead's own fields, and no new storage type exists. The envelope
never leaves the requester's store — the peer reads it through a peer
binding (`beads-remote` pulls the dolt replica, `local` reads the
checkout read-only).

## What a request earns

- An `external:<rig>:<id>` edge on the local bead — a marker, not a
  gate: the store doesn't resolve foreign deps, so `bd ready` still
  lists the bead.
- `bro mesh wait <id>` — a point check between turns, never a blocker.

v1 deliberately excludes marketplace semantics, reputation scoring,
and encryption — the transport's access control is the trust boundary;
you only see requests from peers you subscribed to.

**Sources:** `specs/mesh/spec.md`, `specs/cross-repo/` (request/wait
surface), the mesh skill.
