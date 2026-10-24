---
title: bro wtf + retrospect
description: Capture frustration verbatim; turn it into retros and prevention beads.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

## `bro wtf <complaint>`

Captures the user's frustration verbatim as a `wtf` bead — timestamp and
git snapshot included. The complaint is data; the retro comes later.

## `bro self retrospect`

Turns wtf beads into structured outcomes — a retro record plus one
prevention bead per action, linked `discovered-from`, with the wtf
answered.

| Command | What it does |
| ------- | ------------ |
| `bro self retrospect record <plan.toml>` | Validate a TOML [plan](/docs/plans) and fan it out: retro bead + prevention beads, wtf answered |
| `bro self retrospect status` | Exit gate — non-zero while a `wtf` is unanswered |
| `bro self retrospect schema` | Print the commented TOML template |
| `bro self retrospect list` | Retros and open wtfs |

The agent can't self-declare "sorry, fixed" — `retrospect status` holds
the gate until every wtf has a recorded answer.

## The retro-on-stop guard

The wtf path is incident-driven; the session-end retro is every-session.
The `retro` skill carries the checklist — loose ends, hand-rolled
mechanics that should become beads or bro commands, call economy, `bro
self learn capture`, `bro review debt collect`, state assertions — and a
[`guard`](/docs/commands/guard) def fires the one-line nudge at `stop`:

```jsonc
{
  "guard": {
    "defs": [{
      "name": "retro-on-stop",
      "when": { "on": ["stop"] },
      "say": "session ending — run the retro checklist"
    }]
  }
}
```

The guard is the doorbell; the skill's checklist is what "ran the retro"
actually means. Scale to the session — a one-shot Q&A skips with a
line; findings land as `bd` items, never as prose the user must convert.
