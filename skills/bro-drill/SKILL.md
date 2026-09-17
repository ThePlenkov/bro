---
name: bro-drill
description: "Use when the user invokes /drill or /unwind, or when a task needs scoped descent — narrower investigation frames with mandatory result+prevention memos. Thin wrapper over the bro CLI: drill frames are beads; bd owns storage, `bro drill` owns the invariants. Requires `bro` (npx -y @theplenkov/bro@0) and bd."
---

# /drill (bro)

**All mechanics live in the `bro` CLI over `bd`.** This skill is policy
only. A drill frame is a bead labeled `drill`; nesting uses bd's native
`--parent` hierarchy. There is no `.drills/` directory tree and no
claim.json — **beads IS the memory system**.

Prereq: `bro` on PATH or `npx -y @theplenkov/bro@0`, `bd init` done.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bro drill down <title> [--under ID] [--ephemeral]` | New child frame under the current leaf (or a root). `--ephemeral` = wisp, no audit trail |
| `bro drill up --result T [--prevent T]… [--evidence R]…` | Close the current frame. `--result` is **mandatory** (CLI-enforced). `--prevent` is policy-mandatory when the drill found an error, gap, or reusable lesson — each item spawns a `prevention`-labeled task linked `discovered-from` the frame. `--evidence` records a provenance ref (sha/PR) |
| `bro unwind …` | Alias for `drill up` — collapse a solved frame into its parent |
| `bro drill current` | The active leaf frame (deepest open path) |
| `bro drill tree` | All drill hierarchies (● open / ○ closed) |
| `bro drill list` | Open frames |
| `bro drill distill <id>` | `bd mol distill` — turn a successful drill tree into a reusable proto/formula |

## Policy

- **Narrow → investigate → ascend → prevent.** Descend only into a
  strictly narrower problem. A frame that returns nothing teaches
  nothing — the CLI refuses `drill up` without `--result`.
- **Found a root cause or a reusable lesson? `--prevent` is the policy,
  not a suggestion.** The CLI can't judge whether a lesson exists — that
  call is yours; when it does, each item becomes follow-up work in beads,
  not a footnote.
- **Isolation.** A child frame gets only task-relevant context; the parent
  absorbs only the curated memo — never the raw transcript.
- **Can't ascend past open children** — bd blocks the close; ascend
  bottom-up.
- **Drill → distill → formula** is the learning loop: a drill tree that
  solved a problem well can be distilled into a proto and re-poured next
  time (`bd mol pour`/`bd mol wisp`).
- Lifecycle is auditable: `claim` on down, `handoff` on up, evidence refs
  as provenance events (`bd provenance log <id>`).
