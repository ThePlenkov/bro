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
- No `process.exit` outside `packages/cli/src/index.ts` (and maybe build/scripts if truly necessary, but task says "one process.exit at the dispatcher" referring to CLI process termination).
- All command errors go through `CommandError`.
- `npm run build && npm run typecheck` clean.
- `npm test` passes.
