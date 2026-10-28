---

title: bro review act
description: The open-PR review loop — exit gate as code, merge only when green.
---

_Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`)._

`bro review act` answers the question an agent can't: _"can I stop now?"_ The
gate is code, not a prompt instruction — it counts open threads, pending
checks, SAST annotations, mergeability, and fix rounds.

## Commands

| Command                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bro review act status [PR] [--json]`                                                                | PR state + exit gate. Non-zero while blocked                                                                                                                                                                                                                                                                                                                  |
| `bro review act threads [PR]`                                                                        | Unresolved review threads, TSV                                                                                                                                                                                                                                                                                                                                |
| `bro review act wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup] [--bead ID] [--detach]` | Poll the gate until it settles — green, blockers, or timeout. `--merge` lands the PR on green; `--cleanup` requires `--merge` and retires the merged worktree and local branch; `--bead` closes the loop-claimed bead once the merge lands; `--detach` re-spawns the wait detached so it outlives the session, output on `<git-common>/bro/act-wait-<pr>.log` |
| `bro review act merge [PR] [--squash\|--merge\|--rebase] [--admin] [--cleanup] [--bead ID]`          | Merge **only if the gate is green** — refuses and names blockers; `--cleanup` retires the checkout the command runs in when safe, and keeps the local branch if another worktree still checks it out; `--bead` closes the loop-claimed bead on land                                                                                                           |
| `bro review act resolve --thread ID [--comment T]`                                                   | Resolve (reply first if comment given); `--unresolve` reopens                                                                                                                                                                                                                                                                                                 |
| `bro review act reply --thread ID --comment T`                                                       | Reply without resolving; `--file TSV` for batch                                                                                                                                                                                                                                                                                                               |
| `bro review act rearm [--dry-run] [--json]`                                                          | Resurrect dead PR watchers — respawn `act wait` for open PRs whose watch marker outlived its process (bead identity included); settled markers are swept — a merged one closes the bead it carried — live ones kept                                                                                                                                           |
## The gate

`bro review act status` exits non-zero with named blockers:

- `open_threads` — unresolved review threads
- `ci_pending` — every non-AI check must be green; a failing _optional_
  job is still red
- `reviewers_pending` — a running AI reviewer may still post findings
- `sast_pending` / `sast_unknown` — failure-level SAST annotations
- `fix_rounds` — pushes after the first review comment
- `reopened_threads` — a thread that was resolved and then commented on
  again. The earlier resolution was wrong, so the gate blocks and `bro loop`
  / `bro drive` park instead of spawning a fixer — re-resolving it would
  hide exactly what the reopen says. Report it; the user decides.

**The general rule: project-caused failures block; infrastructure
failures don't.** A failed AI-reviewer _check_ (`reviewers_failing`) is
infra noise — crash, quota, outage — reported but never blocking. Its
real findings arrive as threads, which do block. Chronically flaky checks
go on [`act.ignoreChecks`](/docs/configuration#act) — a conditional
ignore: a failing advisory check stays quiet only while it keeps failing
_and_ producing thread output, otherwise `alerts` carries a
silent-reviewer line (still non-blocking).

## Requiring human sign-off

A green gate is **not** a human approval — by default it means threads,
CI, and mergeability settled; a bot-only review thread satisfies the
review dimension. For hostile-input threat models (a malicious bead, a
prompt-injected agent) that's a hole: `bro review drive` can auto-merge
agent output with zero human sign-off.

[`act.requireApproval`](/docs/configuration#act) closes it. When `true`,
the gate additionally requires a trusted **human's approving review on
the PR's current head** — available since bro 0.3.0. Semantics:

- **Latest decision review per reviewer.** Each reviewer's newest
  `APPROVED`/`CHANGES_REQUESTED`/`DISMISSED` review is their standing
  verdict — a `CHANGES_REQUESTED` that was never re-approved vetoes the
  gate no matter which head it reviewed (GitHub; on GitLab the veto is
  an unresolved discussion).
- **Head-bound.** An approval counts only on the head being merged; a
  push after approval makes it stale, not a sign-off.
- **Bots never count.** A bot `APPROVED` review never satisfies the
  gate; the host's aggregate "approved" flag alone is never enough.
- **Trusted logins.** `act.approvers` (a login allowlist, empty = any
  human account) narrows "trusted" so a machine `User` account can't
  sign off on the agent's own output.
- **Fail-closed.** A probe that can't answer — host unreachable, API
  error, connector without the capability — blocks as _unanswerable_,
  never a pass. The blocker names the probe's reason (`changes
  requested by …`, `approval predates the current head`, `bot-only`,
  `outside act.approvers`).

The flag defaults to `false`: with it off, auto-merge semantics are
unchanged. If you don't opt in, the documented hardening is
[`drive.merge: "never"`](/docs/configuration#drive) plus host branch
protection — the merge decision stays with a human.

GitLab note: the approvals endpoint doesn't expose per-approval head
SHAs, so current-head binding there is the project's
**reset-approvals-on-push** rule — set it alongside `requireApproval`
(same class of server-side boundary as branch protection).

## The severity-aware loop

Every push re-triggers reviewers — endless inline fixing is a treadmill.
So the loop is bounded and severity-aware:

- **Correctness/blocking findings** → fix inline, resolve silently (the
  push is the verdict)
- **Valid but non-blocking (P2/P3, polish)** → defer: `bd create`
  with `--external-ref <thread_id>`, reply with the bead id, resolve
- **Wrong findings** → reply with the reason, resolve

`act.maxRounds` (default **3**, `0` disables) caps inline fix rounds.
Past it, the gate's blocker changes its verdict: _defer remaining threads
to debt beads, do not fix inline._ Docs-only PRs — every changed file
matching `act.docsPaths` — cap tighter at `act.docsMaxRounds` (default
**2**): doc threads churn per push, so the tail belongs in debt sooner.
`docs_only=true` in `act status` marks a docs-only PR.

Contradictory findings across rounds resolve by **judgment, not push** —
a fix for round N can draw a contradictory finding in round N+1; a
flip-flop commit just buys a fresh round. Pick the right reading, reply
with the reasoning, resolve; a real concern on the losing side becomes a
debt bead.

With [`judge.mode: "shadow"`](/docs/configuration#judge), `bro review act
threads` annotates each unresolved row with a `judge: …` line — the
verdict is journaled so `bro self judge stats` can score judge-vs-outcome
agreement.

## Don't wait — background it

`bro review act wait` does the waiting so your turn doesn't. The pattern: push,
then `bro review act wait <PR> --merge` in a background shell — not even a
subagent, so the wait costs zero tokens — and take the next bead. When
the shell finishes it carries the verdict: exit 0 and the merge landed,
or non-zero and `bro review act threads <PR>` (a separate call — a failing exit
must not hide the threads) names what settled BLOCKED. From a `bro work
enter` worktree, `--merge --cleanup` also retires the worktree and
branch itself — no `;`-sequenced cleanup that could run on a failed
wait.

The caveat: a session-bound background task dies when the session ends.
For a watch that must outlive the session, arm it with `--detach` — the
wait re-spawns as its own process group (output on
`<git-common>/bro/act-wait-<pr>.log`), and its marker is the same record
`bro review act rearm` resurrects and session start flags when it dies.
`bro review drive install` and `bro review watch install` are the durable,
supervisor-wide forms.

## Stacked PRs and merge queues

GitHub refuses to merge a PR that belongs to a **stack** through either
`gh pr merge` (GraphQL) or the synchronous merge endpoint — _"must be
merged using the asynchronous merge REST API"_. `bro review act merge` detects
the stack (the `.stack` field on the PR, or the refusal itself) and merges
through the async endpoint instead, polling the request's uuid until it
settles. `bro review act wait --merge` is the same merge step, so a watcher on a
stack layer lands it too.

The same is true — and the same seam — when the base branch requires a
**merge queue**, stack or not: `bro review act merge` probes the PR's base for
one and enqueues through the async endpoint rather than attempting the
doomed `gh pr merge`. An accepted enqueue is **parked, not failed** — the
command reports `accepted but state=OPEN` and exits 0; the queue merges
later. `bro review drive` reads the same shape as an `enqueued` verdict — it
retires nothing and re-checks on the next pass.

Two details worth knowing:

- A merge queue owns the strategy. The request carries
  `merge_action=merge_queue` and no merge method; elsewhere the
  requested `--squash`/`--merge`/`--rebase` is honored.
- **The head branch is kept** on this path: deleting a lower layer's
  branch closes every PR stacked on it, and deleting a queued PR's head
  closes it. `--cleanup` still retires the local worktree and branch once
  the merge actually lands.

### External merge queues

When the queue lives outside GitHub, a connector owns the merge —
opt-in only, by name:

```json
{ "connectors": { "mergeQueue": "mergify" } }
```

- **`mergify`** — signals the PR: applies `act.mergeQueue.label` and/or
  posts the queue command (`act.mergeQueue.comment`, default
  `@mergifyio queue`). Your `.mergify.yml` rules decide what the signal
  means; bro never authors them.
- **`graphite`** — runs `gt merge` in the PR's checkout (from `bro work
  enter` or the worktree `bro review drive` hands it). The checkout must sit on
  the PR's head branch — `gt merge` queues the whole stack it sees, so a
  wrong checkout is refused, not queued.

Both hand off pinned to the gated head sha: a push after the gate makes
the enqueue refuse rather than queue a commit the gate never saw.

Configured or not, the merge still goes through the same exit gate and
merge slot — the connector only replaces the final `mergePr` call. An
`enqueued` result parks the PR exactly like a GitHub-queue hold.

## Never unwatched

A pushed PR is merged, watched, or handed off — never unwatched. `bro
review act wait <PR> --merge` in the background is the default end-state; the
stop gate enforces it — an armed session ending with an open, unwatched
current-branch PR is blocked once and pointed at the detached `act wait`
form (a running `bro review drive --every` counts as coverage via its per-PR
heartbeat markers). A `timed_out` watcher retires its marker on the way
out — start a fresh `act wait`; a watcher that _died_ leaves a dead
marker, the session-start nudge names it, and `bro review act rearm` puts the
watch back up. A watcher that _settled BLOCKED_ leaves a verdict marker
too — session-start flags the named blockers — and drops a keyed
mailbox event, so the finding reaches a session that never saw the
exit. `bro review act status` prints `watch=` so coverage is visible
before you stop.

**Merge through `bro review act merge`, never `gh pr merge`** — the gate is
enforced there.
