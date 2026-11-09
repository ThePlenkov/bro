---
parent: bro-4e5sp
---

# bro-orcdv — detect a remote Dolt store whose manifest references missing table files

## Problem

Dolt's git-remote push can publish a `refs/dolt/data` head whose
manifest names table files it never uploaded — a store no replica can
bootstrap. Verified on this repo's own origin, 2026-10-16: head
`67b62f4` (push 2026-10-12) carries a manifest listing 128 tables;
`b9rv3prlplb1q1oqh06aevausvdnccgv` is not in the head tree or any
ancestor's. `bd bootstrap` dies `Blob not found`; the previous head
`808300e` clones fine. The corrupt head survives under
`refs/dolt/backup/67b62f4`; `refs/dolt/data` was rolled to a clean
store (`d6299c6`).

Nothing detects this state: `bd sync` exits clean — push already
succeeded, from bd's view — and `bro doctor` checks that a dolt remote
exists but never opens the tree. The failure only surfaces when a
fresh machine bootstraps, which is the worst possible time.

Remote layout (verified against the corrupt ref): `refs/dolt/data`'s
commit tree is a flat noms store — a `manifest` file plus files named
by table hash, archive tables carrying a `.darc` suffix. The manifest
is one line, `5:__DOLT__:<lock>:<root>:<extra>:<name>:<count>:…`;
every `<name>` must resolve to `<name>` or `<name>.darc` in the tree.
A `file:`/`git+file://` dolt remote can also point at a bare git repo
(the bridge mirror) or a plain noms dir holding the same file set.

## Design

- **Core (`packages/core/src/dolt-bridge.ts`)** — the module already
  owns remote classification and the mirror:
  - `manifestTables(text)` — parse the v5 manifest; anything that
    isn't the `5:__DOLT__:…:name:count…` layout throws (an
    unverifiable format is not a corruption verdict).
  - `doltHeadHealth(gitDir, ref)` → `{ head, tables, missing, error? }`
    — `rev-parse --verify <ref>^{commit}`, `ls-tree --name-only`,
    `show <ref>:manifest`; `missing` = manifest ids absent from the
    tree (checking the `.darc` variant too). `error` covers absent
    ref / unreadable manifest — unverifiable, not corrupt.
  - `doltDirHealth(dir)` — the same manifest-vs-file-set check for a
    plain noms directory (a `file:` remote that isn't a git repo).
  - `doltRemoteSrc(remote)` — what to fetch `refs/dolt/data` from: the
    upstream URL for git schemes; for a file-shaped target that is a
    bare repo with an `origin` (the bridge mirror), that origin —
    upstream truth, not the cache; else the path itself. null for
    non-git schemes.
  - `probeDoltRemote(src, { deepen })` — a scratch bare repo:
    `ls-remote` for the head (absent ref = nothing published,
    healthy), then `fetch --depth=1 --filter=blob:none --no-tags`
    (commit+trees only; the manifest blob lazy-fetches on read —
    sub-second on a real remote), then `doltHeadHealth(FETCH_HEAD)`.
    On corruption, `fetch --deepen=N` and walk `rev-list` for the
    nearest self-consistent ancestor — the report's "last good head".
- **Post-publish gate in `TaskStore.sync()`** — between `bd sync` and
  `bridgePublish`, `doltHeadHealth(mirror, 'refs/dolt/data')`:
  `missing > 0` means dolt wrote an unbootstrappable head into the
  mirror — skip the publish and warn (upstream keeps its last good
  head; pushing would corrupt every replica's next bootstrap).
  Unreadable/absent manifest warns but does not block — an unknown
  format must not wedge replication.
- **`bro doctor`** — a `dolt-store` row per dolt remote (in
  `remoteChecks`, after `dolt-remote`): `probeDoltRemote` over
  `doltRemoteSrc`. Corrupt → `fail` with the missing table ids, the
  last-good head when found, and the recovery hint. Unreachable →
  `warn` (infra never blocks). Nothing published → `ok`. Non-git
  scheme → `skip`. A plain noms dir remote → `doltDirHealth`.
- **Runbook** — `site/content/docs/restore.md` gains a corrupt-remote
  section: symptom (`bd bootstrap` → `Blob not found`), detection
  (`bro doctor` / the git plumbing it runs), and recovery — re-point
  `refs/dolt/data` at the last-good head (`git push -f origin
  <sha>:refs/dolt/data`) or re-push from a replica whose local store
  is healthy.

## Plan

- [ ] spec (this file)
- [ ] `dolt-bridge.ts` — manifest parse, head/dir health, remote-src
      resolution, `probeDoltRemote` (+ deepen/last-good walk)
- [ ] `tasks.ts` — post-`bd sync` mirror verification gates
      `bridgePublish`
- [ ] `doctor.ts` — `dolt-store` rows per dolt remote
- [ ] `dolt-bridge.test.ts` / `doctor.test.ts` — fixture bare repos +
      noms dirs covering healthy, missing-table, unparseable,
      no-data-ref, and last-good recovery
- [ ] `restore.md` runbook section
- [ ] `npm run build && npm run typecheck && npm test`

## Out of scope / approximations

- The upstream fix belongs to dolt's git-remote push path
  (gastownhall/beads) — reproduce-then-file is a follow-up, not this
  PR; detection + containment is what unblocks rigs.
- Only `refs/dolt/data` is verified — backup and `__dolt_remote_info__`
  refs are bookkeeping; a corrupt backup wastes space but kills no
  bootstrap.
- The deepen walk is capped (64 commits) — older good heads report as
  "not found in the scanned window" with the recovery command, which
  is the actionable part either way.
