---

name: bro
description: "Use when the user invokes /bro — the one dispatcher command every client carries. No arguments orients on `bro status`; `/bro <family> [args]` hands off to the `bro` CLI family and the matching `skills/<name>/SKILL.md`. Requires `bro` (npx -y @broject/bro@0)."
argument-hint: "[act|debt|work|loop|fleet|next|watch|status|…] [args]"
allowed-tools:
- exec

---

# /bro — the dispatcher

`/bro` is ONE command across clients, not a mirror of `bro` argv: it
orients, then hands the named family to the CLI and the matching skill.
All mechanics live in the `bro` CLI — this surface is the pointer, never
the policy.

## No arguments

Run `bro status` and summarize the board — active beads, fleet workers,
drill frame, PR gate. The digest plus the table below is the answer to
"what does bro see right now".

## Dispatch table

| Invocation      | CLI family         | Skill for policy         |
| --------------- | ------------------ | ------------------------ |
| `/bro act [PR]` | `bro review act`   | `skills/act/SKILL.md`    |
| `/bro debt`     | `bro review debt`  | `skills/debt/SKILL.md`   |
| `/bro work`     | `bro work`         | `skills/work/SKILL.md`   |
| `/bro loop`     | `bro flow loop`    | `skills/loop/SKILL.md`   |
| `/bro next`     | `bro flow next`    | `skills/next/SKILL.md`   |
| `/bro fleet`    | `bro fleet`        | `skills/agents/SKILL.md` |
| `/bro watch`    | `bro review watch` | `skills/watch/SKILL.md`  |
| `/bro drive`    | `bro review drive` | `skills/drive/SKILL.md`  |
| `/bro status`   | `bro status`       | `skills/status/SKILL.md` |

Any other `/bro <name>` maps the same way — `bro <name> <args>` with
`skills/<name>/SKILL.md` for mechanics when the skill exists; `bro help`
lists the full surface.

## Rules

- **Read the skill before driving a family.** The dispatch target above
  carries the policy (waiting, arming, stop-gate rules) — run the CLI
  for state, read the skill for mechanics.
- **Never re-derive mechanics here.** A family that needs more than its
  row is a skill gap, not a longer prompt — extend `skills/<name>`.

Requires `bro` on PATH or `npx -y @broject/bro@0`.
