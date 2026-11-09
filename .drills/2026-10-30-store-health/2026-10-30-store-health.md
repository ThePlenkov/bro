---

type: drill
id: 2026-10-30-store-health
parent: null
created_at: 2026-10-30T16:40:00Z
updated_at: 2026-10-30T17:00:00Z
status: resolved
agent: orchestrator
direction: down
slug: store-health
goal: Read-only investigation of .beads Dolt store health (~2.5G): geometry, slowness (bd list ~4.6s), corrupt remote manifest table ff85p52..., shrink options, live vs pause operation plan. No purge/compact/push/restart/kill without GO.
scope: .beads/{dolt,dolt-mirror-origin.git,backup,...}; docs/restore.md; bd/dolt CLI help and point SQL; ps/lsof (read-only).
problem: Store grew to 2.5G; bd list ~4.6s; pre-push fsck 63s; Dolt server memory 553M peak/161M swap; CALL DOLT_GC() no shrink (archive_level:0); remote manifest names missing table ff85p52...; sync publishes withheld.
delegate: orchestrator
trace: light
merge: summary
---

# Scope

In scope:
- Disk geometry of `.beads/` (dolt, mirror, backup, tmp, noms, git-remote-cache).
- Point-in-time SQL/table stats via `bd sql` (no full `bd list/show/ready`).
- Remote manifest inspection (`git -C .beads/dolt-mirror-origin.git`, GitHub `refs/dolt/data`) and `docs/restore.md`.
- Shrink options inventory (`bd purge/prune/compact/flatten/gc`, Dolt GC/archive_level, caches/backups).
- Live vs pause operation classification.

Out of scope:
- No mutation of store, processes, git refs, or remote.
- No full `bd list/show/ready`, no `bd doctor --perf`.

# Problem Statement

`.beads` is ~2.5G. Loop and consumers pay: `bd list` ~4.6s, `bd sync` end-to-end 63.2s, fsck 63s, Dolt server peak RSS 553M/swap 161M. `CALL DOLT_GC()` returned 0 but did not shrink (server `archive_level:0`). Remote `refs/dolt/data` manifest references table `ff85p52crimv2oer2qufcgc06l1jtaj1`, which bro's blob-only check reports as missing because that entry is stored as a chunked tree (3 blobs), not a single blob. Sync publish is withheld.

# Plan

1. Measure geometry (`du`, noms/mirror/backup/tmp).
2. Point SQL stats (tables rows, bytes, commits).
3. Inspect nbs-spool open handles and tmp/cache layout.
4. Inspect remote manifest + docs/restore.md recovery.
5. Inventory shrink commands (dry-runs only) and estimate MB.
6. Classify operations live vs pause.
7. Write findings/evidence and finalize.

# Findings

## 1. Geometry (du)

Top-level `.beads` ≈ 2.5G:
- `.beads/dolt` = 2.1G
  - `.beads/dolt/.dolt/tmp` = 1.2G (509 `nbs-spool-*` files, Zstd; server pid 1914861 holds many open)
  - `.beads/dolt/bro` = 922M
    - `.dolt/git-remote-cache` = 682M (5 cached remote repos)
    - `.dolt/noms` = 237M (incl. `oldgen` 208M; `vvvv...` 25M; journal.idx 0.5M)
    - `.dolt/tmp` (under bro) = small
- `.beads/dolt-mirror-origin.git` = 228M (bare git mirror; origin → https://github.com/theplenkov/bro.git)
- `.beads/backup` = 129M (many .darc + oldgen)
- `.beads/formulas` = 20K; config/metadata small.

So 2.5G is dominated by transient cache/spool (1.2G) + git-remote-cache (0.68G), not by logical table data. Logical data (issues 2069 rows ≈ 1.2MB, events 10467 ≈ 7.9MB) is tiny.

## 2. Why bd list is slow

- `bd sql` point queries: ~0.9s each (COUNT issues/events, simple SELECT).
- `bd list --limit 5`: 0.75s.
- Full `bd list` bead evidence: ~4.6s; server peak RSS 553M/swap 161M; `client connection went away … EOF` bursts.
- Dolt store has 8183 commits (auto-commit history) and `oldgen` 208M; default generational GC never revisits oldgen, so memory/disk pressure persists.
- Likely contributors: Dolt query latency on versioned storage under memory pressure + many concurrent clients (loop, daemon, workers, hooks); `bd list` likely joins labels/deps and computes ready set. Shrinking history + full GC may reduce RSS and latency, but code-level N+1 in bd (external) also matters. `bd 1.3.2` fixed? Unknown.

## 3. Unhealthy mirror table ff85p52...

- Local mirror `refs/dolt/data` head = 4e2a562; GitHub upstream head = f6142fc (older).
- `ff85p52crimv2oer2qufcgc06l1jtaj1` appears in manifest in both local and GitHub trees, but stored as a **tree (directory)** containing 3 blobs (`0001`,`0002`,`0003`), not a single blob. All other 70 entries are blobs.
- bro's `doltHeadHealth` counts only regular files (`100644/100755 blob`), so it reports `ff85...` missing. This is why sync publish is withheld and `bro doctor` fails dolt-store.
- `bro doctor` lastGood search (64 commits) found no healthy ancestor → corruption appears long-lived or the chunked form is intentional for large tables.
- Recovery per `docs/restore.md`: preserve corrupt head under backup ref (already `refs/dolt/backup/67b62f4`), then re-point `refs/dolt/data` to last good head or re-push whole store from a healthy replica. Since lastGood is null locally, re-push from local mirror (`4e2a562`) is the candidate. This requires GO and verification (`bd bootstrap` in scratch).

## 4. Shrink options (dry-run only)

Potential MB:
- `.beads/dolt/.dolt/tmp` nbs-spool: ~1200 MB. Must stop server first (files open). Regenerates on demand (re-download cost).
- `.beads/dolt/bro/.dolt/git-remote-cache`: ~682 MB. Stop server; cache regenerates on sync.
- `bd flatten` (8184 → 1 commit) + full GC: noms 237M → potentially ~30–80M (estimate; irreversible). Reclaims oldgen 208M.
- `bd compact --days 30`: 654 old commits → 1; smaller history reduction.
- `bd gc --full`: full generational GC; default GC does not reclaim oldgen.
- `.beads/dolt-mirror-origin.git`: 228M; `git gc` maybe 50–150M.
- `.beads/backup`: 129M; remove old backups if not needed.
- Events payload 7.9MB; labels 25KB; no significant data-level shrink. `bd purge` only 5 wisps. `bd prune` found 0 closed >90d.
- Server config `archive_level:0` disables compression; setting to default 1 requires server restart and may reduce disk/IO.

## 5. Live vs pause classification

Live (read-only / low risk, no process touch):
- Geometry/du, git inspection, `bd sql` point queries, `bd doctor`, `bd * --dry-run`, `lsof`.
- `bd dolt status`, `bd backup status`.

Pause loop only (stop bro loop; server stays up; no active agents):
- `bd purge --force`, `bd prune --force` (after dry-run).
- `bd compact --force`, `bd gc --full --force`.
- `bd backup sync` (if configured).

Pause server (stop loop → `bd dolt stop` → operate → `bd dolt start` → restart loop):
- Delete nbs-spool tmp (1.2G).
- Delete/rebuild git-remote-cache (682M).
- Mirror `git gc` / mirror rebuild.
- Edit server config `archive_level`.
- Remote manifest recovery push (GO required).

Irreversible / high risk:
- `bd flatten --force` (loses all commit history).
- Deleting backup dir (loses local recovery copies).
- Force-pushing `refs/dolt/data` (affects all replicas).

# Evidence

- `du -sh .beads` = 2.5G; breakdown above.
- `bd sql` counts: issues 2069, wisps 5, events 10467, dependencies 1334, labels 2458; events payload 7.9MB; issues payload 1.2MB.
- `dolt_log` commits = 8183; `bd compact --dry-run`: 654 old (>30d) of 8184.
- `bd gc --dry-run`: 0 closed >90d; compact 8184 commits.
- `bd flatten --dry-run`: 8184 → 1.
- `lsof +D .beads/dolt/.dolt/tmp`: dolt pid 1914861 holds many spool files.
- ps: dolt server pid 1914861 (port 37934), loop pid 87262.
- `bro doctor`: dolt-store origin head f6142fc names 1 missing table ff85...; lastGood none in 64.
- GitHub `refs/dolt/data` = f6142fc; local mirror = 4e2a562.
- `ff85...darc` is a tree with 3 blobs (0001–0003); all other entries blobs.
- `docs/restore.md` recovery recipe.

# Deliberable (compressed)

Top-3 disk sources:
1. `.beads/dolt/.dolt/tmp` nbs-spool 1.2G.
2. `.beads/dolt/bro/.dolt/git-remote-cache` 682M.
3. `.beads/dolt/bro/.dolt/noms` 237M (oldgen 208M) + mirror 228M + backup 129M.

Shrink potential: ~1.88G cache/spool (rebuildable) + up to ~200M DB history (flatten) + ~50–150M mirror GC + 129M backups. Sustainable core shrink ~200–300M via flatten+full GC; caches are recurring.

Operations: read-only live; DB compaction pause loop; filesystem cache/remote recovery pause server. Flatten and remote push require GO.

## What actually helps `bd list >15s`: reducing Dolt commit history + full GC (reclaim oldgen) to lower RSS/swap and fsck cost; not cache deletion (disk only). Also external bd code/upgrade may be needed if N+1 remains. Enabling archive_level=1 and server restart may help IO. Remote manifest recovery unblocks sync/publish but not list latency.

status: resolved
updated_at: 2026-10-30T17:00:00Z

# Prevention Plan

- Track fsck duration and `bd list` latency as metrics in loop/doctor; alert if fsck >60s or bd list >2s.
- Keep `BEADS_FSCK_TIMEOUT` config-driven (not hardcoded) and above observed fsck (63s) with margin.
- Schedule periodic maintenance (pause loop): `bd compact`/`bd gc --full` monthly or when commits >5000 / noms >200M.
- Avoid auto-commit history bloat: use batched commits where safe; monitor `dolt_log` count.
- Fix or extend `doltHeadHealth` to accept chunked table dirs (or avoid chunked form) so `ff85` does not cause false corruption; verify bootstrap before pushing.
- Re-push `refs/dolt/data` from healthy replica after fixing manifest; preserve corrupt head ref (already done).
- Clean nbs-spool/git-remote-cache during maintenance windows (stop server) and add janitor check (like `bro doctor` janitor) for .dolt/tmp size.
- Keep `archive_level` at default (1) unless measured need; document any override.
- Do not run heavy bd operations concurrently with loop/agents; use pause classification above.
- Before any shrink, take backup (`bd backup`) and verify in scratch.
