# bro — agent's sidekick

`bro` is a CLI carrying agent-workflow mechanics so prompts don't have to:
review debt on merged PRs, the open-PR review loop, and scoped drill frames
over beads. In a repo with `bro.config.json` or `.beads/`:

- `bro review act status` is the PR review gate — check it before declaring done;
  `bro review act threads` lists unresolved threads, `bro review act resolve`/`reply` mutate.
- `bro review debt collect` sweeps review debt on merged PRs; `bro review debt next`
  picks the top open finding.
- `bro work drill down`/`up` creates scoped descent frames; an open frame must be
  closed with `--result` before stopping.
- `bro self learn` is the lesson store — `bro self learn probe <question>` checks
  whether the store already knows the answer before re-investigating,
  `bro self learn capture` distills finished drill/retro/act/mol artifacts into
  trigger-gated lessons.
- Plugin hooks rehydrate state at session start/post-compaction and block
  Stop once while a drill frame, unresolved review threads, a dirty
  worktree, or this session's open bead claims remain — a repeated stop
  is let through (gates, not loops). The stop gate only hard-blocks
  sessions that touched the thing (`bro review act`/`gh pr`/`git push` arm `act`,
  `bro work drill`/`wtf` arm `drill`, worktree mutations arm `work`,
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
- **One portable package** — the product is an
  [Agent Plugin](https://agent-plugins.org/) whose skills are
  [Agent Skills](https://agentskills.io/): root `plugin.json` plus
  `skills/<name>/SKILL.md`. Those two specs are the contract for every
  agent. Claude, Codex, Cursor, Devin, and the rest get only the extra
  files that client needs on top — a hook event map, a client manifest.
  They do not get a `skills/` tree, a symlink to one, or a second
  portable manifest. A client that cannot see `skills/` until the
  plugin root is the repo root is installed from the repo root.
- **Config has three layers** — `~/.config/bro/config.{ts,json}` is the
  global operator file (providers, judge, fleet, agent spawn templates),
  `bro.config.{ts,json}` is committed project policy (act, sdd, guard,
  debt, stack), `bro.config.local.{ts,json}` is the gitignored
  machine-local override. They merge local > project > global; keep
  operator settings out of the committed file — `bro doctor` warns on
  misplaced sections.
- **Unified plans** — commands that take structured input (act, plan,
  backlog, retro, drill, …) accept a plan payload validated against a
  per-command plan schema; CLI flags alone are not the contract.
- **Verify like CI** — before claiming "tests pass", run the exact
  command CI runs (`npm test` → `tsx --test`), not a hand-picked
  runner; harness differences are real bugs' favorite hiding place.
  Local green ≠ PR green — after every push, `bro review act status` +
  `bro review act threads` are the only verdict.
- **Infra failures don't block** — the gate rule: project-caused
  failures (code, config, real findings) block; infrastructure failures
  (quota, outage, runner flakes) never do. A *failed* AI-reviewer check
  is pure infra — its findings arrive as threads, which block on their
  own. Reviewers that are *reliably* flaky go on `act.ignoreChecks` in
  bro.config.json so a stuck pending state doesn't block either —
  currently `"github-advanced-security"`, `"kilo"` (rate limits;
  advisory, may still be read — `check:docs` fails if this quote rots).
  The
  ignore is conditional: a failing ignored check is dropped quietly
  only after `consecutiveFailures` failing heads in a row *with*
  thread activity inside `threadWindowDays` — a failing check with no
  recent thread output surfaces as an alert (advisory, never a
  blocker), because a reviewer producing nothing is down, not flaky.
- **PR refs are links** — any user-facing reply or bro output line that
  names a PR renders it as `[#N](https://github.com/<owner>/<repo>/pull/N)`,
  never bare `#N`. `prLink()` in `@broject/core` formats it; TSV/data rows
  keep the bare number (parsed, not read).
- **Never leave uncommitted changes** — every unit of work lands on a
  branch, is committed, pushed, and opened as a PR. The draft flag
  mirrors the merge target: draft iff a human merges (`merge=human`);
  the convoy default (`merge=auto`) opens a ready PR — the act gate is
  the merge mechanism. A dirty tree at session end is lost work.
- **One executor per unit of work** — an interactive session (opencode,
  claude, a terminal) owns what it plans and executes it *there*; bro is
  the bus — the claim, the ledger, the mailbox, the supervision — plus a
  batch lane that takes only work nobody owns. The occupancy plane skips
  a worktree a live session armed (`green-occupied — session armed work
  on <slug>`), so bro's fixers never land where a session is working.
  Two writers on one tree is the conflict this rule exists to prevent:
  the lanes race for the same branch, the same PR, the same account's
  rate limit — a batch fixer that burns the whole devin worker budget
  starves the operator's own sessions, and a review bot's auto-fix push
  rewrites a branch mid-edit. Plan it in opencode → run it in opencode;
  plan it in bro → let bro run it. Never both.
- **Foreign findings become requests, never patches** — work that
  belongs to another repo is posted to that rig's inbox, never
  edited in place: `bro request <repo> <title> --for <bead>` drops
  the request bead and pins an `external:<rig>:<id>` edge on mine —
  a marker, not a gate; `bro mesh wait <id>` point-checks the
  answer between turns, and `bro wait external:<rig>:<id>` is the
  bounded watcher when the wait must block — armed like `act wait`,
  never a foreground idle. The dep edge in bd is the truth that
  frees the work; the watcher is a convenience, and its exit code
  is the verdict (0 free · 1 unreadable · 2 unresolved ·
  3 actionable · 4 timeout).

## Convoy fan-out — detach + pins

Running several molecules at once means spawning detached workers, never
serializing them inside one session. The spawn path is the facade —
`bro fleet agents`, `bro flow convoy run`, `bro review drive` — never a hand-rolled
nohup: an unregistered worker has no claim, no `.exit` record, no
`bro fleet agents status`/`down` reach, and it burns budget outside
`fleet.maxConcurrent` and the exit-cause taxonomy.

- **Spawn through the registry.** `bro fleet agents up <mol-step>` spawns one
  step's worker — the native backend is a `sh -c` spawn in its own
  process group, parent-unref'd (nohup-equivalent), wired through
  connector resolution, the `agents.<backend>.command` template, and
  the shared beads environment. A molecule **queue** is `bro flow convoy run
  <mol>…` (or `--open`) — sequential runner agents on the mol roots,
  crash/exit classification and the fleet cap included. Post-PR
  supervision is `bro review drive` — orphaned threads get a fixer agent,
  orphaned green PRs merge. Prompts and logs land in
  `<git-common>/bro/agents/` — never argv (every local user reads `ps`),
  never world-readable `/tmp`.
- **Pin the handles at spawn.** pid, log path, claimed step. The
  registry writes them to `<git-common>/bro/agents.json` plus
  `<git-common>/bro/agents/<agentId>.{prompt.md,log,exit}` and pins the
  claim into the shared beads store — `bro fleet agents status`, `down`, and
  respawn all key off that entry.
- **Monitor by point checks, never by waiting.** `bro fleet agents status`,
  `bro fleet`, `bro review watch`, a fresh `bro flow convoy next` — between turns,
  not in a blocking loop. A synchronous `get_output` or `sleep` wait on
  detached work blocks the conversation and buys nothing (retro
  bro-lmdj).
- **Completion is detected, not awaited.** `bro fleet agents status` →
  `exited`/`blocked`, then read the exit record — `<agentId>.exit`
  holds the code, the entry's `cause`/`resetAt` the why. `bro flow convoy
  run` already supervises its own spawns to a verdict — hand a mol list
  to it instead of babysitting. Never promise "I'll report when it
  lands" from a foreground wait.

## Cursor Cloud specific instructions

- **Node on PATH:** the platform shim may expose Node <22.18. `scripts/cloud-agent-install.sh` installs Node ≥22.18 into `/usr/local/bin` but cannot change the calling shell's PATH — run `export PATH="/usr/local/bin:$PATH"` in your current shell before `node`, `npm`, or `bro`.
- **Bootstrap:** `bash scripts/cloud-agent-install.sh` (same as `.cursor/environment.json` `install`) — `npm ci`, checksum-verified `bd` binary into `/usr/local/bin` when missing.
- **Verify like CI:** `npm run build`, `npm run typecheck`, `npm test` (root `package.json`; matches `.github/workflows/ci.yml` plus `check:plugins` / `check:embedded`).
- **Smoke the CLI:** after build, `./packages/cli/dist/index.js doctor` and `./packages/cli/dist/index.js debt status` (needs `gh` authenticated).
