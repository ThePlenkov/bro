# bro-a2dgm — herdr projector: stale sibling ledger clobbers live ws bindings

## Symptom

Workspace and agent statuses in herdr stopped updating: the daemon
projector reported `projecting 1 managed workspace(s)` while ~15
plugin-managed workspaces sat open.

## Root cause

`pluginLedger` merges every plausible plugin state file
(`HERDR_PLUGIN_STATE_DIR`, `~/.config/bro-herdr-plugin`,
`$XDG_STATE_HOME/herdr/plugins/bro.fleet`) so a herdr-hosted plugin
pane and a daemon-side run agree on ownership. The merge order was
fixed by directory, not by freshness — the herdr-hosted state dir
was read LAST, so after a herdr restart its stale records (dead
workspace ids like `w5Q` under the same worktree paths) overwrote
the live writer's fresh bindings (`w84`). `managedTargets` then
dropped every workspace on `rec.ws !== wsId`.

## Fix

Gather every candidate record per key, then pick one: a record wins
only when its bound workspace id exists in herdr's live workspace
list — liveness beats file mtime, which is only the tiebreak inside
one liveness class (collection order preserves the old same-dir
scoped-wins behaviour on an mtime tie). Each candidate's content is
read through an fd whose `fstat` supplies the mtime, so a
stat-then-read race can never pair fresh bytes with a stale rank.

## Contract

- A live binding outranks dead OR unbound records — a stale sibling
  ledger cannot drop managed workspaces whether it is older OR newer
  than the live writer's file; a record with no `ws` is unbound and
  only wins when nothing live exists.
- Status-pane bindings keep every candidate, newest first — the push
  walks the list until a pane row answers, so a newer stale binding's
  dead `pane_id` falls back to an older live one, and a half-written
  status row (no `pane_id`) is never a candidate.
- Unreadable/missing candidates are skipped as before.

## Verify

- `tsx --test packages/cli/src/commands/herdr-projector.test.ts` —
  two fleetPass regressions pin both directions: stale-older loses,
  stale-NEWER (dead ws + dead status pane) still loses to an older
  live record.
- Live `projectFleet` on the operator box: `workspaces: 1 → 15`.
- Post-merge: `npm run build` + `bro fleet daemon down && up` so the
  daemon's ticks ride the fix (pending until merged).
