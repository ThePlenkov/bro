# bro-oam4 — cross-repo LOCAL phase: `bro request`, external deps, wait

## Problem

A bro session that finds work belonging to another repo has three bad
options: patch the foreign code (forbidden — sovereignty), hand-create
a bead in the foreign store (what sverka dogfood did — bro-1c78,
bro-wlal — convention, not protocol), or drop the finding entirely.
`bro mesh request` exists but wants a literal `mesh://` URI and posts
only on the requester's store — a same-machine peer that never bound
back sees nothing. The bilateral same-machine case, the common one on
a dev workstation, needs a one-command path: name the repo, post the
request, block my bead.

## Design

### `bro request <repo-or-alias> <title>`

Thin front over the mesh machinery (specs/mesh). The argument
resolves in order:

1. **`mesh.peers` alias** → the binding's rig + remote.
2. **`mesh://<org>/<repo>`** → the URI verbatim; delivery is plain
   `bro mesh request` (own-store post — the peer pulls).
3. **A local checkout**, tried in order:
   - an explicit path (contains `/`, or `.`/`..`);
   - a `local` peer's remote basename (already-known paths);
   - a sibling directory of this checkout — `<name>` or the
     `bro work` shape `<name>--<slug>` — whose store exists
     (`.beads/`). `<name>` wins over `<name>--*`; several `--`
     siblings and no bare `<name>` is ambiguous → exit 2 listing
     candidates.

   The rig is resolved exactly as `bro mesh me` resolves it for that
   checkout: the `mesh.rig` config pin wins, else
   `rigFromRemoteUrl(origin)` — the shared `selfRig` derivation run
   on the target dir, so `to` names the rig its own `bro mesh inbox`
   answers to. `.bro-rig.json` is a discovery hint, never an identity
   source — when it disagrees with the resolved rig, warn and still
   address the resolved rig. Unresolvable → exit 2, "target rig is
   unaddressed" (the `bro mesh me` wording).

### Delivery — the anchor store

For a target resolved to a same-machine checkout, the request is
delivered, not published: `bd -C <checkout> create` writes the task
bead **into the target's store**, then the mesh/1 label set +
`external_ref` are pinned exactly as `postEnvelope` does. The bead id
IS the thread. The target's `bd ready` shows it as ordinary work —
no mesh-aware session required — and `bro mesh inbox` surfaces it
(own-store scan below).

**The thread's home is the anchor store.** Every lifecycle message
on a locally-anchored thread — the worker's `claim`/`done`, the
requester's `accept`/`reject` — is written to that same store
(`bd -C <anchor>`), resolved through the peer binding. Readers point-
check with `bro mesh wait <thread>`; nothing sleeps.

**Reading the anchor back rewrites one `meshThread` rule.**
`admitPeerRecord` assumes a store's records are authored by its owner
— true under pull transports, false here: the request and both
requester verdicts carry a `from` that isn't the binding's rig, and
the strict check hides exactly the records `bro mesh wait` needs
(no `request` anchor → lifecycle verbs can't resolve the thread at
all). On `local` peers the binding attests the *store*, not the
author: a record whose `from` is the binding's rig **or the reader's
own rig** is admitted with provenance = `from` — a self-authored
record in a bound local store is the delivery working, not
impersonation — while any other `from` still drops and flags. Pull
transports keep the strict check: a foreign-authored record inside a
replica cannot be legitimate.

Sovereignty: same-machine checkouts are a shared trust domain — the
writer provably has filesystem access already. The drop writes
envelope beads only, never code, branches, or config; across
machines sovereignty stays structural (beads-remote remains
pull-only). This is the mesh spec's `local` row made concrete:
"`bd create` in a known same-machine checkout".

### Peer binding ensure

A resolvable local target that isn't bound gets an upsert:
`mesh.peers[<alias>] = { rig, remote: <checkout> }` — `local`
transport is derived from the path. An existing binding is left
untouched. The binding is what makes `bro mesh wait`, `inbox`, and
the anchor store reachable later; `<alias>` is the repo basename
unless the caller passes one.

### `bro mesh inbox` — own-store scan

Delivered requests live in the *recipient's* own store, so inbox
gains an own-store pass: beads carrying mesh labels with
`kind=request` and `to` = this rig. Provenance is advisory on the
drop path — the writer was a same-machine session, not a bound
transport — so a `from` matching no peer binding is surfaced flagged
(`unbound`), like `mismatch`, never silently dropped.

### Waiter wiring and policy text

`--for <bead>` (same flag as `bro mesh request`) runs
`bd dep add <bead> external:<rig>:<id>` — bd's external dep blocks
the waiter until the capability closes in the named store. The
session-facing rule lands in AGENTS.md (Conventions), verbatim:

> **Foreign findings become requests, never patches** — work that
> belongs to another repo is posted to that rig's inbox, never
> edited in place: `bro request <repo> <title> --for <bead>` drops
> the request bead and blocks mine on `external:<rig>:<id>`;
> `bro mesh wait <id>` point-checks the answer.

## Non-goals (this phase)

- `bro wait external:<ref>` — the dedicated watcher is phase WAIT;
  `bro mesh wait` already point-checks the thread.
- GitHub-issue / wasteland transports — phase REMOTE.
- Auto-pull or replica sync for local targets — a live store needs
  neither.
- Pre-binding the reverse direction — the target binds back (or not)
  when it works the thread; `bro request` only guarantees the
  requester's view.

## Owns

```text
packages/cli/src/commands/request.ts    bro request
packages/mesh/src/request.ts            resolve + deliver + ensure-binding
packages/mesh/src/identity.ts           selfRig hoisted in — shared rig resolver
packages/mesh/src/inbox.ts              own-store scan (unbound flag)
packages/mesh/src/thread.ts             local-anchor admit rule
packages/cli/src/commands/mesh.ts       lifecycle writes → anchor store
AGENTS.md                               policy bullet
```

## Plan

- [ ] `packages/mesh/src/request.ts` — repo-or-alias resolution
      (alias → uri → path → peer basenames → siblings), rig
      derivation (target's `selfRig`: `mesh.rig` pin → origin —
      hoist it from mesh.ts so `me` and `request` share one
      resolver), `deliverRequest` (`bd -C` create + label pin +
      external_ref), peer-binding ensure
- [ ] `packages/cli/src/commands/request.ts` — `bro request
      <repo-or-alias> <title> [--body T] [--priority N] [--ref K:R]…
      [--for BEAD]`, prints `<id> → <rig>` + thread hint
- [ ] anchor-store writes for `claim`/`done`/`accept`/`reject` —
      resolve the thread's anchor (own store today; a `local` peer's
      checkout when the thread lives there) instead of always `dir`
- [ ] `packages/mesh/src/thread.ts` — `admitPeerRecord` widened for
      `local` peers: `from` ∈ {binding rig, selfRig} admits with
      provenance = `from`; any other `from` still drops and flags
- [ ] `bro mesh inbox` own-store scan + `unbound` provenance flag
- [ ] AGENTS.md Conventions bullet (verbatim text above)
- [ ] tests: resolution matrix (alias / uri / path / basename /
      ambiguous / unresolvable), drop shape (labels, thread, dep),
      inbox own-scan + unbound flag, anchor-write for each verb,
      requester-side `mesh wait` on an anchored thread (request +
      own verdicts visible, foreign `from` dropped), e2e
      two-checkouts: request → `bd ready` in target → claim →
      done → `bro mesh wait` → accept

## Alternatives

- **Own-store post only** (today's `bro mesh request`) — rejected
  for the local case: needs the target to peer back before anything
  is visible; a unilateral finding should arrive as work, not as a
  packet waiting for a subscription.
- **Dual write** (requester copy + target copy) — rejected: two ids
  for one thread, and the requester already tracks via the
  `external:` dep + `bro mesh wait`.
- **GitHub issue transport for local repos too** — rejected: one
  hop through the forge for repos on the same disk buys nothing;
  kept for phase REMOTE where no checkout exists.

## Related

- specs/mesh/spec.md — envelope fields, lifecycle, sovereignty rule.
- specs/cross-repo/spec.md — the phase map (LOCAL / WAIT / REMOTE).
- bro-5nnj — epic; bro-5eaa — mesh epic (wire contract this rides).
