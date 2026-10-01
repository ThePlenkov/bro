---
parent: retro
---

# bro-0w9 — wtf skill: when the same root recurs, the sink must leave prose — escalate to mechanism, not scope

## Problem

Retro bro-cj0: a violated rule got escalated to wider prose twice and
recurred anyway — prose reached the agent and didn't bind. The wtf skill
now says this ("Recurrence also escalates the sink") and
`bro retrospect record` warns on prose-only plans, but the warning fires
*after* the plan is written. The plan's authoring surface —
`bro retrospect schema` — documents each sink yet never states the
recurrence bar, so an agent writing a plan sees routing, not the rule.

## Design

One gap to close, at the point of authoring: `PLAN_SCHEMA` in
`packages/retro/src/plan.ts` gains a comment under the sink list — a
repeat root cause needs ≥1 `workaround`/`backlog` action; prose-only
plans are more of what already failed. No code, no validation change —
the record-time warning stays the enforcement; the schema gains the
policy line that tells the agent why before it writes.

## Plan

- [ ] recurrence-bar comment in `PLAN_SCHEMA` (`packages/retro/src/plan.ts`)
- [ ] `npm test`
