# bro-wb8wf — tmp-sweep: never delete across a mount boundary

## Problem

`cleanupTmpDirs` reaps stale `tmp-*` dirs with
`rmSync(path, {recursive:true})`. A filesystem mounted INSIDE such a
dir is descended and its content deleted — foreign-device loss from a
litter reaper. Same device-boundary class as the `topFillers` st_dev
fix (bro-v96mp, 020d7ea3), one path over: that one guarded a *report*,
this one guards a *delete* — and a delete fails the opposite way.

## Design

`mountVerdict(root)` — a bounded walk run on every 'delete' verdict
before rm (and before a dry-run reports `would delete`, so the preview
cannot promise what the run would refuse):

- the ROOT itself must share its parent's device — a mount AT the
  candidate empties the mounted fs identically;
- every entry — file or dir — must share the root's device. Files are
  checked too: a bind-mounted file carries the source fs's dev, and
  unlinking it removes the name off that device;
- lstat, not stat: rm unlinks a symlink in place, so a link pointing
  across devices is no hazard and must not false-positive;
- bound: 60k nodes / 1.5s — topFillers' own budget. A stale dir can
  hold a package-manager cache; the scan must never out-cost the sweep
  it guards.

Deletion fails CLOSED, opposite of the reporting path: a device
boundary keeps + stderr-warns (`mount point inside: <path>`), and so
does anything unproven — an unstat-able or unlistable entry, a spent
bound (`mount scan unproven: …`). An entry that vanished mid-walk is
the one exception — nothing there to cross into.

Rejected alternatives: a depth-1 lstat misses nested mounts;
leaf-by-leaf delete with per-leaf device checks is strictly more code
for the same safety. Known blind spot, shared with topFillers: a
bind-mounted DIRECTORY keeps the source dev — st_dev cannot see it
(would need /proc/self/mountinfo); a keep-warn is still the answer
when one is spotted.

Seam: `lstat` is injectable on `TmpSweepOptions` (topFillers' `stat`
precedent) — tests fake a mounted fs by overriding one path's dev;
real mounts need privileges the suite lacks.

## Tests

`tmp-sweep.test.ts`:

- `mountVerdict` verdicts: clean tree, nested mount found at depth,
  root-is-mount (dev ≠ parent), bind-mount-shaped file, symlink neither
  followed nor descended, vanished-mid-walk entry stays clean,
  unstat-able entry → uncertain, spent bound → uncertain.
- pipeline: a stale mount-bearing dir keeps + stderr-warns while a
  clean stale dir still deletes; an unproven scan keeps (fail-closed);
  dry-run reports the keep, never `would delete`.
