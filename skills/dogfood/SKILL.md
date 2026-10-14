---
name: dogfood
description: "Use when running bro's scenario-driven e2e self-test — a committed markdown runbook executed by a fresh registry agent in a scratch repo, then judged by a second agent that writes verdict.md. Thin wrapper over the bro CLI: `bro self dogfood run|status|report|scenarios` does the work. Requires `bro` (npx -y @broject/bro@0) and a configured agents.* backend for the runner/analyst spawns."
---

# /dogfood (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`, plus at least one
configured `agents.<backend>` lane (the runner and analyst are
ordinary fleet registry agents — `bro fleet agents` sees them).

## What it is

End-to-end dogfooding as a first-class command. One scenario file is a
markdown runbook (`dogfood/<name>.md`, committed): prose steps naming
`bro`/`bd` commands and `$skill` invocations, no links. `bro self
dogfood run <name>` provisions a scratch repo under
`$XDG_DATA_HOME/bro/dogfood/` (outside the host tree — `bd init`
ancestor-walks, so a nested scratch would inherit the host's beads
remote), creates the step bead in the scratch store (the runner's
claims never pollute the host's), spawns a fresh agent via
`spawnStepAgent`, and returns the run id. `bro self
dogfood status` is the point check AND the lazy pipeline advancer —
when the runner reads terminal (`exited`/`lost`/`stopped`) the analyst
spawn happens there, never on a background tick. `bro self dogfood
report` prints the analyst's `verdict.md` (`verdict: PASS|ISSUES` +
fail lines + findings).

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro self dogfood scenarios` | List committed `dogfood/*.md` scenario names |
| `bro self dogfood run <name> [--backend <c>] [--analyst <c\|same\|none>] [--provider <p>] [--keep]` | Provision + spawn the runner; prints the run id. `--analyst` defaults to `same` (runner's backend), `none` skips the verdict pass, `<c>` names a different connector. `--provider` pins the worker engine (a `providers.<name>` entry — e.g. `devin-acp`) for BOTH runner and analyst |
| `bro self dogfood status [run-id] [--json]` | Run ledger; calling it advances runner→analyst for terminal runners |
| `bro self dogfood report <run-id>` | The verdict once written; run state + transcript pointers otherwise |

## Policy

- **Orchestrator-only** — `BRO_AGENT_ID` refuses `run`: a worker never
  arms workers. `status` is read-mostly (it may lazily spawn the
  analyst for a terminal runner — orchestrator-only too); `report` is
  fully read-only.
- **Isolation is the point** — the scratch repo lives outside the
  host tree (`run-*` under `$XDG_DATA_HOME/bro/dogfood/`, persistent
  and workspace-trusted on hosts where `~` is trusted) with its own
  git store and stealth beads store; host `bro/` state, claims, and
  watch markers are never touched.
- **Monitor by point checks** — `status` between turns, never a
  blocking wait. The analyst's verdict file is the artifact; a
  `verdict.md` present closes the run even before the analyst process
  exits.
- **Runs are records** — `state.json` + prompts + the verdict live
  under `<git-common>/bro/dogfood/<run-id>/` and survive restarts;
  reap a run dir only when the verdict's been consumed. Run records
  are the only host-side writes — claims and watch markers stay on
  their own planes.
