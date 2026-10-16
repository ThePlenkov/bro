# Scenario: bro plugin inside a claude session

A `claude` session lands in a fresh bro repo where the bro plugin is
enabled and the model plane is bro's own conductor — `bro serve`
translates `/v1/messages` into `devin acp` sessions, so every turn
this session takes is already proof that claude runs ON bro without a
claude subscription. The steps below exercise the plugin's native
surface from inside that session — and every runnable command in this
runbook is `npx bro …`: the scenario is also the out-of-the-box proof
that one installed binary is all the workflow needs.

Setup already done for you: this repo has git, a beads store, SDD
armed, `.claude/settings.local.json` wiring the conductor listener +
the `bro@bro` plugin, and `bro.config.local.json` carrying the acp
provider the conductor serves. The apiKeyHelper is one line —
`npx --no-install bro serve ensure --port 44928` — which lazy-spawns
this repo's listener and prints its session token.

## Steps

1. Orient: run `npx bro status` — the session-start hook should
   already have given you repo context; reconcile what it said with
   what the command reports.
2. Claim work: `npx bro task new "add a hello.txt greeting file"`
   prints a bead id, then take it into a worktree with
   `npx bro work enter <bead>`.
3. Spec first: inside the worktree, `npx bro spec new <bead>` and
   `npx bro task desc <bead> 'spec: specs/<bead>.md'` — the `spec:`
   line in the description is what the gate reads.
4. Implement: create `hello.txt` containing `hello from claude
   dogfood` and commit it on the work branch.
5. Hook check: attempt to end your turn while the claim is open —
   describe in your report what the plugin's stop-gate did (armed
   markers: open bead claim + dirty worktree).
6. Surface check: run `npx bro status` again — the worktree should
   read as claimed live work. Report back with `npx bro notify` — one
   line on what you did.
7. Stop honestly: do NOT merge, do NOT open a PR — a scratch repo has
   no forge. Name what the next step would be on a remote-backed repo
   (push the branch, open the PR, then `npx bro review act wait`).

## Assert

- The session itself ran on the bro conductor — `bro serve` on this
  repo's port answered `/v1/messages` for every turn (the analyst can
  check `serve.log` and the conductor's `conductor.turn` events).
- `hello.txt` exists on a work branch in a worktree under the repo.
- The bead is closed or still claimed — never orphaned.
- Nothing was merged into `main`.
- The runner's report names at least one plugin surface — a native
  command, a hook, a skill — that behaved differently from what the
  runbook implied, or confirms each one worked as designed.
- No step needed a second CLI: `npx bro …` covered orient, task,
  worktree, spec, gate and report.
