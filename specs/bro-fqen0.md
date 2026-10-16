# bro-fqen0 — agents: ad-hoc spawn surface

## Problem

Spawning a background worker requires `bd create` + `bro agents up
<id>` — correct for tracked work, heavy for "go do X in background"
(owner ask: "why can't you just call a simple task?"). The spawn
machinery (connector resolution, worktree convention, registry row,
log/exit files, fleet admission) already accepts a literal prompt —
only the front door demands a bead.

## Fix

`bro agents run [<prompt>…] [--prompt <text>] [--prompt-file <file>]`
plus the `up` flag set (`--connector/--worktree/--provider/--model/
--profile/--class/--auto-approve/--beads-dir`):

1. Mint `adhoc-<8hex>` as the molStep — a phantom step id in its own
   namespace, never a real bead: `probeStep`/`stepClassInfo` degrade
   to unclaimed/unclassed, so no claim is pinned, no `bd ready`
   litter, nothing to close. Fleet routing treats it as an unclassed
   step (the `default` lane, when declared).
2. Prompt resolution: `--prompt` ?? positionals joined with spaces;
   `--prompt-file` is the file alternative. Positional text and
   `--prompt` are the same channel — both present is a usage error.
   Prompt-and-promptFile stays mutually exclusive (spawnStepAgent's
   existing guard); no prompt at all dies with a usage line.
3. Spawn through `spawnStepAgent` with the literal prompt — identical
   registry/worktree/quota path as `up <step>`: the conventional
   `<repo>--adhoc-<id>` worktree on branch `work/adhoc-<id>`,
   prompt/log/exit files under `<git-common>/bro/agents/`.
4. Output mirrors `up`: agent id, state, backend, pid, provider,
   log, worktree — plus the minted step id, which is the
   `status`/`log`/`down` handle.

## Out of scope

- A serve POST surface (POST /api/v1/agents already accepts a literal
  `prompt`; the `adhoc-` mint is the only new piece it would need —
  follow-up, not this bead).
- Reaping adhoc rows on exit — `bro agents prune` already reaps
  terminal states; adhoc entries are ordinary registry rows.
- Closing anything on completion — adhoc work lands on its own branch;
  the operator (or a later sweep) decides its fate.

## Tests

- `agents run "echo hi"` spawns: registry row keyed `adhoc-*`, prompt
  file contains the text, worker runs.
- `agents run --prompt-file <f>` spawns with the file's content.
- `agents run` with no prompt → usage error, no spawn.
- `agents run x --prompt y` → usage error (same channel twice).
- `agents run --prompt x --prompt-file f` → mutual-exclusion error.
