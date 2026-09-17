---
name: convoy
description: "Use when the user invokes /convoy or asks to run a beads workflow — a molecule's DAG of steps executed inside the agent. Thin wrapper over the bro CLI: `bro convoy next` is the scheduler as code; `bro convoy done` advances it. Requires `bro` (npx -y @theplenkov/bro@0) and bd."
---

# /convoy (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement scheduling; `bro convoy next` computes it from beads state.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0` (major-pinned). Requires
`bd` and an initialized `.beads/`.

## What a convoy is

A **convoy** is a beads **molecule** — the persistent instantiation of a
formula (`bd mol pour`). Steps are child issues; `blocks` edges are the DAG.
All state lives in beads: a convoy survives session restarts, compaction,
and parallel agents. Gas City is **not** required — bro is the executor.

## The loop

```text
bro convoy pour <formula>     → prints the molecule root id (once per run)
bro convoy status [mol]       → DAG: ✓ done / ▸ ready / · blocked
bro convoy next   [mol]       → JSON: what to do now
bro convoy done <step-id> --result "…"   → closes the step, emits the new next
```

Repeat `next` → work → `done` until `next` reports `"state": "complete"`.

`next` states:

- `step` — execute `step` (id, title, description = the work instructions),
  then `bro convoy done <step.id> --result "<what you did>"`.
- `gate` — a human step is next. **Ask the user** — do not execute it
  yourself and do not mark it done on their behalf without their answer.
  Their approval is the result; then `done` it with their decision.
- `blocked` — open steps exist but none are ready (dependency cycle or a
  gate closed without downstream). Run `bro convoy status` and report.
- `complete` — every step done. Close the molecule root:
  `bd close <mol-id> --reason "convoy complete"`.

## Policy

- **Never skip `next`.** Do not pick steps by eyeballing titles — the DAG
  decides order. Independent ready steps appear together in `ready[]`;
  parallel execution across agent sessions is allowed, sequential `step`
  selection is the safe default.
- **`--result` is the handoff.** Future steps read it — write what the
  next step needs (paths, PR urls, verdicts), not a diary entry.
- **Gates are not optional.** A `human` step exists to stop the machine;
  treating it as an agent step defeats the formula.
- **Resume is free.** After compaction or a fresh session, `bro convoy
  status` reconstructs everything — there is no in-memory state to lose.
- **Failures stay visible.** If a step cannot be completed, leave it open
  and tell the user — do not force-close a step you didn't do.
