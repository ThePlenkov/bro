# Scenario: bro inside a codex session

A `codex` session lands in a fresh bro repo where the model plane is
bro's own conductor — `bro serve` translates `/v1/responses` (codex's
wire) into `devin acp` sessions, so every turn this session takes is
already proof that codex runs ON bro without an OpenAI subscription.
The steps below exercise the repo-native agent surface from inside
that session — and every runnable command in this runbook is
`npx bro …` or `bd`: the scenario is also the out-of-the-box proof
that one installed binary plus AGENTS.md is all the workflow needs.

Setup already done for you: this repo has git, a beads store, SDD
armed, `.codex/config.toml` wiring the conductor listener (provider
`bro`, `wire_api = "responses"`, `env_key = "BRO_SERVE_TOKEN"`), and
`bro.config.local.json` carrying the acp provider the conductor
serves. The token reaches the session through `bro serve ensure
--port {{PORT}}`, exported by the spawn command as `BRO_SERVE_TOKEN`.

## Steps

1. Orient: run `npx bro status` — reconcile what it reports with the
   repo context AGENTS.md described.
2. Claim work: `npx bro task new "add a hello.txt greeting file"`
   prints a bead id, then take it into a worktree with
   `npx bro work enter <bead>`.
3. Spec first: inside the worktree, `npx bro spec new <bead>` and
   `npx bro task set <bead> --description='spec: specs/<bead>.md'` —
   the `spec:` line in the description is what the gate reads.
4. Implement: create `hello.txt` containing `hello from codex
   dogfood` and commit it on the work branch.
5. Gate check: describe what would happen if you stopped with the
   claim open and the worktree dirty — name the stop-gate probe that
   would arm (open bead claim + dirty worktree).
6. Surface check: run `npx bro status` again — the worktree should
   read as claimed live work. Report back with `npx bro notify` — one
   line on what you did.
7. Stop honestly: do NOT merge, do NOT open a PR — a scratch repo has
   no forge. Name what the next step would be on a remote-backed repo
   (push the branch, open the PR, then `npx bro review act wait`).

## Assert

- The session itself ran on the bro conductor — `bro serve` on this
  repo's port answered `/v1/responses` for every turn (the analyst
  can check the `conductor.turn` rows in `serve-turns.jsonl` under
  the common git dir's `bro/` — `dialect: 'responses'`).
- `hello.txt` exists on a work branch in a worktree under the repo.
- The bead is closed or still claimed — never orphaned.
- Nothing was merged into `main`.
- The runner's report names at least one agent surface — AGENTS.md
  guidance, a beads command, a skill — that behaved differently from
  what the runbook implied, or confirms each one worked as designed.
- No step needed a second CLI: `npx bro …` covered orient, task,
  worktree, spec, gate and report.
