# @broject/act

The open-PR review gate behind `bro act` — PR state (threads, checks,
reviewers, merge slot), the exit-gate evaluation, wait-for-gate polling,
and the act plan schema.

> You probably want the CLI instead: `bro act status` on an open PR.
> Install this only when building a review-loop integration.

## Install

```bash
npm i @broject/act
```

Requires Node ≥ 22 and an authenticated `gh`. ESM only.

## Surface

- `fetchPrActState` — one call: threads, checks, reviewers, mergeability
- `evaluateExitGate` / `ExitGate` — the gate as data: OK or a blocker list
- `waitForGate` / `gatePending` — poll until the gate settles
- `parseActPlan` / `ACT_PLAN_KIND` — the unified act plan payload
- `actConnector` — registers `bro act *` subcommands
- `MergeSlot` — serialized merge scheduling

## Links

- Docs: https://broject.dev/docs/commands/act
- Source: https://github.com/ThePlenkov/bro/tree/main/packages/act
- CLI: https://www.npmjs.com/package/@broject/bro
