# bro 🤝

[![npm](https://img.shields.io/npm/v/@broject/bro)](https://www.npmjs.com/package/@broject/bro)
[![CI](https://github.com/ThePlenkov/bro/actions/workflows/ci.yml/badge.svg)](https://github.com/ThePlenkov/bro/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org)

> Your agent's sidekick. Skills are instructions — **bro is the brain.**
>
> **Landing:** [broject.dev](https://broject.dev) · **Docs:** [broject.dev/docs](https://broject.dev/docs/)

Your AI agent can read a PR. Can it tell which merged PRs still have
unresolved review threads rotting in them? Can it say "bro, what's left?"

Now it can.

```bash
npx @broject/bro debt prs        # merged PRs nobody processed yet
npx @broject/bro debt collect    # sweep them, label them debt:collected
npx @broject/bro debt status     # the damage report
```

## What's the deal

Review bots dump comments on your PRs. You merge, the threads stay
unresolved, the findings evaporate. `bro` harvests them into a local
ledger (`.agents/review-debt/`) and slaps `debt:*` labels on the PRs it
already swept — so nothing gets scanned twice and nothing hides.

```text
PR merged → bro debt collect → findings land in .agents/review-debt/
                            → PR gets debt:collected (or debt:clean)
                            → you see exactly what's left: bro debt prs
```

## What bro does now

- **One agent:** `act`, `drill`, `wtf`/`retrospect`, `learn`, `spec` — review, descend, remember, and keep work pointed at a spec.
- **The queue:** `next`, `loop`, `convoy`, `stack`, `work` — move beads through worktrees and PRs without another status meeting.
- **The fleet:** `agents`, `fleet`, `watch`, `notify`, `drive`, `serve` — supervise detached work; wake up when there's news.

## Install

```bash
npx -y @broject/bro --help     # zero install
npm i -g @broject/bro          # or keep bro around: bro debt status
```

Requires: `node >= 22.18`, `gh` authenticated, `bd`
([beads](https://github.com/gastownhall/beads)) — it's a default store, so
it's required unless you opt out. That's it. No tokens to babysit, no
config files to confess to. (Zero-beads fallback: `"stores": ["jsonl"]`
in `bro.config.json`.)

## Install as an agent plugin

This repo is a plugin marketplace + registry — one `bro` plugin packaged
per client:

| Client | Install |
| ------ | ------- |
| Devin | `devin plugins install ThePlenkov/bro` (or `ThePlenkov/bro#plugins/devin/bro`) |
| Claude Code | `/plugin marketplace add ThePlenkov/bro` → `/plugin install bro@bro` |
| Codex | `codex plugin marketplace add ThePlenkov/bro` → install `bro` |
| OpenCode | add `"plugin": ["@broject/bro"]` to `opencode.json` |

Every adapter ships the same skills and lifecycle hooks (session
rehydration, review-gate stop, self-approve for `bro`/`bd`) wired through
`hooks/run.sh` — local dist → `bro` on PATH → major-pinned `npx`, always
fail-open.

OpenCode is the exception: it loads JS/TS modules instead of a hook manifest,
so `bro` ships as a native plugin (`packages/cli/src/opencode.ts`, published
as the package's `./server` export) that spawns its own CLI. This entry uses
OpenCode's V1 plugin API and does not run on V2. Two consequences:

- **Install by package name only.** OpenCode's loader reads `exports["./server"]`
  from the installed package and does not accept subpath specifiers — `"@broject/bro/opencode"`
  is not a valid entry. Pin a build with
  `"plugin": [["@broject/bro", { "command": { "cmd": "/path/to/bro" } }]]`.
- **The stop gate re-prompts instead of blocking.** OpenCode has no pre-stop
  hook; `session.idle` arrives after the turn is over. bro feeds the blocker
  back as a synthetic turn **once per session** — a second block is logged, not
  re-prompted. Same "gates, not loops" rule the other adapters get from
  `stop_hook_active`, and an aborted or errored turn never gates at all.

## Commands

Full reference: [broject.dev/docs](https://broject.dev/docs).

### Review & debt

| Command | What bro does |
| ------- | ------------- |
| `bro act status [PR]` | **Exit gate as code** — open threads, pending CI, SAST findings, mergeability; non-zero while blocked |
| `bro act threads [PR]` | List unresolved review threads |
| `bro act resolve --thread ID [--comment T]` | Resolve (or `--unresolve`); reply first when given a comment |
| `bro act reply --thread ID --comment T` | Reply without resolving; `--file TSV` for batches |
| `bro act wait [PR] [--merge] [--cleanup]` | Poll the gate; optionally merge on green and clean up the merged worktree |
| `bro act merge [PR] [--squash\|--merge\|--rebase]` | Merge only when the exit gate is green |
| `bro debt collect` | Harvest unresolved threads from merged PRs and label them `debt:collected` or `debt:clean` |
| `bro debt prs` | List merged PRs not yet processed (`--all` for the full picture) |
| `bro debt status` | Ledger counts by state, area, author, and duplicate |
| `bro debt stats [--by author\|source\|area]` | Compare findings and fix rates by reviewer or collector |
| `bro debt list` | List raw ledger rows |
| `bro debt mark <pr> <state>` | Manually mark a PR; `skipped` is the human opt-out |
| `bro debt set <status> --thread-id ID` | Update a row to `claimed`, `done`, `wontfix`, or `duplicate` |
| `bro debt sync` | Project ledger findings into beads |
| `bro debt next [--claim] [--json]` | Pick the highest-priority open finding |
| `bro debt watch [--interval SEC]` | Collect debt on a timer |
| `bro debt trend` | Show debt volume over time |

### Drill, retros & learn

| Command | What bro does |
| ------- | ------------- |
| `bro drill down <title> [--under ID] [--ephemeral]` | Create a scoped child frame under the current leaf |
| `bro drill up --result T [--prevent T]… [--evidence R]… [--report]` | Close the frame, record prevention and evidence, optionally write a report |
| `bro unwind …` | Alias for `drill up` |
| `bro drill current` / `tree` / `list` | Show the active leaf, frame hierarchies, or open frames |
| `bro drill distill <id>` | Turn a drill tree into a reusable proto |
| `bro wtf <complaint>` | Capture the complaint as a bead; see [retrospect](https://broject.dev/docs/commands/retrospect) |
| `bro retrospect record <plan.toml>` | Validate and fan out a retro plan into prevention work |
| `bro retrospect status` | Gate on unanswered `wtf` beads |
| `bro retrospect schema` / `list` | Print the TOML template or list retros and open `wtf`s |
| `bro learn add\|list\|show\|forget\|capture\|probe` | Store lessons and surface them when their triggers match |
| `bro spec check\|drift\|new\|tree\|init` | Check spec coverage and drift, scaffold specs, and inspect their tree |

### Queue & stacks

| Command | What bro does |
| ------- | ------------- |
| `bro next [--list] [--json]` | Claim the top ready bead and print the work order |
| `bro loop [--max N] [--dry-run] [--stack NAME] [--label a,b]` | Claim, work, pass the gate, close, and repeat |
| `bro convoy pour\|status\|next\|claim\|done\|list` | Run a beads formula as a claimable molecule |
| `bro stack push\|list\|sync` | Build and retarget stacked PR chains |
| `bro work enter\|leave\|list\|prune` | Manage sibling worktrees and their recorded stack membership |

### Fleet

| Command | What bro does |
| ------- | ------------- |
| `bro fleet [--json\|--live]` | View molecules, steps, agents, worktrees, and PRs |
| `bro agents status\|up\|down` | Inspect, start, respawn, or stop detached agents |
| `bro watch [--once\|--every N\|--notify\|--json]` | Read-only heartbeat; optionally send transitions to the mailbox |
| `bro notify <text>` | Drop a message in the live session's mailbox |
| `bro drive [--once\|--every N\|--no-merge]` | Apply the act gate to fleet PRs; merge only on green |
| `bro serve [--port N]` | Serve the fleet API and web UI on loopback |

### Setup & utility

| Command | What bro does |
| ------- | ------------- |
| `bro setup [--beads] [--skills] [--pack [NAME]]` | Configure the repo and optionally install beads, skills, or a capability pack |
| `bro doctor [--json]` | Diagnose Node, git, auth, beads, hooks, and configuration |
| `bro check [--evaluate] [--json] [--root <dir>]` | Run the repo's Sverka workflow; `--evaluate` applies its policy gate |
| `bro run <plan.toml>` | Execute a validated plan |
| `bro plan validate <file>` | Validate a plan without executing it |
| `bro sync [--pull]` | Push or restore bro artifacts on `refs/bro/data` |
| `bro plugins` | Print the live plugin registry |
| `bro task list\|show\|new\|set\|close\|exec` | Use the document verbs; `list`, `show`, and `close` also work verb-first |
| `bro store list\|show\|init\|path` | Inspect or manage stores; `--global` targets the user-level store where supported |
| `bro cleanup [--remote] [--dry-run]` | Delete local branches whose PR merged |

## The pipeline (beads)

`bro setup --beads` drops `debt-pipeline.formula.toml` into `.beads/formulas/`:

```bash
bd mol pour debt-pipeline
#   collect → HUMAN GATE (triage) → fix → PR gate → sync
```

Every step is a `bro` command; the human gate is the point. bro collects
and carries — the verdict is yours.

## Config (optional)

`bro.config.json` in the repo root — written per-clone by `bro setup` and
gitignored on purpose (store choices are machine-local), so fresh checkouts
run on defaults until they set up. Everything's optional:

```json
{
  "stores": ["jsonl", "beads"],
  "personality": "terse",
  "debt": {
    "dir": ".agents/review-debt",
    "sources": ["review-threads", "dependabot", "secret-scanning"],
    "stale_days": 14
  },
  "connectors": { "reviews": "github", "tasks": "beads" },
  "sdd": { "mode": "remind", "dir": "specs" }
}
```

`connectors` pins which registered connector serves a facade when several
could — e.g. a self-hosted GitHub Enterprise or GitLab instance. Remote-URL
matching auto-detects github.com and gitlab.com; anything else (GHES,
self-hosted GitLab, a future Jira connector) resolves through this map.

`sdd` opts the repo into spec-driven development: `remind` nudges via
session/prompt hook context when a claimed bead lacks `specs/<id>.md`
(or a `spec:` link), `gate` also lets the stop gate block once. Commit
the section — it then applies to every agent in the repo.

For the `loop`, `drive`, `agents`, `learn`, `sdd`, `check`, `drill`,
`stack`, and `beads` sections, see the
[configuration reference](https://broject.dev/docs/configuration).

`stores` lists the backends debt writes to. `jsonl` is the evidence ledger
(always written — drop it and bro adds it back). `beads` is on **by
default**: the ledger alone is a log — the beads projection is the queue
(`bd ready -l debt`, drill frames, `bro next`). A normal collect auto-runs
`bd init --stealth --skip-agents --skip-hooks` when a repo is missing
`.beads` (skipped by `--dry-run`, `--list-only`, and an empty ledger) —
announced on stderr, never silent — and projects every record
into `bd`. Stealth means local-only: `.beads` lands in `.git/info/exclude`,
nothing is committed, `rm -rf .beads` undoes it. Opt out with an explicit
`"stores": ["jsonl"]`. Requires `bd` installed; a missing bd fails the run
after evidence is written.

The ledger dir is machine-local state too — bro adds it to
`.git/info/exclude` on first write so harvest evidence can't be committed
by accident.

`debt.sources` picks which collectors `bro debt collect` runs. The
default is `["review-threads"]` — the original merged-PR sweep. Opt-in
sources feed the same ledger and beads projection (`debt:<source>`
labels, `thread_id` is the source's stable key):

| Source | Feeds on |
| ------ | -------- |
| `review-threads` | Unresolved review threads on merged PRs (default) |
| `dependabot` | Open Dependabot alerts — skipped when an open `dependabot/*` PR already covers the dependency |
| `code-scanning` | Open code-scanning alerts (rule + file ref) |
| `secret-scanning` | Open secret-scanning alerts — always blocking priority |
| `stale-prs` | Open PRs idle > `debt.stale_days` days or failing checks (WIP drafts don't count) |
| `failed-ci` | Latest default-branch workflow run, if it failed |

Alert sources reconcile both ways: a finding that disappears upstream is
marked `done` in the ledger on the next collect.

## Labels bro manages

| Label | Meaning |
| ----- | ------- |
| `debt:collected` | Swept, findings in the ledger |
| `debt:clean` | Swept, nothing found — bro won't look twice |
| `debt:skipped` | You told bro to chill. bro chills. |

## Philosophy

bro doesn't fix your code. bro doesn't write essays in your PRs. bro
collects what's owed, keeps the books clean, and waits. bro got you.

## Dev

```bash
git clone https://github.com/theplenkov/bro
cd bro && npm install
npm run build && npm test
```

Workspace packages live in `packages/*` (`@broject/core`, `@broject/debt`, `@broject/act`,
the CLI itself). Skills in `skills/` are thin wrappers — all mechanics are in
the CLI. Nx inference comes from the published `@nx-devkit/*` plugins.

## Releasing

CI-driven, human-gated. `Actions → Release → Run workflow`:

- `specifier` — `auto` derives the bump from conventional commits since
  the last `v*` tag (`feat:` → minor, fixes → patch, `BREAKING` → major,
  0.x shifted), or pick `patch` / `minor` / `major` / `prerelease`.
- `preid` — set (e.g. `beta`) to cut `vX.Y.Z-beta.N` instead.
- `dryRun` — prints the nx release plan, changes nothing.

The workflow runs `nx release version` on the `main` checkout, commits
the bump to a `release/vX.Y.Z` branch, and opens a PR. Merge it →
`release-tag.yml` cuts the `v*` tag + GitHub
release on `main` and dispatches `publish.yml`, which ships to npm via
OIDC trusted publishing. No tokens, no manual tags. `release-tag.yml`
can also be run manually (`Actions → Tag Release`) to catch up a version
that predates the pipeline.

MIT. PRs welcome — bro reviews them anyway.
