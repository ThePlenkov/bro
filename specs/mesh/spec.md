---
parent: project
---

# mesh — inter-rig work federation protocol

## Scope

The wire contract that lets sovereign agent rigs request work from each
other. A **rig** is any project workspace run by an orchestrator — a bro
instance, a wasteland rig, a gascity/gastown crew, paseo, cao — anything
that can read and write a work store.

The spec is **vendor-neutral**: it defines the envelope, the lifecycle,
and the transport bindings. bro ships the reference implementation; every
other orchestrator joins by writing a conformant connector. Wasteland is
one such transport, not the model.

## Non-goals (v1)

- Marketplace semantics — no bidding, pricing, or SLA negotiation.
- Reputation scoring — derivable later from accepted history; wasteland
  already models validated completions for public rigs.
- Encryption/identity proofs — v1 trusts the transport's access control
  (you only see requests from peers you subscribed to).
- Streaming/progress — a request is a document, not a session.

## Design

### Identity

A rig is named by URI, mirroring the upstream beads scheme:

```text
mesh://<org>/<repo>          e.g. mesh://sverka-dev/sverka
```

Each rig commits a descriptor at its repo root (`.town.json` precedent):

```json
{
  "rig": "mesh://sverka-dev/sverka",
  "orchestrator": "bro@0.2",
  "accepts": ["request"],
  "inbox": "beads"
}
```

### Envelope (`mesh/1`)

A work request is a record; in beads-backed transports it **is** a bead
(envelope fields carried as labels/`external_ref` — no new storage type).

```json
{
  "v": "mesh/1",
  "id": "req-…",
  "kind": "request | claim | result | accept | reject",
  "thread": "req-…",
  "from": "mesh://sverka-dev/sverka",
  "to": "mesh://ThePlenkov/bro",
  "title": "…",
  "body": "…",
  "refs": [{ "kind": "bead | url | pr", "ref": "sv-yvkl" }],
  "terms": { "priority": "p2", "deadline": null },
  "evidence": []
}
```

All lifecycle messages share one `thread` — the request id.

### Lifecycle

```text
posted → claimed → submitted → accepted
                   │            └ rejected → (requester may re-post)
                   └ (abandoned claim → requester re-posts)
```

- **posted** — requester publishes the envelope on *its own* store.
- **claimed** — target rig binds itself to the thread.
- **submitted** — target attaches evidence refs (PR, commit, bead).
- **accepted** — requester's verdict; completion is never self-declared.

### Transports — the plugin seam

| Binding        | Model | When |
|----------------|-------|------|
| `local`        | `bd create` in a known same-machine checkout | dev workstation, today's manual flow |
| `beads-remote` | **read federation**: subscribe to peer `refs/dolt/data` over the repo's own git remote; inbound = beads addressed to my rig | the mesh default |
| `wasteland`    | adapter over `wl-commons` wanted board | public rigs, reputation |
| `github`       | issue transport, body carries the envelope | repos without federation access |

**Sovereignty rule:** no transport ever writes a foreign store.
`beads-remote` requests sit on the requester's remote and are *pulled* —
the same fork-and-propose model wasteland proves, minus the mandatory
commons hub.

### Discovery

- `bro.config.json` — `mesh.peers`: `{ rig, remote }` static entries.
- Any commons/registry (wasteland rig registry) can act as a *public*
  directory later; private meshes need only static config.

### Trust (v1)

- Inbox = peers you subscribed to → spam resistance is the peer list.
- **Provenance is the transport, not the envelope.** `from` is an
  advisory field for display; the authenticated origin of a request is
  the peer binding it arrived over (the `mesh.peers` remote name). A
  conformant implementation keys inbound requests by *which remote
  fetched them*, never by the claimed `from`, and flags a request whose
  `from` disagrees with that peer's declared rig URI rather than
  silently trusting either.
- Acceptance requires the requester's `accept` → the requester owns
  quality; the worker owns delivery.
- Evidence refs are advisory in v1; structured verdicts come as features.

## bro MVP

- `bro mesh peers add|list` — manage `mesh.peers`.
- `bro mesh request <rig> <title>` — publish an envelope (`local` or
  `beads-remote`), wire `bd dep add <waiting-bead> external:<rig>:<id>`.
- `bro mesh inbox` — surface requests addressed to me across peers.
- `bro mesh claim|done|accept <thread>` — lifecycle transitions.
- `bro mesh wait <thread>` — point-check watcher (act wait pattern).

Out of MVP: wasteland adapter, reputation, `github` transport polish.

## Owns

```text
packages/mesh/                  envelope schema, lifecycle, connectors
packages/cli/src/commands/mesh.ts
skills/mesh/
```

## Alternatives

- **Direct foreign-store writes** — rejected: needs write access, breaks
  sovereignty; wasteland's PR-mode exists precisely because pull wins.
- **Central server** — rejected: defeats decentralization; a DoltHub
  commons stays *optional* transport for public meshes.
- **Embed wasteland SDK as core** — rejected: couples v1 to DoltHub;
  wasteland is a conformant adapter instead.

## Related

- bro-5nnj — bilateral request protocol (phase 1 of this).
- bro-5eaa — bro mesh epic (this spec is its design record).
- gastown wasteland — prior art: wanted board, sovereign forks, PR-mode.
