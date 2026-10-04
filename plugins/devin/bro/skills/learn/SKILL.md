---
name: learn
description: "Use when a lesson should outlive the session — 'remember this for next time', capturing a drill/retro/review finding, or asking whether the store already knows the answer. Thin wrapper over the bro CLI: `bro learn` is the lesson store; the learn connector injects matched lessons at session-start, prompt-submit, and post-tool. Requires `bro` (npx -y @broject/bro@0) and bd."
---

# /learn (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only —
matching, injection, and dedup live in `@broject/learn` and the hooks
layer.

Prereq: `bro` on PATH or `npx -y @broject/bro@0`. Requires `bd` — lessons
persist as `bd kv` entries under the `learn/` prefix, synced with the
beads store.

## What a lesson is

One durable unit of agent knowledge: a rule plus the **trigger** that
decides when it surfaces (hook events + context conditions — terms,
commands, paths, tools, errors). Match keys are optional and conjunctive:
a trigger with `--on` alone is a valid event-scoped lesson that fires on
every configured hook event — match keys just narrow it. Injection is
capped by `budget` per session and `learn.maxInject` per probe.

| Command | What it does |
| ------- | ------------ |
| `bro learn add --lesson "…" --on E --evidence K:R` | Store a manual lesson — `--on` and ≥1 `--evidence` required (kinds: bead, pr, session, command, text) |
| `bro learn list [--json] [--source X] [--confidence X]` | List lessons |
| `bro learn show <id>` | One lesson as JSON |
| `bro learn forget <id>` | Delete a lesson |
| `bro learn capture [--source drill\|retro\|act\|mol\|all] [--mol ID] [--dry-run]` | Distill finished artifacts (drill memos, retro beads, review findings, mol results) into trigger-shaped lessons |
| `bro learn probe <question>` | Store-first query — a hit prints ranked lessons; a miss prints candidates and logs the gap. `--lesson "…"` stores the distilled answer (phase 2 — needs a trigger: `--on`/`--match-*` or a question with usable terms) |

## Policy

- **Evidence is required, not decorative.** A lesson that cannot cite
  where it was learned is not storable — `--evidence` names the bead, PR,
  session, command, or literal text. Confidence derives from it:
  tentative → established on ≥2 independent evidences — or a single one
  where the lesson already held under a real gate (the PR it warned
  about merged green, the prevention it stated closed the retro).
- **`learn` for conditioned knowledge, `bd remember` for context-free.**
  "Repo uses native TS" is a memory — it injects always. "When running
  `gh pr merge`, sweep debt" is a lesson — it fires only at the trigger.
  Storing a conditioned lesson as a memory recreates the AGENTS.md
  always-on problem in a new place.
- **Probe before you re-investigate.** A question the store already
  answered short-circuits for free — but a hit is a ranked guess: one
  shared term can surface an unrelated lesson, so check it actually
  answers the question before skipping the investigation. On a real
  miss, finish the work and store the answer via `probe --lesson` —
  the next session never has to pay for it again.
- **Capture at artifact close, dry-run first.** `capture --dry-run`
  renders the would-be lessons without writing — capture is a proposal
  surface. Re-capturing merges evidence and recomputes confidence
  instead of duplicating.
- **Write triggers that can fire.** A lesson whose match keys never
  hit is dead weight. Prefer `prompt-submit` terms for human-driven
  triggers, `post-tool` commands/paths for workflow triggers — and keep
  `budget` at 1 unless repetition is the point.
- **Recurrence means promotion.** A lesson that keeps firing on the
  same mistake is asking to become a rule — the fix lands in the skill,
  AGENTS.md, or rules file via the normal spec/PR path, not by editing
  the lesson forever.
