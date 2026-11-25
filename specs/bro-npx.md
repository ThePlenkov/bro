---
parent: project
---

# bro-npx — stop-gate arming must match the registered command spellings

## Problem

`classifyArmCommand` (hooks.ts) matches `${bro} act`, `${bro} drill`,
`${bro} wtf` — but the registered commands are `bro review act …` and
`bro work drill|wtf` (the act/drill families live under their group
hosts). A session running the real spellings writes no act marker, so an
unfinished review loop passes the stop gate silently — the arming the
master docs promise does not fire for the primary spelling.

Found by codeant-ai review on PR #1111 (thread deferred to this bead).

## Design

The classifier accepts the optional group word per registered spelling:
`bro [review ]act`, `bro [work ]drill`, `bro [self ]wtf` — wtf
registers under self, not work (review round on this PR). The bare
forms stay matched — `bro act` still dispatches (the review group host
swallows unmatched argv), and old scripts keep arming. `bro work …`
already matched and keeps matching; `bro work wtf` falls to the work
host and arms `work`.

## Verify

- `classifyArmCommand('bro review act status')` → `'act'` (was `null`)
- `classifyArmCommand('bro work drill down')` → `'drill'` (was `null`)
- the bare spellings still classify as before
- the arming-marker hooks tests cover the group spellings
