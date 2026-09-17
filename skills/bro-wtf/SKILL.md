---
name: bro-wtf
description: "Use when the user invokes /wtf or vents sharp frustration at the agent's own work. Thin wrapper over the bro CLI — `bro wtf` captures the complaint as a bead, `bro retrospect record` stores a TOML retro plan and fans prevention actions out to beads. Requires `bro` (npx -y @theplenkov/bro@0) and bd."
---

# /wtf (bro)

**All mechanics live in the `bro` CLI over `bd`.** This skill is policy
only. A `wtf` bead is the trigger artifact; a `retro` bead is the
analysis record; `prevention` beads carry the follow-up work.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0`, `bd init` done.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro wtf <complaint>` / `bro retrospect capture <complaint>` | Open a `wtf` bead — the user's complaint **verbatim** + a git/cwd snapshot |
| `bro retrospect schema` | Print the commented plan template — the schema lives in the CLI, not here |
| `bro retrospect record <plan.toml>` | Validate the plan → close a `retro` bead with the analysis memo → each `[[actions]]` item becomes an open `prevention` bead labeled `sink:<sink>` → the wtf is closed (`retro.wtf`, `--wtf`, or the only open one — auto-linked) |
| `bro retrospect status` | **Exit gate** — exit 1 while any wtf stays unanswered |
| `bro retrospect list` | Retro beads + open wtf beads |

## Policy

- **Capture before apologizing.** The first move is
  `bro wtf "<the user's words, verbatim>"` — never a paraphrase, never a
  softened version. The quote is evidence; every arg is captured
  literally, `--`-leading text included (only a leading `-h`/`--help`
  prints usage). Invoke it as a single argv value — never interpolate
  the complaint into a compound shell command where metacharacters or
  quotes could execute.
- **Analyze your own actions, not the user.** The wtf is a defect in the
  agent's process. Review your recent turns in context: what you were
  asked, what you assumed, what you skipped. Post-compaction and unsure?
  Say so — a fabricated confession is worse than none. For real
  root-causing, `bro drill down` first; the drill's memo feeds the plan.
- **The plan is the deliverable.** `bro retrospect schema` → write the
  file → `bro retrospect record`. `what`/`why` are mandatory; every
  `[[actions]]` item needs a `sink` — the resource the fix lands in.
  `record` auto-answers the only open wtf; with several open, set
  `retro.wtf` or pass `--wtf` to pick.
- **The gate decides, not you.** Resume normal work only when
  `bro retrospect status` exits 0.
- **Route by sink.** `sink:backlog` stays queued; `sink:memory` → persist
  to user or project memory (scope decides); `sink:agentic-documents` →
  update AGENTS.md/rules/skill files directly; `sink:upstream-issue` →
  file it;
  `sink:workaround` → implement the fix now.
- **Recurrence escalates scope.** `bro retrospect list` before writing,
  then `bd show <id>` on each listed retro to read its `why` memo —
  a repeat root cause moves the fix one scope wider along
  session → agent → user → project → universal.
