# Scenario: claude tool loop on the gateway

A `claude -p` session on this repo's `bro serve` must finish a task
that REQUIRES its native tools — Write to create a file, Bash to
inspect git. The tools execute client-side; the conductor's job is
to carry every turn faithfully so the loop completes. This scenario
proves a real tool-driven edit cycle lands through `/v1/messages`.

Setup already done for you: `.claude/settings.local.json` wires the
conductor listener and `bro.config.local.json` the acp backend.

## Steps

1. Orient: `npx bro status`.
2. Claim work: `npx bro task new "write an inventory file"`, then
   `npx bro work enter <bead>`.
3. Use your own tools deliberately: with your Write tool create
   `inventory.md` listing every file currently in the worktree root
   (get the list with your own file-listing capability, not a guess).
4. With your shell tool run `git status --short` and `git log -1
   --oneline`, then commit `inventory.md` on the work branch.
5. Spec the bead: `npx bro spec new <bead>` +
   `npx bro task set <bead> --description='spec: specs/<bead>.md'`.
6. Report: `npx bro notify` — one line naming the client tools you
   used (Write, Bash, …) and confirming each completed.

## Assert

- Every turn answered `/v1/messages` on this run's `bro serve`.
- `inventory.md` exists on the work branch and truthfully lists the
  worktree root's files (it was written by a real tool, not narrated).
- The report names at least two distinct client tools used.
- The bead is claimed or closed; nothing merged to `main`.
