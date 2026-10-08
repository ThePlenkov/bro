---
parent: project
---

# cross-repo — request protocol between sovereign rigs

## Scope

A bro session must never fix another project's code. Findings that
belong to a foreign repo become **requests** posted to that rig's
inbox. On LOCAL and WAIT the requester's own bead blocks on a
cross-repo dep until the answer lands; on REMOTE it blocks on nothing —
no checkout means no dep — and the thread itself is the wait. This area
owns bro's concrete phases on top of the vendor-neutral wire contract
(specs/mesh) — the bro-5nnj epic.

## Phases

- **LOCAL** — `bro request <repo-or-alias> <title>` resolves a
  same-machine checkout, drops a mesh/1 request envelope into the
  target rig's inbox store (the mesh sovereignty rule's `local`
  carve-out — a shared filesystem trust domain), and `bd dep add
  <bead> external:<rig>:<id>` wires the waiter; `bro mesh wait` is
  the point-check. Spec: specs/cross-repo/bro-oam4.md.
- **WAIT** — dedicated `bro wait external:<ref>` point-check watcher
  (act wait pattern) over foreign bead state: read the target store for
  the closed request bead and bd's `provides:` ship label, verdict in the
  exit code. The dep-marked block is the truth; the watcher is a
  convenience. Spec: specs/cross-repo/bro-y5zcw.md.
- **REMOTE** — GitHub-issue transport for repos with no local
  checkout (the issue body is prose, a comment carries the record, and
  labels are a query index only — GitHub caps label names at 50 chars);
  wasteland wanted board for public rigs, where posting is a
  fork-and-propose and the board id is the thread id. No `external:`
  dep on either plane, and no dep on the local mirror bead either: bd
  resolves external refs by opening a beads store at a filesystem path,
  which neither surface has, so the mirror is tracked and the thread is
  waited on. Spec: specs/cross-repo/bro-kim1e.md.

## Owns

```text
packages/cli/src/commands/request.ts    bro request — resolve + deliver
packages/mesh/src/                      local delivery, rig resolution
AGENTS.md                               foreign-findings policy text
```

## Related

- specs/mesh/spec.md — envelope, lifecycle, transport bindings.
- bro-5nnj — the cross-repo epic this area serves; context: sverka
  dogfood requests (bro-1c78, bro-wlal) were hand-created — this makes
  the pattern protocol instead of convention.
