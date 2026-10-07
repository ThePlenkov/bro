---
name: mesh
description: "Use when federating work between bro rigs — mesh:// identity, peer bindings over local checkouts or beads-remote dolt replicas, the request → claim → done → accept/reject lifecycle, and `bro mesh inbox|wait`. Thin wrapper over `bro mesh` — mechanics live in the CLI (spec: specs/mesh/spec.md)."
---

# /mesh (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

A rig is `mesh://<org>/<repo>` — derived from origin or pinned in
`mesh.rig`. Work crosses rigs as `mesh/1` envelopes: plain beads with a
`mesh:` label set, written **only** to the sender's own beads store.
There is no write path to a foreign store — peers pull each other's
`refs/dolt/data` into read-only replicas. Sovereignty is structural,
not policy.

## The lifecycle

```text
requester                          worker
   │  request (own store)             │
   │ ───────────────────────────────► │ pull → inbox
   │                            claim │ → to: requester
   │                             done │ → to: requester (+evidence)
   │ ◄─────────────────────────────── │
 accept│reject (verdict, terminal)    │
```

Both verdicts are **terminal** — a rejected thread is done, not a
resubmission queue. A revised result is a new `request` thread.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro mesh me` | this rig's URI — `mesh.rig` pin or origin-derived (exit 2 when unresolvable) |
| `bro mesh peers add <alias> <rig> <remote>` | bind a peer: fs path = `local` (live store via `bd -C`), git URL = `beads-remote` (dolt replica) |
| `bro mesh peers list` / `remove` | inspect / drop bindings |
| `bro mesh pull` | refresh every beads-remote replica |
| `bro mesh inbox [--json] [--no-pull]` | requests addressed to this rig, with provenance + mismatch flags |
| `bro mesh request <rig> <title> [--for BEAD]` | post a request; `--for` blocks a local bead on `external:<rig>:<id>` |
| `bro mesh claim <thread>` | worker verb — bind this rig to the thread |
| `bro mesh done <thread> [--ev K:R]…` | worker verb — submit result + evidence refs |
| `bro mesh accept\|reject <thread> [--body T]` | requester verdicts on a submitted result |
| `bro mesh wait <thread> [--json] [--no-pull]` | point check: stage + whose move it is — never a blocking wait |

## Trust model

- **The peer binding is provenance.** A record read from alias `x`'s
  replica counts as from `x`'s declared rig. The envelope's `from` is
  display metadata — `inbox` flags `mismatch` when they disagree, and
  replies resolve through the binding, never the claim.
- **Reads are read-only.** `local` peers are queried via `bd -C list`;
  `beads-remote` peers are `dolt clone`/`pull` replicas under
  `<git-common>/bro/mesh/peers/<alias>`, queried via `dolt sql`. The
  mesh layer never merges a replica into the live store and never
  writes to a peer remote.

## Policy

- `--no-pull` on `inbox`/`wait` reads replicas as-synced — use it in
  hot loops; plain `pull` is the sync point.
- A peer that fails to sync is an **error line**, never a silent
  empty — treat `! alias: …` output as signal, not noise.
- `bro mesh wait` is a point check. For supervision loops use the
  `bro act wait` pattern (armed watcher), not a shell `while` spin.


Exit code: 0