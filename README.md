# bro 🤝

> Your agent's sidekick. Skills are instructions — **bro is the brain.**
>
> **Docs + landing:** https://theplenkov.github.io/bro/

Your AI agent can read a PR. Can it tell which merged PRs still have
unresolved review threads rotting in them? Can it say "bro, what's left?"

Now it can.

```bash
npx @theplenkov/bro debt prs        # merged PRs nobody processed yet
npx @theplenkov/bro debt collect    # sweep them, label them debt:collected
npx @theplenkov/bro debt status     # the damage report
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

## Install

```bash
npx -y @theplenkov/bro --help     # zero install
npm i -g @theplenkov/bro          # or keep bro around: bro debt status
```

Requires: `node >= 22`, `gh` authenticated, `bd`
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

Every adapter ships the same skills and lifecycle hooks (session
rehydration, review-gate stop, self-approve for `bro`/`bd`) wired through
`hooks/run.sh` — local dist → `bro` on PATH → major-pinned `npx`, always
fail-open.

## Commands

| Command | What bro does |
| ------- | ------------- |
| `bro debt collect` | Scans merged PRs missing a `debt:*` label, harvests unresolved threads, labels the PR `debt:collected` or `debt:clean` |
| `bro debt prs` | The queue — merged PRs still unprocessed (`--all` for the full picture) |
| `bro debt status` | Ledger stats: open/done/wontfix, by area, by author, dupes |
| `bro debt list` | Raw rows, filterable |
| `bro debt mark <pr> <state>` | Manual override — `skipped` is the human opt-out, bro respects it |
| `bro debt set <status> --thread-id ID` | Row status: `claimed` / `done --fix-pr N` / `wontfix` / `duplicate` — feeds `sync` |
| `bro debt sync` | Projects the ledger into beads — idempotent (`thread_id` → `external_ref`), so `bd ready -l debt` becomes the work queue. Needs `bd` installed; `.beads` auto-inits stealth when missing |
| `bro debt next [--claim] [--json]` | The top open finding — priority-ranked, oldest first. The agent-fix primitive: claim it, fix it, `set done --fix-pr N` |
| `bro debt watch [--interval SEC]` | Collect on a timer (default 300s) — post-merge bot comments get picked up by the stale-rescan without a manual run. All collect flags pass through |
| `bro act status [PR]` | **Exit gate as code** — open threads, pending CI, SAST findings, mergeable. Non-zero while blocked. `--json` for machines |
| `bro act threads [PR]` | Unresolved review threads on the PR |
| `bro act resolve --thread ID [--comment T]` | Resolve (or `--unresolve`) — replies first if a comment is given |
| `bro act reply --thread ID --comment T` | Reply without resolving; `--file TSV` for batch |
| `bro act wait [PR] [--merge]` | Poll the gate until it settles — green, blockers, or timeout. `--merge` lands the PR on green — the whole watcher loop in one command |
| `bro act merge [PR] [--squash\|--merge\|--rebase]` | Merge **only when the exit gate is green** — refuses and names blockers when BLOCKED. Deletes the merged local branch too |
| `bro cleanup [--remote] [--dry-run]` | Delete local branches whose PR merged — squash makes `git branch --merged` useless, so merged state comes from `gh pr list --state merged` |
| `bro drill down <title> [--under ID] [--ephemeral]` | Scoped descent — a child frame under the current leaf, as a `drill`-labeled bead |
| `bro drill up --result T [--prevent T]… [--evidence R]…` | Ascend. `--result` is mandatory; each `--prevent` becomes a `discovered-from` task; evidence refs land in `bd provenance` (skipped for `--ephemeral` wisps) |
| `bro unwind …` | Alias for `drill up` |
| `bro drill current` / `tree` / `list` | Active leaf frame · all hierarchies · open frames |
| `bro drill distill <id>` | `bd mol distill` — a good drill tree becomes a reusable proto |
| `bro wtf <complaint>` | Capture the user's frustration verbatim as a `wtf` bead — timestamp + git snapshot included |
| `bro retrospect record <plan.toml>` | Validate a TOML retro plan and fan it out: `retro` bead + `prevention` beads per action, linked `discovered-from`, wtf answered |
| `bro retrospect status` | Exit gate — non-zero while a `wtf` bead is unanswered. The agent can't self-declare "sorry, fixed" |
| `bro retrospect schema` / `list` | Print the commented TOML template · retros and open wtfs |
| `bro setup [--beads] [--skills]` | Wires bro into the current repo: checks `gh` auth + `bd`, writes `bro.config.json`, optionally `bd init --stealth` + installs the debt-pipeline formula and thin skill wrappers |
| `bro next [--list] [--json]` | **The autonomous loop's scheduler** — claims the top ready bead (priority, then age) and prints the work order. Skips human gates, epics, and molecule steps. `bro next → implement → PR → merge → bd close → bro next` until `state: idle` — no per-item "go?" prompts |
| `bro loop [--max N] [--dry-run]` | **The autonomous loop as a command** — claim → worktree → spawn `loop.agent` → act gate → `bd close` → repeat. Review threads respawn the agent (≤ `loop.fixRounds`); failures land as bead notes, never silent |

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
  "debt": { "dir": ".agents/review-debt" }
}
```

`stores` lists the backends debt writes to. `jsonl` is the evidence ledger
(always written — drop it and bro adds it back). `beads` is on **by
default**: a normal collect auto-runs `bd init --stealth --skip-agents
--skip-hooks` when a repo is missing `.beads` (skipped by `--dry-run`,
`--list-only`, and an empty target list), and
projects every record into `bd` — JSONL keeps the receipts, beads runs the
queue. Opt out with an explicit `"stores": ["jsonl"]`. Requires `bd`
installed; a missing bd fails the run after evidence is written.

The ledger dir is machine-local state too — bro adds it to
`.git/info/exclude` on first write so harvest evidence can't be committed
by accident.

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
git clone --recursive https://github.com/theplenkov/bro
cd bro && npm install
npm run build && npm test
```

Workspace packages live in `packages/*` (`@bro/core`, `@bro/debt`, `@bro/act`,
the CLI itself). Skills in `skills/` are thin wrappers — all mechanics are in
the CLI. Nx inference comes from `vendor/nx.ts` (submodule, we ride the
source).

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
