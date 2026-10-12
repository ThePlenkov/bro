# bro-wxgt3 — bd sync over git+https has no usable auth path: bridge dolt remotes through a real-git mirror

## Problem

`bd sync` (the store's pull+merge+push cycle, invoked by
`TaskStore.sync()`) is dead on any machine whose git auth lives in the
git credential layer: dolt's `git+https` remote transport is go-git,
which cannot run `gh auth git-credential`, read `~/.git-credentials`,
talk to ssh-agent, or prompt interactively. `dolt fetch origin` exits
`failed to get remote db` in both interactive and systemd-service
environments, so `bd sync` fails on every call — federation pull+push
for beads state never happens. Verified 2026-10-12 on the live store:
`bd sync --json` → `dolt pull failed … failed to get remote db` while
`git ls-remote` on the same URL succeeds via the `gh` helper.

Manual workaround proven on the live store the same day: a local bare
mirror (`/tmp/bro-mirror.git`, `remote.origin = https://…`), the dolt
remote repointed at `git+file://<mirror>`, `bd sync` → pulled+pushed,
then `git -C <mirror> push origin refs/dolt/*` →
`fd8854c..db179d5 refs/dolt/data`. Real git owns auth; dolt only ever
talks to a local path.

## Design

The store's sync seam is `TaskStore.sync()` — every bro caller goes
through it (`bro sync`, the loop exit audit). The bridge is transport
provisioning inside that call: dolt remotes that need real-git auth get
repointed at a managed local bare mirror, and the sync cycle gains a
git fetch/push leg around `bd sync`.

- **Remote classification** — `bd dolt remote list --json` (TSV
  fallback). A remote needs the bridge when its URL is
  `git+http(s)://`, `git+ssh://`, `git://`, a bare `https?://`/`ssh://`,
  or scp-like `user@host:path` — anything go-git must authenticate.
  `git+file://`, `file://`, plain paths and dolt-native schemes
  (`dolthub:`, `aws:`, `gs:`, `oci:`) are reachable as-is.
- **The mirror** — `<beadsDir>/dolt-mirror-<remote>.git`, a bare repo
  whose `remote.origin.url` is the upstream git URL (the `git+` scheme
  prefix stripped). `bd where --json` resolves the real store dir —
  linked-worktree callers route through it, never through a guessed
  `.beads` path.
- **Repointing** — `bd dolt remote remove <name>` + `add <name>
  git+file://<mirror>` once; the name is kept (`origin` stays the
  default-remote name), so `bd sync`, `bd dolt push`, and bd's own
  auto-push all ride the working transport with no flag plumbing.
  Provenance survives twice: the mirror's `remote.origin.url` is the
  machine-usable upstream, and `sync.remote` in `config.yaml` keeps
  the declared `git+https` URL.
- **Honor existing mirrors** — a remote already pointing at
  `git+file://<path>` where `<path>` is a bare repo carrying a
  `remote.origin` URL is treated as bridged in place (the evac-style
  workaround becomes the managed shape); a `file:` remote whose target
  is not a git remote of anything stays a plain local remote.
- **The cycle** — `git -C <mirror> fetch --force origin
  '+refs/dolt/*:refs/dolt/*'
  '+refs/heads/__dolt_remote_info__:refs/heads/__dolt_remote_info__'`,
  then `bd sync --remote <name>`, then `git -C <mirror> push origin
  'refs/dolt/*:refs/dolt/*'
  'refs/heads/__dolt_remote_info__:refs/heads/__dolt_remote_info__'`.
  Force-fetch is required: the mirror's `refs/dolt/data` is a
  rendezvous pointer, and after a local publish it holds a head the
  upstream never saw — non-force fetch would refuse the overwrite.
  Push is never forced: a non-ff rejection means another replica won;
  the pushed state stays in the dolt store and re-merges on the next
  cycle's fetch+pull.
- **Degradation** — bridge legs are best-effort around the bd cycle:
  a failed fetch (offline) still lets `bd sync` reconcile against the
  mirror (local replication continues); a failed/rejected push warns
  without failing the sync. Provisioning failure falls back to the
  plain `bd sync` invocation — identical to today's behavior, never
  worse. All git legs run bounded (spawn timeout), same contract as
  the bd probes.
- **Default remote** — `origin` when present, else the sole remote,
  else no `--remote` flag (bd picks; every pick is bridged anyway —
  provisioning covers *all* git-scheme remotes, not just the default).
- **Zero-remote adoption** — no dolt remotes but a bridgeable git
  `origin` URL: provision the mirror and `remote add origin
  git+file://<mirror>` ourselves, so first-time federation bring-up
  works instead of adopting a dead https remote.

## Plan

- [x] spec (this file)
- [ ] `packages/core/src/dolt-bridge.ts` — remote parse/classify,
      mirror provisioning, fetch/publish legs
- [ ] `packages/core/src/git.ts` — `gitTry` gains an optional timeout
      (network legs must be bounded)
- [ ] `packages/core/src/tasks.ts` — `sync()` resolves the route,
      wraps `bd sync` with the bridge legs
- [ ] `dolt-bridge.test.ts` + `tasks.test.ts` coverage
- [ ] live dogfood: `bro sync` on this rig publishes through the
      bridge

## Out of scope / approximations

- Mesh `beads-remote` peer pulls (`dolt clone`/`dolt pull` in
  `packages/mesh`) hit the same go-git wall — same fix shape, separate
  surface, deliberately not in this PR.
- `__dolt_remote_info__` is dolt's own bookkeeping ref; it is relayed
  verbatim and raced replicas may reject it — the next fetch
  reconciles, matching dolt's own tolerance.
- No secrets are materialized anywhere: auth stays entirely in the
  user's git layer (credential helper, ssh agent, GCM), which is the
  point of the fix.
