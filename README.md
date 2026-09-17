# bro 🤝

> Your agent's sidekick. Skills are instructions — **bro is the hands.**

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

Requires: `node >= 22`, `gh` authenticated. That's it. No tokens to
babysit, no config files to confess to.

## Commands

| Command | What bro does |
| ------- | ------------- |
| `bro debt collect` | Scans merged PRs missing a `debt:*` label, harvests unresolved threads, labels the PR `debt:collected` or `debt:clean` |
| `bro debt prs` | The queue — merged PRs still unprocessed (`--all` for the full picture) |
| `bro debt status` | Ledger stats: open/done/wontfix, by area, by author, dupes |
| `bro debt list` | Raw rows, filterable |
| `bro debt mark <pr> <state>` | Manual override — `skipped` is the human opt-out, bro respects it |
| `bro debt set <status> --thread-id ID` | Row status: `claimed` / `done --fix-pr N` / `wontfix` / `duplicate` — feeds `sync` |
| `bro debt sync` | Projects the ledger into beads — idempotent (`thread_id` → `external_ref`), so `bd ready -l debt` becomes the work queue. Needs `bd` installed + `bd init` in the repo |
| `bro debt next [--claim] [--json]` | The top open finding — priority-ranked, oldest first. The agent-fix primitive: claim it, fix it, `set done --fix-pr N` |
| `bro debt watch [--interval SEC]` | Collect on a timer (default 300s) — post-merge bot comments get picked up by the stale-rescan without a manual run. All collect flags pass through |
| `bro act status [PR]` | **Exit gate as code** — open threads, pending CI, SAST findings, mergeable. Non-zero while blocked. `--json` for machines |
| `bro act threads [PR]` | Unresolved review threads on the PR |
| `bro act resolve --thread ID [--comment T]` | Resolve (or `--unresolve`) — replies first if a comment is given |
| `bro act reply --thread ID --comment T` | Reply without resolving; `--file TSV` for batch |
| `bro drill down <title> [--under ID] [--ephemeral]` | Scoped descent — a child frame under the current leaf, as a `drill`-labeled bead |
| `bro drill up --result T [--prevent T]… [--evidence R]…` | Ascend. `--result` is mandatory; each `--prevent` becomes a `discovered-from` task; evidence refs land in `bd provenance` (skipped for `--ephemeral` wisps) |
| `bro unwind …` | Alias for `drill up` |
| `bro drill current` / `tree` / `list` | Active leaf frame · all hierarchies · open frames |
| `bro drill distill <id>` | `bd mol distill` — a good drill tree becomes a reusable proto |
| `bro setup [--beads] [--skills]` | Wires bro into the current repo: checks `gh` auth + `bd`, writes `bro.config.json`, optionally `bd init --stealth` + installs the debt-pipeline formula and thin skill wrappers |

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
gitignored on purpose (store choices like `beads` are machine-local), so
fresh checkouts run on defaults until they set up. Everything's optional:

```json
{
  "stores": ["jsonl"],
  "personality": "terse",
  "debt": { "dir": ".agents/review-debt" }
}
```

`stores` lists the backends debt writes to. `jsonl` is the evidence ledger
(always written — drop it and bro adds it back). Add `"beads"` to also project
every record into `bd` — JSONL keeps the receipts, beads runs the queue.
Requires `bd` installed and `bd init` in the repo
(`bd init --stealth --skip-agents --skip-hooks` keeps it invisible).

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
