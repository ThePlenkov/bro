# Scenario: core agent workflow

A new agent session lands in a fresh bro repo and works one small
feature end-to-end the way the project wants: bead → spec → worktree →
commit → handoff, never merging itself.

Setup already done for you: this repo has git and a beads store.

## Steps

1. Orient: run `bro status` and read what it reports about the repo.
2. Claim work: create a bead for "add a hello.txt greeting file" with
   `bd create`, then take it into a worktree with `bro work enter`.
3. Spec first: inside the worktree, write the spec stub with
   `bro spec new <bead>` and add the `spec:` link to the bead
   description (the SDD gate requires one or the other).
4. Implement: create `hello.txt` containing `hello from dogfood` and
   commit it on the work branch.
5. Surface check: run `bro status` again — the worktree should now
   read as claimed live work, not residue.
6. Stop honestly: do NOT merge, do NOT open a real PR — a scratch repo
   has no forge. Note in your report what the next step would be in a
   remote-backed repo (`git push` + `gh pr create` + `bro review act
   wait`).

## Assert

- `hello.txt` exists on a work branch in a worktree under the repo.
- The bead is closed or still claimed — never left as orphaned
  in-progress work with no owner.
- Nothing was merged into `main`.
- The runner's report names at least one thing the runbook left
  ambiguous or one friction point (there always is one).
