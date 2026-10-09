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
| `guard` | A declarative nudge should fire on a hook event | Guards are context, never a gate — dry-run defs with `bro guard test` |
| `judge` | Calibrated decisions for agent loops — act triage annotation, fallback escalation | Typed questions in, typed answers out; `judge.mode` governs consumers |
| `learn` | Lessons should outlive the session, an artifact needs capture, or the store may know the answer | Store trigger-gated lessons with evidence instead of unconditional memory |
| `loop` | Work the backlog autonomously end-to-end | Claim → worktree → agent → gate → close → repeat |
| `next` | “Work the backlog,” “clean the queue,” `/next`, or a `/goal` over open beads | Claim one ready bead and emit its work order |
| `notify` | A background worker, watcher, or fixer needs to reach a live session | Write mailbox events; let post-tool probes deliver them |
| `providers` | Configure or debug the provider registry — kinds, wires, `judge.provider`, `agents.<backend>.provider` | Providers are configured, never hardcoded; no silent vendor defaults |
| `query` | Write or run a `kind = "query"` cross-provider GraphQL plan | Read-only fan-out; no secrets in plans, auth comes from the connector's own login |
| `retro` | Session end, before the final answer, or when the retro-on-stop guard fires | The session-end checklist: loose ends, hand-rolled mechanics, call economy, lesson capture, debt sweep |
| `sdd` | The repo enables spec-driven development or asks about missing-spec nudges | Put a written spec before code for claimed work |
| `serve` | A thin client needs the bro facade over HTTP | Expose local agents and fleet snapshots over loopback JSON |
| `stack` | Work should land as a stacked bead → worktree → PR chain | Push beads onto ordered stacks, then sync after merges |
| `status` | A thin client needs the live board in one read | `bro status --json` is the contract; `--deep` adds the act gate |
| `sweep` | `/sweep`, or prune/dispose of closed beads | The burn is gated on harvest — the refusal is the feature |
| `typesafe-ai` | Building features on TypeSafe's System One typed-judgment models | Programmable AI primitives — the same models the judge consumes |
| `sync` | `/sync` or a request to publish/restore bro artifacts | Publish and restore runtime artifacts on the data ref |
| `watch` | Supervise parallel convoys/agents or ask what needs attention | Read the attention list; keep the heartbeat detached and read-only |
| `work` | Parallel sessions collide in a shared repo or worktrees need cleanup | Use sibling worktrees and leave them clean |
| `wtf` | `/wtf` or sharp frustration at the agent's own work | Capture complaints verbatim and turn retros into prevention work |

## Adapters and generation

The portable package is the repo root: `plugin.json`
([Agent Plugins](https://agent-plugins.org/)) and `skills/<name>/SKILL.md`
([Agent Skills](https://agentskills.io/)). Every agent reads that pair.
Claude, Codex, Cursor, and Devin add only what their own client needs
on top — hook event maps and a client manifest under `plugins/<client>/bro`.
They do not carry a second `skills/` tree. OpenCode, Kilo, and pi are
different: they're native plugins installed by `bro plugins install <client>`
— a self-contained module (`plugins/<client>/bro/bro.ts`) carrying hooks
inline, with no skills tree beside it.

`scripts/gen-plugins.ts` keeps those host extras in step. The CLI bundle
embeds a snapshot of skills and formulas at build time. Edit `skills/`,
then use the repository freshness checks before committing generated output.

## Skill discipline

Read the governing `SKILL.md` before running its loop. Waiting mechanics,
claim etiquette, failure fallbacks, and gate policy belong there, not in a
prompt rewritten from memory.
