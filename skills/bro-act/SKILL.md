---
name: bro-act
description: "Use when the user invokes /act on an open PR — the review-fix loop. Thin wrapper over the bro CLI: `bro act status` is the exit gate as code; resolve/reply are mutations. Requires `bro` (npx @theplenkov/bro) and gh."
---

# /act (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement what `bro act` already does.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0` (major-pinned). Requires
`gh` auth.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro act status [PR] [--json]` | PR state + **exit gate** — open threads, pending CI, SAST findings. Exits non-zero while blocked |
| `bro act threads [PR]` | Unresolved review threads, TSV |
| `bro act resolve --thread ID [--comment T]` | Resolve a thread (reply first if comment given) |
| `bro act reply --thread ID --comment T` | Reply without resolving (`--file TSV` for batch) |

## Policy

- **`bro act` is for PRs you did not author.** `resolve`/`reply` refuse to
  run on your own PR — the author closing their own review threads is
  self-grading. On your own PR use `status`/`threads` (read-only) and let a
  human or the reviewer resolve.
- **Loop until the exit gate is green.** `bro act status` returns non-zero
  with named blockers — keep fixing until it passes; do not self-declare done.
  A pending AI reviewer (`reviewers_pending`) blocks the gate — wait for it.
- **Resolve silently when you fixed it.** The pushed commit is the verdict —
  do not leave a comment per thread. Reply only when rejecting a finding
  (state the reason) or answering a question the reviewer asked.
- **Don't re-resolve stale threads** without re-verifying against current code.
- Debt rows from `bro debt list` become work via
  `bro debt set claimed --thread-id <id>` → fix →
  `bro debt set done --thread-id <id> --fix-pr N` → `bro debt sync` closes
  the bead.
