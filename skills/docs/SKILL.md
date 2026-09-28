---
name: docs
description: "Use when reading or mutating bro documents directly — tasks (beads) and stores — through the verb-first `bro <verb> <noun|ref>` surface. Also covers the user-level global task store. Thin wrapper — mechanics live in the CLI."
---

# /docs (bro)

**All mechanics live in the `bro` CLI.** This skill is policy only.

bro's document surface is noun-first, gh-style: `bro <noun> <verb>
[ref…] [--flags]`. Doc types are plugin-registered (`task`, `store`);
a type's adapter methods are the verb registry — there is no verb
list to consult. Verbs live inside their noun's namespace, so plugin
doc types may define any custom verbs freely.

Shorthand: task verbs also work verb-first — `bro list`, `bro show
<id>`, `bro close <id>` mean `bro task …`. A bare ref infers the type
from its prefix; a bare noun (`bro task`, `bro store`) means `list`.

The doc namespace is guarded, not declared: reserved words = plugin
command names ∪ doc nouns/aliases ∪ shorthand verbs. A plugin taking
a reserved name, or a doc type colliding on noun/alias/idPrefix, is
skipped with a warning — everything else is usable.

| Command | What it does |
| ------- | ------------ |
| `bro task list [--status=open]` / `bro list` | List tasks — flags pass through to the store |
| `bro task show <id>` / `bro show <id>` | One doc; the ref infers the type |
| `bro task new "title" [--type=bug]` / `bro new task "title"` | Create — returns the doc |
| `bro task set <id> --status=blocked` / `bro set <id> …` | Update fields |
| `bro task close <id> [--reason=…]` / `bro rm <id>` | Close / delete a task |
| `bro task exec [--global] -- <bd args>` | Raw `bd` against the store — escape hatch, not contract |
| `bro store list` | Store inventory — path + prefix + health |
| `bro store show --global` | Details of the resolved global dir |
| `bro store init --global [--prefix=P]` | Create + validate the global store |
| `bro store path --global` | Print the resolved global store dir |
| `bro next --global` | Schedule from the global queue — same pipeline, cwd = the store |

## Scopes

`--global` is a scope flag, not a command: the same verbs hit the
user-level store (`~/.local/share/bro/beads` by default — `beads.global`
in `bro.config.json` or `$BRO_GLOBAL_BEADS` relocate it, env wins).
Stores never mix: `bro list`, `bro next`, `bro loop`, and hooks read the
checkout's `.beads` only; global work is opt-in at every call.

The global store is local-only by default — no sync remote. For a
cross-machine queue set the store's own Dolt remote inside it
(`bd dolt remote` in the store dir) — bro does not manage it.

## Policy

- **Project work goes to project beads.** Global beads are claimed only
  through `bro next --global` or `--global` doc verbs.
- **Global is for user-level work** — cross-repo tasks, personal backlog,
  anything that must not ride the project's issue tracker or land in its
  PRs. If in doubt, file in the project.
- **Prefer verbs over `exec`.** `bro task exec -- …` exists for bd features
  the doc layer doesn't model yet; workflow output should come through
  typed verbs so ref inference and rendering keep working.
