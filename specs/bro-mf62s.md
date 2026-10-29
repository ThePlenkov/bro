---

parent: bro-mf62s
scope:
- packages/cli/src/commands/setup.ts
- packages/cli/src/commands/doctor.ts
- packages/core/src/config.ts
- packages/github/src/index.ts
- packages/core/src/connectors.ts
- packages/core/src/bd.ts

---

# bro-mf62s — onboarding: zero-bd first run — setup picks github-issues store when bd is missing/broken

Parent: hygiene (P2). Relates to bro-huy5o.1 (github-issues tasks backend).

## Problem

The github-issues task store exists (bro-huy5o.1) but beads stays the default; the first `npx @broject/bro` run hits CGO/Dolt problems in environments without a working `bd` (or with a CGO-broken build). Onboarding is blocked — `bro setup` requires beads and fails, or setup proceeds assuming beads and later `bro doctor`/commands fail badly.

## Design

1. **bro setup**: detect bd presence/health (including CGO/version issues). If bd is missing or cannot function, and the repo has a GitHub remote (`gh` authed context) so the github-issues backend is viable, configure the zero-install path: set `connectors.tasks = "github"` and `stores = ["jsonl"]` (or ensure jsonl is present) in the local config. Tell the user how to upgrade to beads later. If neither beads nor github-issues is viable, still behave helpfully (point to installing bd or authing gh).
2. **doctor**: a CGO/version problem with bd should be a warning with install/upgrade command, not a failure, when another tasks store (e.g. github-issues via `connectors.tasks=github`) is configured and healthy. The tasks row must report healthy when using github-issues even if bd is broken/missing.

## Acceptance

- fresh container without bd: `npx @broject/bro setup && bro doctor green`; `bro flow next` works on github issues.
