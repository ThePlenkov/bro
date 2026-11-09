---
description: bro plugin dispatcher (narrow scope) — /bro help shows plugin help; /bro <family> hands off
---

<!-- GENERATED from skills/bro/SKILL.md — edit the skill, then `npm run gen:plugins` -->
Invoked: `/bro $ARGUMENTS`

Follow `skills/bro/SKILL.md` (plugin dispatcher, **not** full `bro` CLI):
- no args or `help` → print plugin help only (dispatch table). Do **not** run `bro --help`.
- `status` → run `bro status --deep` and summarize the board.
- `<family> [args]` → read `skills/<family>/SKILL.md`, then run `bro <family> [args]` (or mapped CLI family).
