---
parent: project
---

# review-gate — PR review loop + review debt

## Scope

`bro act` is the exit gate as code: threads, checks, SAST annotations,
AI-reviewer verdicts; resolve/reply/merge/wait mutations. `bro debt`
harvests resolved-but-unfixed findings and security alerts into the
ledger and beads.

## Owns

```text
packages/act/     exit-gate, state, connector, plan
packages/debt/    collectors (review-threads, dependabot, code-scanning,
                  secret-scanning, stale-prs, failed-ci), ledger, store
skills/act/ skills/debt/
```
