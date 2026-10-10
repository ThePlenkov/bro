# bro-glkes — drive: conflict-blocked orphan PRs need a rebase fixer

## Problem

`bro drive` only spawns a fixer when the gate reports
`open_threads > 0`. A PR that settles `blocked — merge conflicts`
(`mergeable=CONFLICTING`, zero open threads) gets logged and skipped —
and an orphaned conflicted PR (no live worker on its branch) then
stalls forever. Observed live: `act wait` on PR #376 settled BLOCKED on
merge conflicts while `bro drive` kept reporting `blocked` pass after
pass with no fixer ever spawned.

The loop already solves this shape for its own members: `memberAction`
maps `CONFLICTING` to a rebase round (`buildRebasePrompt` — rebase onto
the PR's base, resolve, `--force-with-lease` push) bounded by the
rounds budget. Drive never ported that trigger.

## Design

Extend `drivePr`'s verdict ladder in `packages/cli/src/commands/drive.ts`:

- After the `open_threads > 0` branch (threads keep preempting — same
  order as the loop schedule), an OPEN PR with
  `state.mergeable === 'CONFLICTING'` is a fixer trigger.
- Occupied → `occupied` verdict, unchanged (a live owner works its own
  conflicts).
- Orphaned → `spawnRebaseFixer`: a fresh `prMeta` probe supplies the
  PR's `baseRef` and doubles as the still-conflicted re-check — a
  conflict that evaporated between the gate fetch and the spawn reads
  as `conflict-resolved` instead of burning an agent (`UNKNOWN` still
  counts as conflicted: the host is recomputing, not cleared).
- The spawn reuses everything the thread fixer uses — same fixer bead
  (`-l fixer`, `external_ref drive:pr:<N>`), same `ensureFixerWorktree`
  on `state.headRef`, same occupancy locks + facade dedup — only the
  prompt differs: `buildRebaseFixerPrompt`, a rebase work order
  (`git fetch origin <base>` → `git rebase origin/<base>` → resolve →
  `git push --force-with-lease`), never merge.
- **Bound**: the same `fixRounds > maxRounds` cap the gate applies to
  fix rounds (`state.maxRounds > 0 && state.fixRounds > state.maxRounds`)
  suppresses the spawn — a PR whose reviewed pushes already exceed the
  cap reads as plain `blocked`, not another rebase round.

## Plan

- [ ] `buildRebaseFixerPrompt` — the rebase work order (sibling of
      `buildFixerPrompt`, exported for tests)
- [ ] `spawnRebaseFixer` — meta probe → worktree → prompt → the shared
      locked-spawn tail (extracted from `spawnFixer`)
- [ ] `drivePr` — the CONFLICTING branch between threads and `blocked`
- [ ] tests — prompt unit test; e2e: conflicted orphan → `spawned` →
      rebase event lands → next pass merges and closes the fixer bead
- [ ] `skills/drive/SKILL.md` pass-table row
