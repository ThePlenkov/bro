---
title: bro act
description: The open-PR review loop — exit gate as code, merge only when green.
---

`bro act` answers the question an agent can't: *"can I stop now?"* The
gate is code, not a prompt instruction — it counts open threads, pending
checks, SAST annotations, mergeability, and fix rounds.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro act status [PR] [--json]` | PR state + exit gate. Non-zero while blocked |
| `bro act threads [PR]` | Unresolved review threads, TSV |
| `bro act wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup]` | Poll the gate until it settles — green, blockers, or timeout. `--merge` lands the PR on green; `--cleanup` requires `--merge` and retires the merged worktree and local branch |
| `bro act merge [PR] [--squash\|--merge\|--rebase] [--admin] [--cleanup]` | Merge **only if the gate is green** — refuses and names blockers; `--cleanup` retires the checkout the command runs in when safe, and keeps the local branch if another worktree still checks it out |
| `bro act resolve --thread ID [--comment T]` | Resolve (reply first if comment given); `--unresolve` reopens |
| `bro act reply --thread ID --comment T` | Reply without resolving; `--file TSV` for batch |
| `bro act rearm [--dry-run] [--json]` | Resurrect dead PR watchers — respawn `act wait` for open PRs whose watch marker outlived its process; settled markers are swept, live ones kept |

## The gate

`bro act status` exits non-zero with named blockers:

- `open_threads` — unresolved review threads
- `ci_pending` — every non-AI check must be green; a failing *optional*
  job is still red
- `reviewers_pending` — a running AI reviewer may still post findings
- `sast_pending` / `sast_unknown` — failure-level SAST annotations
- `fix_rounds` — pushes after the first review comment

**The general rule: project-caused failures block; infrastructure
failures don't.** A failed AI-reviewer *check* (`reviewers_failing`) is
infra noise — crash, quota, outage — reported but never blocking. Its
real findings arrive as threads, which do block. Chronically flaky checks
go on [`act.ignoreChecks`](/docs/configuration#act) — a conditional
ignore: a failing advisory check stays quiet only while it keeps failing
*and* producing thread output, otherwise `alerts` carries a
silent-reviewer line (still non-blocking).

## The severity-aware loop

Every push re-triggers reviewers — endless inline fixing is a treadmill.
So the loop is bounded and severity-aware:

- **Correctness/blocking findings** → fix inline, resolve silently (the
  push is the verdict)
- **Valid but non-blocking (P2/P3, polish)** → defer: `bd create`
  with `--external-ref <thread_id>`, reply with the bead id, resolve
- **Wrong findings** → reply with the reason, resolve

`act.maxRounds` (default **3**, `0` disables) caps inline fix rounds.
Past it, the gate's blocker changes its verdict: *defer remaining threads
to debt beads, do not fix inline.* Docs-only PRs — every changed file
matching `act.docsPaths` — cap tighter at `act.docsMaxRounds` (default
**2**): doc threads churn per push, so the tail belongs in debt sooner.
`docs_only=true` in `act status` marks a docs-only PR.

Contradictory findings across rounds resolve by **judgment, not push** —
a fix for round N can draw a contradictory finding in round N+1; a
flip-flop commit just buys a fresh round. Pick the right reading, reply
with the reasoning, resolve; a real concern on the losing side becomes a
debt bead.

With [`judge.mode: "shadow"`](/docs/configuration#judge), `bro act
threads` annotates each unresolved row with a `judge: …` line — the
verdict is journaled so `bro judge stats` can score judge-vs-outcome
agreement.

## Don't wait — background it

`bro act wait` does the waiting so your turn doesn't. The pattern: push,
then `bro act wait <PR> --merge` in a background shell — not even a
subagent, so the wait costs zero tokens — and take the next bead. When
the shell finishes it carries the verdict: exit 0 and the merge landed,
or non-zero and `bro act threads <PR>` (a separate call — a failing exit
must not hide the threads) names what settled BLOCKED. From a `bro work
enter` worktree, `--merge --cleanup` also retires the worktree and
branch itself — no `;`-sequenced cleanup that could run on a failed
wait.

The caveat: a session-bound background task dies when the session ends.
For a watch that must outlive the session, spawn it detached or let
`bro act rearm` resurrect the dead marker on the next session's nudge —
`bro drive --every` and `bro watch install` are the durable forms.

## Stacked PRs and merge queues

GitHub refuses to merge a PR that belongs to a **stack** through either
`gh pr merge` (GraphQL) or the synchronous merge endpoint — *"must be
merged using the asynchronous merge REST API"*. `bro act merge` detects
the stack (the `.stack` field on the PR, or the refusal itself) and merges
through the async endpoint instead, polling the request's uuid until it
settles. `bro act wait --merge` is the same merge step, so a watcher on a
stack layer lands it too.

The same is true — and the same seam — when the base branch requires a
**merge queue**, stack or not: `bro act merge` probes the PR's base for
one and enqueues through the async endpoint rather than attempting the
doomed `gh pr merge`. An accepted enqueue is **parked, not failed** — the
command reports `accepted but state=OPEN` and exits 0; the queue merges
later. `bro drive` reads the same shape as an `enqueued` verdict — it
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
  enter` or the worktree `bro drive` hands it). The checkout must sit on
  the PR's head branch — `gt merge` queues the whole stack it sees, so a
  wrong checkout is refused, not queued.

Configured or not, the merge still goes through the same exit gate and
merge slot — the connector only replaces the final `mergePr` call. An
`enqueued` result parks the PR exactly like a GitHub-queue hold.

## Never unwatched

A pushed PR is merged, watched, or handed off — never unwatched. `bro
act wait <PR> --merge` in the background is the default end-state; the
stop gate enforces it — an armed session ending with an open, unwatched
current-branch PR is blocked once and pointed at the detached `act wait`
form (a running `bro drive --every` counts as coverage via its per-PR
heartbeat markers). A `timed_out` watcher retires its marker on the way
out — start a fresh `act wait`; a watcher that *died* leaves a dead
marker, the session-start nudge names it, and `bro act rearm` puts the
watch back up. A watcher that *settled BLOCKED* leaves a verdict marker
too — session-start flags the named blockers — and drops a keyed
mailbox event, so the finding reaches a session that never saw the
exit. `bro act status` prints `watch=` so coverage is visible
before you stop.

**Merge through `bro act merge`, never `gh pr merge`** — the gate is
enforced there.
