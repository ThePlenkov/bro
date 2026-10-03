# bro — agent's sidekick

`bro` is a CLI carrying agent-workflow mechanics so prompts don't have to:
review debt on merged PRs, the open-PR review loop, and scoped drill frames
over beads. In a repo with `bro.config.json` or `.beads/`:

- `bro act status` is the PR review gate — check it before declaring done;
  `bro act threads` lists unresolved threads, `bro act resolve`/`reply` mutate.
- `bro debt collect` sweeps review debt on merged PRs; `bro debt next`
  picks the top open finding.
- `bro drill down`/`up` creates scoped descent frames; an open frame must be
  closed with `--result` before stopping.
- Plugin hooks rehydrate state at session start/post-compaction and block
  Stop once while a drill frame, unresolved review threads, a dirty
  worktree, or this session's open bead claims remain — a repeated stop
  is let through (gates, not loops). The stop gate only hard-blocks
  sessions that touched the thing (`bro act`/`gh pr`/`git push` arm `act`,
  `bro drill`/`wtf` arm `drill`, worktree mutations arm `work`,
  `bd --claim`/`bro work enter` arm `task` — per-session markers in the
  common git dir); ambient repo state is passive context for everyone
  else. Each contribution is a connector's `stopGate` probe — the hook
  owns the arming policy, connectors only report state. Session-start
  context also nudges when another live session armed work in the same
  repository — markers live in the common git dir, so detection spans
  linked worktrees (fresh `.work` markers, other worktrees, claimed
  beads) — detection only, never a block.

Developing bro itself: see CONTRIBUTING.md.

## Conventions

- **Pure TypeScript, no `.mjs`/`.cjs`** — Node ≥22.18 runs `.ts` natively
  (unflagged type stripping); scripts and sources are always `.ts`,
  invoked directly (`node scripts/x.ts`).
- **Plugin-shaped growth** — each capability ships as a CLI subcommand +
  skill + config section. bro is a plugin system on top of beads (and more):
  agents orchestrate by pushing work into shared, schema-validated plans
  and workflows rather than re-deriving mechanics in prompts.
- **Unified plans** — commands that take structured input (act, plan,
  backlog, retro, drill, …) accept a plan payload validated against a
  per-command plan schema; CLI flags alone are not the contract.
- **Verify like CI** — before claiming "tests pass", run the exact
  command CI runs (`npm test` → `tsx --test`), not a hand-picked
  runner; harness differences are real bugs' favorite hiding place.
  Local green ≠ PR green — after every push, `bro act status` +
  `bro act threads` are the only verdict.
- **Infra failures don't block** — the gate rule: project-caused
  failures (code, config, real findings) block; infrastructure failures
  (quota, outage, runner flakes) never do. A *failed* AI-reviewer check
  is pure infra — its findings arrive as threads, which block on their
  own. Reviewers that are *reliably* flaky go on `act.ignoreChecks` in
  bro.config.json so a stuck pending state doesn't block either —
  currently `"kilo"` (rate limits; advisory, may still be read).
- **PR refs are links** — any user-facing reply or bro output line that
  names a PR renders it as `[#N](https://github.com/<owner>/<repo>/pull/N)`,
  never bare `#N`. `prLink()` in `@broject/core` formats it; TSV/data rows
  keep the bare number (parsed, not read).
- **Never leave uncommitted changes** — every unit of work lands on a
  branch, is committed, pushed, and opened as a draft PR. A dirty tree
  at session end is lost work.

## Convoy fan-out — detach + pins

Running several molecules at once means spawning detached workers, never
serializing them inside one session. The pattern has two halves: the
spawn is **detached**, its handles are **pinned** somewhere durable.

- **Spawn detached.** `bro agents up <mol-step>` is the path — the
  native backend is a `sh -c` spawn in its own process group,
  parent-unref'd (nohup-equivalent), wired through connector resolution,
  the configured agent template, and the shared beads environment. The
  hand-rolled form —
  `nohup devin -p --export ~/.bro/agents/<mol>.json -- "<prompt>" >> ~/.bro/agents/<mol>.log 2>&1 &`
  (systemd-run/tmux also count) — skips all of that: no registry entry,
  no managed claim, no `bro agents status`/`down` reach. Keep logs in a
  user-owned dir — prompts land in them, so world-readable `/tmp` is
  out. An exec-background shell dies with the turn — a worker spawned
  that way is already unwatched.
- **Pin the handles at spawn.** pid, log path, claimed step. `bro agents`
  writes them to `<git-common>/bro/agents.json` plus
  `<agentId>.{prompt.md,log,exit}` and pins the claim into the shared
  beads store — a hand-rolled spawn must record pid + log + claimed step
  itself (a file, a bead comment); it stays outside the registry, so its
  pin file is the
  only handle `status`, `stop`, or respawn will never see. An unpinned
  worker is unfindable next session.
- **Monitor by point checks, never by waiting.** `tail` the log,
  `kill -0 <pid>` / `pgrep -f`, `bro agents status`, `bro fleet`, a fresh
  `bro convoy next` — between turns, not in a blocking loop. A synchronous
  `get_output` or `sleep` wait on detached work blocks the conversation
  and buys nothing (retro bro-lmdj).
- **Completion is detected, not awaited.** `bro agents status` →
  `exited` with its `.exit` code, the step closing in beads — or a
  detached watcher shell that polls and `bro notify`s. An empty `pgrep`
  only proves the process died, not that it finished: read the exit code
  or the step state, not the silence. Never promise "I'll report when it
  lands" from a foreground wait.
