---
title: Why bro
description: The problem bro solves — agent workflows are mechanics, not prompts.
---

Agents are good at judgment and bad at bookkeeping. Prompts try to carry
both — and the bookkeeping parts ("remember to check for unresolved
threads", "don't stop while a drill frame is open", "sweep merged PRs")
rot the moment the conversation drifts.

bro's bet: **mechanics belong in a CLI, policy belongs in a skill, and
neither belongs inline in a prompt.**

## The shape of every capability

Each feature ships the same four parts:

1. **a CLI subcommand** — the mechanics, testable and deterministic
2. **an agent skill** — the policy, readable markdown the agent follows
3. **a config section** — the knobs, validated and defaulted
4. **a plan schema** — structured input, validated before it runs

## Why beads is a default store

`bro debt collect` creates `.beads/` in a repo that doesn't have one —
on purpose. The jsonl ledger is evidence; beads is the work queue
(`bd ready -l debt`, drill frames, `bro next`). An opt-in default would
fill the ledger and starve the queue until the user found a config key —
and `bd` is required by the task commands anyway, so opting out only
defers the dependency to a later, less predictable failure.

The init is stealth: `.beads` is written to `.git/info/exclude`, nothing
lands in git, no hooks or `AGENTS.md` edits, and `rm -rf .beads` reverses
it — the same machine-local contract as `.agents/review-debt/` and the
gitignored `bro.config.json`. It announces itself on stderr; a tool that
wants adoption doesn't get to be silent about writing to your repo.
Opt out once: `"stores": ["jsonl"]` in `bro.config.json`.

## What it doesn't do

bro doesn't fix your code. bro doesn't write essays in your PRs. bro
collects what's owed, keeps the books clean, and waits.

bro got you.
