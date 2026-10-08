---
name: retro
description: "Use at session end — before the final answer or when the retro-on-stop guard fires. A short self-review checklist: uncommitted work, hand-rolled scripts that could become bro commands or beads, token/call economy, lesson capture, review-debt sweep, state assertions. Requires `bro` (npx -y @broject/bro@0) and bd."
---

# retro — session-end retrospective

Run once per session, at the end, before the final status. The point is
not ceremony — it is noticing what the session revealed that its
deliverable didn't capture: tool gaps, repeated mechanics, ignored debt.

## Checklist

1. **Loose ends.** `git status` clean? PRs merged, watched, or handed off?
   `bd` in_progress = 0 or justified? A dirty tree at session end is lost
   work — same for an unwatched PR.
2. **Hand-rolled mechanics → codemod candidates.** Every ad-hoc script,
   jq pipeline, or multi-step shell one-liner written this session is a
   signal: if the mechanics are general, `bro` should own them. File a
   `bd` gap bead (title says the missing command, body quotes the
   one-liner that had to be invented) — or implement it if the surface
   already exists. Example that made this real: a hand-written
   `agents.json` prune script → `bro-k7a1` (`bro agents prune` missing).
3. **Call economy.** Count the calls that repeated one pattern —
   N `bd close`s, N `gh api` fetches, N status polls. If one `bro`
   command could batch them, that is the same kind of gap bead.
4. **Lessons.** `bro learn capture --dry-run` previews what the session
   would distill — if a reusable insight shows up (a workaround, a trap,
   a convention), rerun without `--dry-run` to store it, so the next
   session starts smarter, not just the next human.
5. **Debt sweep.** PRs merged this session → `bro debt collect` picks up
   reviewer findings left unresolved. Never leave them to rot.
6. **State assertions.** Verify from authoritative checks, not memory:
   `gh pr view` for merges, `git worktree list` for cleanup,
   `bd show` for beads. A watcher exit is a state to inspect, not silence.

## Policy

- **Scale to the session.** A one-shot Q&A that touched nothing skips
  with a single line — retro is a review, not busywork. A session that
  wrote code, merged PRs, or spawned agents does the full pass.
- **Beads, not prose.** Findings land as `bd` items — never as a
  paragraph the user has to convert into work themselves.
- **The guard is the doorbell, this skill is the room.** The
  `retro-on-stop` guard fires the one-line nudge; this checklist is what
  "ran the retro" actually means.
