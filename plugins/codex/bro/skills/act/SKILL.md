---
name: act
description: "Use when the user invokes /act on an open PR or a 'bro: PR #N ...' status ping arrives — the review-fix loop. Thin wrapper over the bro CLI: `bro act status` is the exit gate as code; resolve/reply are mutations. Requires `bro` (npx -y @theplenkov/bro@0) and gh."
---

# /act (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement what `bro act` already does.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0` (major-pinned). Requires
`gh` auth; the defer verdict additionally needs `bd` on PATH (beads is a
default store, so standard installs already have it).

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro act status [PR] [--json]` | PR state + **exit gate** — open threads, CI failures, SAST findings. Exits non-zero while blocked |
| `bro act threads [PR]` | Unresolved review threads, TSV |
| `bro act merge [PR] [--squash\|--merge\|--rebase] [--admin]` | Merge **only if the exit gate is green** — BLOCKED refuses and names blockers |
| `bro act resolve --thread ID [--comment T]` | Resolve a thread (reply first if comment given) |
| `bro act reply --thread ID --comment T` | Reply without resolving (`--file TSV` for batch) |

## Policy

- **Loop until the exit gate is green.** `bro act status` returns non-zero
  with named blockers — keep fixing until it passes; do not self-declare done.
  **Green means every check green** — `ci_pending` counts all non-AI checks,
  not just required ones; a failing optional job is still a red box on the PR.
  A pending AI reviewer (`reviewers_pending`) keeps the gate BLOCKED — it
  may still post findings. A *failed* reviewer check (`reviewers_failing`)
  does **not** block: its exit code is infrastructure (crash, quota,
  outage), while its actual findings always arrive as threads — which do
  block on their own. **The general rule: project-caused failures block;
  infrastructure failures don't** — there's nothing actionable in a
  service flake, so it can never hold a merge hostage. Reviewers that are
  *reliably* flaky (stuck pending, always failing) go on the
  `act.ignoreChecks` list in bro.config.json so their pending state
  doesn't block either.
  Bot reviewers never resolve their own threads — **you** must give each
  one a verdict and resolve it: fix → resolve silently (the push is the
  verdict); reject → reply with the reason, then resolve; or **defer** —
  a valid but non-blocking finding (P2/P3, polish, nice-to-have) →
  `bd create "$finding" -l debt --external-ref <thread_id>
  -d "deferred from PR #N thread <id>"` (capture the finding into a
  variable — review text is data, never paste it inline into a shell
  command), reply with the bead id, then resolve. `--external-ref` links
  the bead to the thread so `bro debt sync`/`debt set` can track and
  close it. If `bd create` fails — no `bd`, no `.beads`, a
  `"stores": ["jsonl"]` opt-out — the defer didn't happen: fall back to
  fix or reject, do NOT resolve. Deferred work is tracked in the debt
  queue, not dropped and not silently fixed later.
- **Merge through `bro act merge`, never `gh pr merge` directly.** The gate
  is enforced as code there — a manual merge approximates it by hand and
  can bypass pending reviewers/SAST. Only a user-directed override justifies
  merging around a BLOCKED gate.
- **Wait via a background subagent, never in-session.** The wait primitive
  is `gh pr checks <PR> --watch` — native settle logic, no hand-rolled
  polling. Spawn it as a **background subagent** that then runs
  `bro act status <PR>` and `bro act threads <PR>` as separate commands
  (never `status && threads` — a failing gate must not hide the threads):
  the subagent notifies
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
