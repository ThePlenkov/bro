---

name: exec
description: "Use when a shell command's result must reach the session that launched it — long builds, test runs, delayed jobs the agent should hear land. Thin wrapper over the bro CLI: `bro exec <cmd>` runs the command under `sh -c` and fires taskFinish connector probes on exit; the herdr connector's report-back prompts the pane for agent kinds without a native task-exit wake."
---

# /exec (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

## What it is

`bro exec <cmd> [args…]` runs the joined argv under `sh -c` with a
passthrough terminal, keeps a bounded output tail (4 KB), then calls
every connector's `taskFinish` probe with the verdict: cmd, exit code
or signal, wall time, tail. `bro exec` is transparent — its own exit
code is the child's, so it composes in pipelines exactly like the bare
command.

## Policy

- **Reach it instead of nohup.** A backgrounded `bro exec` (the host's
  shell-task mechanism) still runs its probes on exit — that is the
  channel a finished task uses to tap the session on the shoulder.
- **Probes are fail-open and advisory.** A wedged connector costs at
  most one probe budget and never changes the exit code.
- **Report-back is opt-in per agent kind.** The herdr connector only
  prompts a pane when `agents.herdr.reportBack` names the pane's kind:
  `"agents": {"herdr": {"reportBack": {"devin": true}}}` — outside a
  herdr pane (`HERDR_PANE_ID` unset) the probe is a no-op, so the same
  command stays clean in CI and cron.
- **Prompt the pane, don't poll.** An agent kind whose host wakes on
  task exit natively does not need report-back; enable it only for
  kinds whose lifecycle misses the event (devin today).
