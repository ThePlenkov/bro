---
name: bro-act
description: "Use when the user invokes /act on an open PR — the review-fix loop. Thin wrapper over the bro CLI: `bro act status` is the exit gate as code; resolve/reply are mutations. Requires `bro` (npx -y @theplenkov/bro@0) and gh."
---

# /act (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement what `bro act` already does.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0` (major-pinned). Requires
`gh` auth.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro act status [PR] [--json]` | PR state + **exit gate** — open threads, CI failures, SAST findings. Exits non-zero while blocked |
| `bro act threads [PR]` | Unresolved review threads, TSV |
| `bro act resolve --thread ID [--comment T]` | Resolve a thread (reply first if comment given) |
| `bro act reply --thread ID --comment T` | Reply without resolving (`--file TSV` for batch) |

## Policy

- **Loop until the exit gate is green.** `bro act status` returns non-zero
  with named blockers — keep fixing until it passes; do not self-declare done.
  **Green means every check green** — `ci_pending` counts all non-AI checks,
  not just required ones; a failing optional job is still a red box on the PR.
  A pending AI reviewer (`reviewers_pending`) keeps the gate BLOCKED, and a
  *failed* reviewer check (`reviewers_failing`) blocks too — the review may
  never have run; re-run it or push to retrigger.
  Bot reviewers never resolve their own threads — **you** must give each
  one a verdict and resolve it: fix → resolve silently (the push is the
  verdict), or reject → reply with the reason, then resolve.
- **Wait via a background subagent, never in-session.** The wait primitive
  is `gh pr checks <PR> --watch` — native settle logic, no hand-rolled
  polling. Spawn it as a **background subagent** chained with
  `bro act status <PR>` and `bro act threads <PR>`: the subagent notifies
  on completion and returns the gate report; a plain background shell
  stays silent until polled, so it is only a fallback.
- **Resolve silently when you fixed it.** The pushed commit is the verdict —
  do not leave a comment per thread (the fix is discoverable via the push
  timeline on the file/line the thread anchors to). Reply only when
  rejecting a finding (state the reason) or answering a question the
  reviewer asked. If a thread needs an explicit audit marker, pass
  `--comment <sha>` — a bare SHA, not prose.
- **Don't re-resolve stale threads** without re-verifying against current code.
- Debt rows from `bro debt list` become work via
  `bro debt set claimed --thread-id <id>` → fix →
  `bro debt set done --thread-id <id> --fix-pr N` → `bro debt sync` closes
  the bead.
