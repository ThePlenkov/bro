---
title: bro wtf + retrospect
description: Capture frustration verbatim; turn it into retros and prevention beads.
---

## `bro wtf <complaint>`

Captures the user's frustration verbatim as a `wtf` bead — timestamp and
git snapshot included. The complaint is data; the retro comes later.

## `bro retrospect`

Turns wtf beads into structured outcomes — a retro record plus one
prevention bead per action, linked `discovered-from`, with the wtf
answered.

| Command | What it does |
| ------- | ------------ |
| `bro retrospect record <plan.toml>` | Validate a TOML [plan](/bro/plans/) and fan it out: retro bead + prevention beads, wtf answered |
| `bro retrospect status` | Exit gate — non-zero while a `wtf` is unanswered |
| `bro retrospect schema` | Print the commented TOML template |
| `bro retrospect list` | Retros and open wtfs |

The agent can't self-declare "sorry, fixed" — `retrospect status` holds
the gate until every wtf has a recorded answer.
