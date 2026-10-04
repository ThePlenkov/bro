# @broject/stack

[![npm](https://img.shields.io/npm/v/@broject/stack)](https://www.npmjs.com/package/@broject/stack)

Stacked bead → worktree → PR chains for `bro` — a gh-stack analogue over
the `stack/<name>/<n>-<slug>` branch namespace and the `.git/bro/stack/`
edge files `bro work enter` already records. Pure domain logic (branch
parsing, member ordering, sync planning); all git/host IO lives in the
CLI (`packages/cli/src/commands/stack.ts`).

> You probably want the CLI instead: `bro stack push|list|sync`.
> Install this only when building your own stack tooling.

## Install

```bash
npm i @broject/stack
```

Requires Node ≥ 22. ESM only.

## Surface

- `parseStackBranch` / `formatStackBranch` / `isStackName` — the
  `stack/<name>/<n>-<slug>` branch namespace
- `stackMembers` / `stackNames` / `stackTop` / `nextIndex` — the chain
  view over a branch list (bottom-up ordering; merged-member skip)
- `planSync` / `SyncMemberInput` / `SyncPlanItem` — the post-merge
  retarget/rebase plan (desired base per member, skip reasons)
- `displayBase` — a member's effective base for listing

## Links

- Docs: <https://broject.dev/docs/commands/loop>
- Source: <https://github.com/ThePlenkov/bro/tree/main/packages/stack>
- CLI: <https://www.npmjs.com/package/@broject/bro>
