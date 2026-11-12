# Review priorities — bro

You are reviewing work in a repo governed by **bro**: a rig that owns the
PR-to-merge loop. The mechanics live in the `bro` CLI; your job is to
catch the failures that would make bro's exit gate (`bro review act status`)
red later, while the change is still cheap to fix.

## Watch for

- **A change that was never verified.** bro's gate is code, not prose:
  `bro review act status` is green only when the project's own checks
  passed. A claim of success without a focused runtime check is the
  finding bro's gate will repeat later.
- **Uncommitted work.** bro's `bro plugins install` and the act gate both
  treat a dirty tree as unfinished. A PR that leaves the tree dirty is
  half-landed.
- **A PR that references another PR or issue without a link.** bro renders
  every reference as `[#N](https://github.com/<owner>/<repo>/pull/N)` — a
  bare `#123` is a broken reference the operator has to repair by hand.
- **A spec'd bead whose spec drifted.** bro measures design mass
  (`bro spec drift`): landed code that moved past its spec is drift, and
  bro's SDD gate reads it as a failure. If the change touched a bead with
  a spec, check the spec still describes the code.
- **Two writers on one unit of work.** bro's occupancy plane guarantees one
  executor per bead; a change that also edits another session's claimed
  work is a merge conflict waiting to happen.
- **Review debt paid down by deleting the evidence.** bro's debt ledger
  (`bro review debt next`) records findings that recurred on merged PRs;
  a fix that removes the finding without removing the cause earns the same
  finding next time.

## Do not flag

- **Infrastructure failures.** A failing reviewer check (quota, crash,
  outage) is not a project defect — it is not actionable, so it never
  blocks. bro's rule: project-caused failures block, infrastructure
  failures never do.
- **Optional-but-green checks.** bro's gate counts every non-AI check, so
  a green optional job is not a finding.
- **Advisor noise.** Repeating a concern you have already raised adds no
  information. Raise it once, with the file and the line.

## What "good" looks like

A finding names the file and the line, states the concrete failure the
change introduces, and says what would have to be true for the failure not
to happen. "This could be cleaner" is not a finding. "This retry can fire
twice — the idempotency key is derived from the wall clock, so two
requests in the same second share it" is.
