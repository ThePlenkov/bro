---
title: Getting started
description: Install bro and wire it into a repo in under a minute.
---

## Requirements

- **Node ≥ 22** — bro runs TypeScript natively, no build step
- **`gh`**, authenticated — review data comes from the GitHub API
- **`bd`** ([beads](https://github.com/gastownhall/beads)) — the default
  store. Opt out with `"stores": ["jsonl"]` if you must

## Install

```bash
npx -y @theplenkov/bro --help     # zero install
npm i -g @theplenkov/bro          # or keep bro around
```

## Wire a repo

```bash
bro setup              # checks gh + bd, writes bro.config.json
bro setup --beads      # also: bd init --stealth + debt-pipeline formula
bro setup --skills     # also: thin skill wrappers for your agent
```

`bro.config.json` is written per-clone and gitignored — store choices are
machine-local. Fresh checkouts run on defaults until set up.

## First sweep

```bash
bro debt prs        # merged PRs nobody processed yet
bro debt collect    # harvest threads → .agents/review-debt/ + labels
bro debt status     # the damage report
bro debt next       # the top open finding — claim, fix, set done
```

## As an agent plugin

The repo is a plugin marketplace — one `bro` plugin packaged per client,
same skills and lifecycle hooks everywhere:

| Client | Install |
| ------ | ------- |
| Devin | `devin plugins install ThePlenkov/bro` |
| Claude Code | `/plugin marketplace add ThePlenkov/bro` → `/plugin install bro@bro` |
| Codex | `codex plugin marketplace add ThePlenkov/bro` → install `bro` |

Every adapter ships session rehydration, the review-gate stop hook, and
self-approve for `bro`/`bd` — wired through `hooks/run.sh`, always
fail-open.
