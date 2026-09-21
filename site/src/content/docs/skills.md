---
title: Skills
description: Skills are policy; the CLI is mechanics.
---

Each bro capability ships a skill — a markdown file the agent reads that
says *when* and *why*, while the CLI owns *how*. Policy drifts in
prompts; it survives in a file with a frontmatter trigger.

## Shipped skills

| Skill | Trigger | Policy it carries |
| ----- | ------- | ----------------- |
| `act` | `/act`, `bro:` PR pings | Loop until the exit gate is green; severity-aware fix/defer; merge only via `bro act merge` |
| `debt` | `/debt`, ledger work | Collect → triage → claim → fix → sync; the human gate is the point |
| `drill` | `/drill`, `/unwind` | Narrow → investigate → ascend → prevent; `--result` mandatory |
| `sync` | `/sync` | Data-ref push/pull, bare-remote smoke rules |
| `wtf` | `/wtf` | Capture verbatim, never paraphrase |
| `convoy` | `/convoy` | Multi-bead batch coordination |

## Generation

`scripts/gen-plugins.ts` renders `skills/*/SKILL.md` into per-client
adapters (`plugins/{devin,claude,codex}/bro/`) plus the embedded copy in
`packages/cli/src/skills-data.ts`. The source of truth is `skills/`;
adapters are build artifacts — edit the source, regen, commit both.
`npm run check:embedded` and `check:plugins` enforce freshness in CI.

## Skill discipline for agents

The global rule: **read the governing SKILL.md before running its loop.**
Policy lives there — waiting mechanics, resolve etiquette, failure
fallbacks — don't re-derive it per session.
