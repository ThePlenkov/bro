---
parent: bro-l8c4f
scope:
  - README.md
  - site/src/routes/index.tsx
  - site/src/routes/cli.tsx
  - site/content/docs/index.mdx
---

# bro-l8c4f.7 — Уточнить ICP/JTBD и entry point вокруг deterministic lifecycle closure

Parent: `bro-l8c4f` (principal audit 2026-10-18 — positioning).

## Problem

README, landing, and getting-started drift on ICP/JTBD wording and on the
entry path. The wedge must be progressive: gate + debt first, orchestration
optional. Positioning must not imply fleet/model-gateway setup is required,
and must not carry fixed-count marketing ("Four ways in.", command totals).

## Recommendation

Single ICP: maintainers and small teams with existing agents, a task store,
and PR/CI. JTBD: deterministic lifecycle closure — `task → agent → PR →
gate → debt`. Wedge: portable `task → agent → PR → gate → debt` contract;
start with review gate + debt ledger; orchestration (fleet/convoy/loop) is
optional and progressive, not a replacement runtime.

## Acceptance

- README, landing, and getting-started share identical ICP/JTBD/wedge wording.
- All three carry the same end-to-end scenario that needs no fleet or
  model-gateway setup.
- No fixed-count marketing remains on the landing.

## Non-negotiables

- Spec first per SDD gate.
- Preserve grouped CLI + flat aliases, one portable skills tree, facades.
- No breaking redesign.
- Regressions covered by existing doc checks (`npm run check:docs`,
  `npm run check:onboarding`).
