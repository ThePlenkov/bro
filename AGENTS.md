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
  Stop once while a drill frame or unresolved review threads remain — a
  repeated stop is let through (gates, not loops). The stop gate only
  hard-blocks sessions that touched the PR or drill frame (`bro act`,
  `gh pr`, `git push`, `bro drill`/`wtf` arm it via a per-session marker);
  ambient repo state is passive context for everyone else.

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
