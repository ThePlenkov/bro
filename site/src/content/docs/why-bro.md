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

## What it doesn't do

bro doesn't fix your code. bro doesn't write essays in your PRs. bro
collects what's owed, keeps the books clean, and waits.

bro got you.
