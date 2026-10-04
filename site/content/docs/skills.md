---
title: Skills
description: Skills are policy; the CLI is mechanics.
---

Each bro capability ships a skill: a markdown policy file that says when
and why to use the command. The CLI owns how.

## Shipped skills

| Skill | Trigger | Policy it carries |
| ----- | ------- | ----------------- |
| `act` | `/act` or a `bro: PR #N …` status ping | Run the review gate until green; fix or defer findings; merge through `bro act merge` |
| `agents` | Supervise bro-managed agents: respawn a lost worker, stop one, or inspect the agent plane | Preserve the agent's identity and handles |
| `check` | A repo with a Sverka workflow, or a request to run checks/scans through bro | Run the repository's checks through the Sverka facade |
| `convoy` | `/convoy` or a request to run a beads workflow | Claim molecule steps atomically and respect human gates |
| `debt` | `/debt` or a question about review debt on merged PRs | Collect, triage, claim, fix, and sync findings |
| `docs` | Read or mutate task documents and stores, including the user-level store | Keep task and store verbs predictable; `--global` selects the user store |
| `drill` | `/drill`, `/unwind`, or a task needing scoped descent | Narrow the investigation, return a result, and prevent recurrence |
| `drive` | Orphaned PRs need an owner, or a request to drive the review loop | Poll gates, spawn unowned fixers, and merge only on green |
| `learn` | Lessons should outlive the session, an artifact needs capture, or the store may know the answer | Store trigger-gated lessons with evidence instead of unconditional memory |
| `loop` | Work the backlog autonomously end-to-end | Claim → worktree → agent → gate → close → repeat |
| `next` | “Work the backlog,” “clean the queue,” `/next`, or a `/goal` over open beads | Claim one ready bead and emit its work order |
| `notify` | A background worker, watcher, or fixer needs to reach a live session | Write mailbox events; let post-tool probes deliver them |
| `sdd` | The repo enables spec-driven development or asks about missing-spec nudges | Put a written spec before code for claimed work |
| `serve` | A thin client needs the bro facade over HTTP | Expose local agents and fleet snapshots over loopback JSON |
| `stack` | Work should land as a stacked bead → worktree → PR chain | Push beads onto ordered stacks, then sync after merges |
| `sync` | `/sync` or a request to publish/restore bro artifacts | Publish and restore runtime artifacts on the data ref |
| `watch` | Supervise parallel convoys/agents or ask what needs attention | Read the attention list; keep the heartbeat detached and read-only |
| `work` | Parallel sessions collide in a shared repo or worktrees need cleanup | Use sibling worktrees and leave them clean |
| `wtf` | `/wtf` or sharp frustration at the agent's own work | Capture complaints verbatim and turn retros into prevention work |

## Adapters and generation

Claude Code, Codex, Devin, and OpenCode receive the same policy through
their adapters. OpenCode is a native plugin (`@broject/bro`); the other
adapters use generated skill and lifecycle-hook files.

The source of truth is `skills/`. `scripts/gen-plugins.ts` renders the
published adapters, while the CLI bundle embeds a snapshot of skills and
formulas. Edit the source, then use the repository freshness checks before
committing generated output.

## Skill discipline

Read the governing `SKILL.md` before running its loop. Waiting mechanics,
claim etiquette, failure fallbacks, and gate policy belong there, not in a
prompt rewritten from memory.
