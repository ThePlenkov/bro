---
parent: bro-7xgk
scope:
  - bro.config.json
  - site/content/docs/configuration.md
---

# bro-7z2q — free-tier quota wall: explicit fleet cap + triage rule

## Problem

2026-10-03 the Devin free tier hit "Reached free model rate limit" while
local accounting showed *fewer* requests than a window that passed
clean — the quota is account-wide per model request, and 8–9 concurrent
sessions overshoot it structurally. The retro decomposed into epic
bro-7xgk; children .1–.3 and .5 shipped the fleet cap knob, exit
taxonomy, budget observability, and the heartbeat timer. What remains
for this bead's own acceptance criteria:

- `fleet.maxConcurrent` exists (default 3) but `bro.config.json` does
  not set it — the cap is implicit, so the admission decision the retro
  asked for is still invisible in the file an operator reads.
- The `fleet` section is absent from `configuration.md` — the knob is
  undocumented.
- The triage rule (sessions.db counts every request twice; use
  `DISTINCT request_id`, never raw rows) lives only in the bead — a
  future rate-limit investigation would re-derive it the hard way.

## Design

- **`bro.config.json`** gains `"fleet": { "maxConcurrent": 3 }` —
  explicit on the free tier, matching the designed default. `0` would
  mean uncapped; we want the wall visible.
- **`configuration.md`** gains a `### fleet` section documenting
  `maxConcurrent` (non-negative int, default 3, 0 = uncapped, enforced
  in the shared spawn prologue, counted fail-closed across backends).
- **Triage rule** goes to `bro learn` (trigger-gated lesson on
  rate-limit / sessions.db terms), not a committed doc — it is
  machine-local operational knowledge about the Devin account's
  sessions.db, not bro product behavior.
- The watchdog-subagent AC item needs no code: `bro watch` heartbeat
  (bro-7xgk.5) replaced it; verified no live session runs the pattern.

## Plan

- [ ] Spec (this file) + `fleet.maxConcurrent: 3` in bro.config.json
- [ ] `### fleet` section in site/content/docs/configuration.md
- [ ] `bro learn add` the DISTINCT request_id triage lesson
- [ ] `bro spec check bro-7z2q` green; `npm test` green
