# bro-5nnj.1 — `bro request`: same-machine delivery into the target's own store

`bro mesh request` makes the requester carry the work: the request bead
lives on the requester's store and the target pulls it through a peer
binding. On one machine that indirection is pure cost — two checkouts
of reachable stores should not need a replica round-trip for a bead to
exist. `bro request <repo-or-alias> <title>` is the local phase of the
cross-repo spec (specs/cross-repo/bro-oam4.md): deliver the request
bead directly into the target checkout's store, anchored there, with
the same mesh/1 envelope contract a pulled request would carry.

## Change

**`packages/mesh/src/request.ts`** — `resolveTarget(dir, arg)` walks the
spec's precedence: `mesh.peers` alias → literal `mesh://org/repo` →
explicit path (contains `/`, `.`, `..`) → local peer remote basename →
sibling checkout (`<name>` beats `<name>--*`; multiple `--` siblings
without a bare dir are ambiguous → exit 2 listing candidates; the
sibling must contain `.beads/`). The target rig resolves exactly like
`bro mesh me` — `mesh.rig` pin first, origin derivation otherwise;
unresolvable exits 2 with "target rig is unaddressed". `.bro-rig.json`
may warn on disagreement, never overrides.

`deliverRequest` creates the bead in the target store via
`postEnvelope` with `beadRig` = the target rig (`external_ref` names
the store's owner, not the requester) and `extraLabels` carrying
`export:<id>` — interpolated after creation since the id is not known
until then. The created bead id is the thread id.

**`postEnvelope`** gains `extraLabels?: string[]` (interpolated
`{id}` post-create) and `beadRig?: string` (overrides `external_ref`'s
default `from`).

**`selfRig(dir)`** hoists from `mesh.ts` into `mesh/src/identity.ts` —
one identity resolution for `bro mesh me` and `bro request`.

**`meshInbox`** scans the own store in addition to peers; own-store
requests surface as `peer: 'self'` with `unbound: true` when their
`from` matches no configured peer. Peer records carry `transport` so
local peers admit envelopes authored by the current rig too — direct
delivery carries the requester's `from`, not the binding rig's.

**`meshThread`** records `requestPeer` (the anchor), admits local-peer
records when `from` is the binding rig OR the current rig, drops and
flags any other, and reads closed rows from local peers so a closed
request anchor stays visible to `bro mesh wait`.

**`bro mesh` lifecycle verbs** — claim/done/accept/reject resolve the
anchor store (`requestPeer` local peer → that checkout, else own) and
write there. `done` closes the request bead first, then runs
`bd ship <thread>` in the anchor store — never `--force`; on failure it
warns that the result posted but the capability did not ship.

**`bro request <repo-or-alias> <title>`** — new top-level command
(mesh plugin group), the delivery CLI.

**Fake `bd`** resolves its store by `-C <dir>`/cwd `.beads/beads.json`
when present, else `FAKE_BD_DB`, and learns `ship` — enough for a
real two-checkout e2e.

## Invariants

- Sovereignty: the only write into a foreign store is this explicit
  local-delivery anchor path; `beads-remote` transports stay
  pull-only.
- The delivered request is ordinary work in the target: `bd ready`
  lists it, `bro mesh inbox` surfaces it through the own-store scan.
- All four lifecycle verbs write to the anchor store — the target
  checkout for a delivered request, the own store for a posted one.
- `done` on an unclosed request posts the result, warns, and ships
  nothing.
- `external:<rig>:<id>` remains a marker, not a gate — bd 1.3.1 stores
  but never resolves it.

## Rejection test

- Two-checkout e2e: `bro request` → target `bd ready` lists it →
  `bro mesh inbox` shows it (`self`/`unbound`) → claim → close →
  `done` ships `provides:<id>` → requester `bro mesh wait` reads the
  closed anchor → `accept` writes to the anchor.
- Resolution matrix: alias, `mesh://` URI, explicit path, peer-remote
  basename, `<name>` sibling beats `<name>--*`, ambiguous `--`
  siblings exit 2 with candidates, unaddressed target exits 2.
- `done` before close warns "capability not shipped" and no
  `provides:` label appears.
