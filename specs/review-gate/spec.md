---
parent: project
---

# review-gate — PR review loop + review debt

## Scope

`bro act` is the exit gate as code: threads, checks, SAST annotations,
AI-reviewer verdicts; resolve/reply/merge/wait mutations. `bro debt`
harvests unresolved review threads on merged PRs plus configured alert,
PR, and CI sources into the ledger and beads.

## Owns

```text
packages/act/     exit-gate, state, connector, plan
packages/debt/    collectors (review-threads, dependabot, code-scanning,
                  secret-scanning, stale-prs, failed-ci, sonarcloud),
                  ledger, store
skills/act/ skills/debt/
```
