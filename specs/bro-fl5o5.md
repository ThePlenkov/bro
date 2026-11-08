---
scope:
  - packages/core/src/errors.ts
  - packages/core/src/index.ts
  - packages/cli/src/index.ts
  - packages/cli/src/commands/*.ts
  - packages/*/src/**/*.ts
---
# bro-fl5o5 — typed CommandError + one process.exit at the dispatcher

## Problem
332 `process.exit` calls across packages/cli/src/commands and 566 bare `catch {}` in packages/*/src mix error classification, presentation and termination; library code can't be reused by planes/ACP without killing the process. The dispatcher in `packages/cli/src/index.ts` is the only place that should exit the process.

## Design
- Add `CommandError` in `@broject/core` (typed) carrying `code: ExitCode` (from exits.ts), `message`, optional `usage`/`details`. It is the single error type for command/usage/runtime failures that must be mapped to a process exit.
- `process.exit` must only exist in the CLI dispatcher (`packages/cli/src/index.ts`) — catch `CommandError` there and call `printUsage` or write message to correct stream based on code, then exit. All other code throws `CommandError` (or lets it bubble). 
- Eliminate direct `process.exit` calls in commands and library code. Replace usage patterns with throwing `CommandError` with appropriate `EXIT` code. 
- Improve error classification and presentation; avoid bare `catch {}` where it swallows context — prefer typed catches and propagate errors appropriately.
- Ensure planes/ACP (library code) never call `process.exit`; they throw/reject and let the host decide termination.

## Verify
- `packages/cli/src/index.ts` is the single dispatcher exit: every `CommandError` thrown by any command is mapped there to the correct stream and code — no second `process.exit` may be added to a file this PR touches.
- This PR lands the mechanism (`CommandError`, `isCommandError`, dispatcher catch) and converts the command surface it touches; the remaining direct `process.exit` sites in untouched command files migrate incrementally — the taxonomy forbids *new* direct exits in converted code, the Design section is the end state.
- `npm run build && npm run typecheck` clean.
- `npm test` passes.
