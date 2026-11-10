---

name: bro
description: "Use when the user invokes /bro — the agent-plugin dispatcher (narrow scope, not the full `bro` CLI). `/bro` or `/bro help` prints plugin help; `/bro status` runs the board; `/bro <family> [args]` hands off to the CLI family and `skills/<name>/SKILL.md`. Requires `bro` (npx -y @broject/bro@0.3)."
argument-hint: "[help|status|act|debt|work|loop|fleet|next|watch|drive|…] [args]"
allowed-tools:

- exec

---

# /bro — the dispatcher

`/bro` is the **agent-plugin** dispatcher (narrow scope). It is **not** a mirror of the full `bro` CLI.
All mechanics live in the `bro` CLI — this surface orients and hands off to the matching skill.

## `/bro` or `/bro help`

Print **plugin help only** (do **not** run `bro --help` / dump the full CLI):

### Usage

- `/bro` or `/bro help` — this help
- `/bro status` — run `bro status --deep` and summarize the board
- `/bro <family> [args]` — hand off to the family below (read its skill first)

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

Other `/bro <name>` → `bro <name> <args>` with `skills/<name>/SKILL.md` when it exists. Full CLI: `bro help` (not `/bro`).

## Rules

- **Read the skill before driving a family.** Policy (waiting, arming, stop-gate) lives in the skill — run the CLI for state.
- **Never re-derive mechanics here.** A gap is a skill change, not a longer prompt.

Requires `bro` on PATH or `npx -y @broject/bro@0.3`.
