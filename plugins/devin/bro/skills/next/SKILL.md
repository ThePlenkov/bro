---
name: next
description: "Use when the user says 'work the backlog', 'clean the queue', invokes /next, or sets a /goal over open beads — the autonomous backlog loop. Thin wrapper over the bro CLI: `bro next` is the scheduler as code — it claims the top ready bead and emits the work order. Requires `bro` (npx -y @theplenkov/bro@0) and bd."
---

# /next (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.
`bro next` computes the queue from `bd ready`, claims the top item
atomically, and surfaces what it deliberately skipped.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0`, `bd init` done.

## The loop

```text
bro next          → claims the top ready bead, prints the work order
   implement      → branch, code, tests — verify like CI
   PR             → gh pr create → bro act status → bro act merge
   bd close <id>  → reason = the PR that landed it
   bro next       → repeat until "backlog empty"
```

If the backlog exists, it was already confirmed — **never ask "should I
continue?" between items.** The queue is the approval.

## What `next` never claims

- **Human gates** — beads titled `HUMAN GATE …` surface as `gate:` lines.
  Ask the user once per gate; their verdict is the result. Everything
  else proceeds without waiting on the gate.
- **Epics** — surface as `epic:` lines. Decompose into beads first
  (`bd create` children), don't implement an epic directly.
- **Molecule steps** — beads with a `parent` belong to `bro convoy`;
  the flat queue doesn't steal them.

## Policy

- **One bead, one PR** — unless several items are trivially the same
  change. Debt batches are the exception, not the rule.
- **The gate decides done** — `bro act status` green before merge,
  `bro act merge` to land it, branches deleted after.
- **Stuck ≠ skipped** — if an item can't proceed, say why (blocker,
  missing access, ambiguity), leave it open, and move to the next bead.
  Never silently drop it: `bd update <id> --notes "<why>"` records it.
- **Empty is a valid answer** — `state: idle` means done; report and
  stop. Don't manufacture work.
