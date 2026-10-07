---
name: act
description: "Use when the user invokes /act on an open PR or a 'bro: PR #N ...' status ping arrives — the review-fix loop. Thin wrapper over the bro CLI: `bro act status` is the exit gate as code; resolve/reply are mutations. Requires `bro` (npx -y @broject/bro@0) and gh."
---

# /act (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only — do not
reimplement what `bro act` already does.

Prereq: `bro` on PATH or `npx -y @broject/bro@0` (major-pinned). Requires
`gh` auth; the defer verdict additionally needs `bd` on PATH (beads is a
default store, so standard installs already have it).

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro act status [PR] [--json]` | PR state + **exit gate** — open threads, CI failures, SAST findings. Exits non-zero while blocked |
| `bro act threads [PR]` | Unresolved review threads, TSV |
| `bro act wait [PR] [--interval S] [--timeout M] [--merge] [--cleanup]` | Poll the gate until it settles — green, blockers, or timeout. `--merge` lands the PR on green; add `--cleanup` to retire the worktree the command runs in + the local branch after the merge lands |
| `bro act rearm [--dry-run] [--json]` | Resurrect dead watchers: each PR whose `act wait` died (host reboot, turn teardown) gets a fresh detached wait with the recorded `--merge`/`--cleanup`/`--timeout`; settled PRs' markers sweep, unverifiable PRs keep theirs |
| `bro act merge [PR] [--squash\|--merge\|--rebase] [--admin] [--cleanup]` | Merge **only if the exit gate is green** — serialized on the beads merge slot (best-effort: without beads the merge proceeds unserialized); BLOCKED refuses and names blockers. `--cleanup` retires the merged branch's checkout (when run inside it) + local ref |
| `bro act resolve --thread ID [--comment T]` | Resolve a thread (reply first if comment given) |
| `bro act reply --thread ID --comment T` | Reply without resolving (`--file TSV` for batch) |

## Policy

- **Loop until the exit gate is green.** `bro act status` returns non-zero
  with named blockers — keep fixing until it passes; do not self-declare done.
  **Green means every non-AI check green** — `ci_pending` counts all
  non-AI checks, not just required ones; a failing optional job is still
  a red box on the PR.
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
  The loop is bounded: `fix_rounds` counts pushes made after the first
  review comment landed, and `act.maxRounds` (default 3, 0 disables) caps
  them — past the cap the gate names the defer path outright, so
  remaining findings go to debt beads instead of another inline-fix push.
  Docs-only PRs (every changed file matches `act.docsPaths`) cap tighter —
  `act.docsMaxRounds` (default 2): doc threads churn per push, so the
  tail belongs in debt, not another round.
- **Contradictory cross-round findings resolve by judgment, not push.**
  Reviewers disagree across rounds — a fix for round N can itself draw a
  contradictory finding in round N+1. Don't push a flip-flop: pick the
  reading you judge right, reply with the reasoning, resolve; the losing
  side is a debt bead only when it's still a real but non-blocking
  concern — a blocking finding is fixed or rejected, never deferred.
- **Merge through `bro act merge`, never `gh pr merge` directly.** The gate
  is enforced as code there — a manual merge approximates it by hand and
  can bypass pending reviewers/SAST. `bro act merge` also serializes the
  merge on the beads merge slot (`bd merge-slot`): a held slot means another
  session is mid-merge — wait for `bd merge-slot check` to report available;
  a crashed holder is freed with `bd merge-slot release`. Only a
  user-directed override justifies merging around a BLOCKED gate.
- **Wait via `bro act wait <PR>` in the background, never a bespoke poll
  loop.** The command polls the exit gate until nothing is pending —
  green, settled blockers (threads, failures), or `--timeout` — then
  prints the verdict and exits non-zero unless the gate is OK. Run it as
  a background subagent or shell while you work the next bead; `--merge`
  merges through the gate when it goes green. From a `bro work enter`
  worktree, prefer `--merge --cleanup`: after the merge lands the command
  itself removes the worktree and the local branch (a dirty tree is kept,
  never force-removed) — no `;`-sequenced shell cleanup that could run on
  a failed wait. On a settled BLOCKED, run
  `bro act threads <PR>` as a separate command (never `status && threads`
  — a failing exit must not hide the threads). `gh pr checks --watch` is
  the fallback only where bro isn't installed.
- **A background task dies when your turn ends** — it is only watching
  while you are. Never end a reply that promises "will report when it
  lands" on a session-bound watcher: keep polling inside the reply until
  the gate settles, spawn the watch detached (`nohup`/`systemd-run`/
  `tmux`), or hand off with the exact open state spelled out.
- **Resolve silently when you fixed it.** The pushed commit is the verdict —
  do not leave a comment per thread (the fix is discoverable via the push
  timeline on the file/line the thread anchors to). Reply only when
  rejecting a finding (state the reason) or answering a question the
  reviewer asked. If a thread needs an explicit audit marker, pass
  `--comment <sha>` — a bare SHA, not prose.
- **Resolving is not the gate — a fix push re-opens review.** After the
  last `bro act resolve` of a round, `bro act status` on the *new head*
  decides: fresh findings land on every push, so the loop exits only on
  `exit_gate=OK` or hands off to `bro act wait --merge`. Never report a
  PR as done from the resolve output alone.
- **A pushed PR is merged, watched, or handed off — never unwatched.**
  `bro act wait <PR> --merge` in the background is the default end-state;
  a watcher exit is a state to inspect, not silence — a `timed_out` exit
  means the PR is still open, so start a fresh `bro act wait --merge`
  (a timeout retires its marker on the way out, so `act rearm` has
  nothing to resurrect — re-arming there is manual). A watcher that
  *died* with the host/session never ran that cleanup — its dead marker
  stays, the session-start nudge names it, and `bro act rearm` puts the
  watch back up.
  The stop gate enforces this: an armed session ending with an open,
  unwatched current-branch PR is blocked once and pointed at the detached
  `act wait` form — a running `bro drive --every` counts as coverage via
  its per-PR heartbeat markers. `bro act status` prints `watch=` so the
  coverage is visible before you stop.
- **Report with links, not text.** Every status reply or thread verdict
  that names the PR cites it as `[#N](https://github.com/<owner>/<repo>/pull/N)`
  — `bro act status` prints the URL on its `pr=` line, carry it through.
  A bare `#N` is just text in every UI that renders these reports.
- **Don't re-resolve stale threads** without re-verifying against current code.
- Debt rows from `bro debt list` become work via
  `bro debt set claimed --thread-id <id>` → fix →
  `bro debt set done --thread-id <id> --fix-pr N` → `bro debt sync` closes
  the bead.
