# act: resolve the current PR when no number is given

Bead: `bro-v6pph` (task).

## Problem

`bro act <sub>` with no PR number resolves the current branch's PR. From a
non-PR branch (`main` — the operator's daily driver) there is none, so every
bare invocation dies with exit 2. The operator's intent from `main` is
uniform: act on *the* current PR — the one being worked on.

## Decision

Resolution order for `resolvePr(rev, argv, mode)`:

1. `--pr N` / first positional → explicit, any mode.
2. Current branch's open PR → any mode (unchanged).
3. **Auto:** the repo's most recently updated open PR — row 0 of
   `openPrs(repo)` — subject to `mode`:
   - `mode: 'read'` → accepted, announced on stderr:
     `act: resolved current PR #N — most recently updated open PR`.
   - `mode: 'strict'` → refused, exit 2, before any mutation runs:
     `error: refusing to act on auto-resolved PR #N — pass a PR number`.
4. No auto source (host without `openPrs`, zero open PRs) → exit 2 with the
   guidance message (state the PR-number syntax and `bro watch`).

`mode` per subcommand:

| subcommand | mode |
| --- | --- |
| `status`, `threads` | read |
| `wait` | read; an auto target gets **no update-branch push** — a recency guess is not an authorization (strix CWE-862) |
| `wait --detach` | strict — the detached child mutates with the parent's target |
| `wait --merge`, `wait --detach --merge` | strict |
| `merge` | strict |
| `resolve`, `reply` | never resolve a PR target for their own work (threads act by id); the post-hoc ledger `recordResolve` runs 'record' mode and **skips the row** when only an auto target exists — attributing a thread to the wrong PR poisons the reopen guard (codeant) |

Messages name the PR through `rev.prLink(repo, pr)` — clickable
references, per the repo-wide link rule.

## Ordering contract change

`ReviewFacade.openPrs(repo)` gains a documented order: **most recently
updated first**. GitHub: `gh api repos/<repo>/pulls?state=open&sort=updated
&direction=desc&per_page=100` — the REST endpoint sorts natively
(`gh pr list` has no sort flags and pages by creation time). GitLab:
`order_by=updated_at&sort=desc` (was default-desc, now explicit).
Callers today treat it as a set (watch gates, discovery) — order-insensitive.

## Non-goals

- No board-by-default behavior for bare `bro act` (it stays `status`).
- No session-memory of "the PR this session drove" — the deterministic
  signal is the host's recency, announced every time it is used.
- `bro status` (status.ts) keeps branch-only resolution.

## Acceptance

- From `main` with open PRs: `bro act` prints status for the most recently
  updated PR with the resolution notice; `bro act merge` exits 2 with the
  refusal.
- From a PR branch: behavior unchanged, no notice.
- Host without `openPrs` / zero open PRs: exit 2, guidance message.
- Unit tests cover: explicit, branch, auto-read, strict-refusal, no-source.
