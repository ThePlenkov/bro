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
| `bro act wait [PR] [--interval S] [--timeout M] [--merge]` | Poll the gate until it settles — green, blockers, or timeout. `--merge` lands the PR on green |
| `bro act merge [PR] [--squash\|--merge\|--rebase] [--admin]` | Merge **only if the gate is green** — refuses and names blockers |
| `bro act resolve --thread ID [--comment T]` | Resolve (reply first if comment given); `--unresolve` reopens |
| `bro act reply --thread ID --comment T` | Reply without resolving; `--file TSV` for batch |

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
go on [`act.ignoreChecks`](/bro/configuration/#act).

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
to debt beads, do not fix inline.*

**Merge through `bro act merge`, never `gh pr merge`** — the gate is
enforced there.
