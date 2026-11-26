---
title: Beads Dolt maintenance
---

# Beads Dolt maintenance

Embedded Dolt keeps unreachable chunks until garbage collection. Under a
multi-agent write load this can grow much faster than the live issue data (the
`.beads/embeddeddolt` store and `dolt-mirror-origin.git` are both part of the
local store). `bd` does not currently provide a garbage-collection command.

## Safe procedure

Run collection from the repository whose `.beads` directory is being
maintained:

```sh
# Inspect the stores and commands without changing anything (the default).
node scripts/beads-dolt-gc.ts

# Stop the bro daemon, agents, and scheduled bd sync jobs first. Then:
node scripts/beads-dolt-gc.ts --run
```

The script discovers both supported layouts, `embeddeddolt/<db>/.dolt` and
`dolt/<db>/.dolt`, and also collects
`.beads/dolt-mirror-origin.git`. It refuses to run when `ps` finds any `bd` or
`dolt` process. This conservative global check is intentional: `BEADS_DIR` is
often supplied through the environment and therefore is not visible in argv.
It takes
an atomic `.bro-dolt-gc.lock` directory lock and repeats the process check
immediately before the first collection. A live lock owner is never removed;
an orphaned lock (its recorded PID no longer exists) is recovered.

The Dolt command is `dolt gc` in each database directory. The mirror uses
`git gc --prune=now`. Both can be I/O intensive; schedule them in a quiet
window and ensure free disk space for temporary compaction data. A collection
that is interrupted should be rerun during another quiet window.

This lock is a safety barrier for maintenance commands, not a lock understood
by older `bd` versions. The process check is therefore required even when the
lock exists. Do not automate `--run` on every sync: run it on a scheduled
maintenance window (daily or after unusually large imports), with the daemon
and agent fleet stopped.
