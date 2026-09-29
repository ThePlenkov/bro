---
name: sdd
description: "Use when the repo enables spec-driven development (`sdd` section in bro.config.json) or asks why bro nudges about missing specs. Thin wrapper over `bro spec` — mechanics live in the CLI; this skill carries policy only."
---

# /sdd (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

Spec-driven development: a claimed bead gets a written spec **before**
code. bro carries the rule, so prompts don't have to — the `sdd`
connector's hook probes inject the policy into session-start and
prompt-submit context, and in `gate` mode the stop gate blocks once
while a session's own claim lacks a spec.

## What counts as a spec

- `specs/<bead-id>.md` in the repo — non-empty. The file rides the
  feature branch, so the spec is reviewed in the same PR as the code.
- or a `spec:` link in the bead description (external doc).

Exempt: `issue_type: chore` and beads labeled `trivial` or `debt` —
SDD measures design mass, not bookkeeping, and a harvested review
finding already carries its own evidence.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro spec check [id…]` | Coverage over `in_progress` beads (`--all` adds open): `spec` / `link` / `exempt` / `MISSING`. Exit 1 on any MISSING — CI-able |
| `bro spec new <id>` | Scaffold `specs/<id>.md` from the bead title; never overwrites |

## Config

```json
"sdd": { "mode": "gate", "dir": "specs" }
```

| `mode` | Effect |
| ------ | ------ |
| `off` (default) | Nothing — the section's absence opts the repo out |
| `remind` | Session-start policy line; prompt-submit nudge while an own claim lacks a spec |
| `gate` | All of remind, plus the stop gate blocks once under the `task` aspect (armed by `bd --claim` / `bro work enter`). A repeated stop passes — gates, not loops |

Only **this session's** claims are judged (the `.task` marker, same
scope rule as the parallel-work nudge) — other sessions' un-spec'd
beads are never your blocker.

## Policy

- **Spec first, then code.** Claim → `bro spec new <id>` → fill
  Problem/Design/Plan → implement. The spec lands in the same PR.
- Small enough to not need design mass? Label the bead `trivial`
  instead of writing an empty spec file — a stub defeats the audit.
- `bro spec check` is the self-audit; wire it into CI the same way
  `bro act status` gates PRs.
