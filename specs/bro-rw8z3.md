# bro-rw8z3 — hooks: waste-guard (deterministic tool-call discipline)

## Problem

LLM request count is driven by tool-call *patterns*, not context volume:
agents re-read identical files, re-run test suites after every edit, and
issue one tool call per turn where a batch would do. Each wasted call is a
paid model turn. The lever is deterministic enforcement at the hook seam —
zero LLM cost, model-agnostic (any client emitting pre-tool events).

## Design

New module `packages/cli/src/commands/waste-guard.ts`, consulted from
`emitPreTool` before connector verdicts. Per-session state lives in
`hooksStateDir` (`<git-common>/bro/hooks/<session>.waste-*`), same marker
shape as the armed-gate aspects.

Two guards, both fail-open:

1. **dup-read** — a read-only inspection call (tool name matching
   read/view/grep/glob/ls/list/cat/notebook_read AND carrying
   file_path/path/pattern/query input) whose canonical
   `(tool, sorted-input)` hash was already seen this session → block with
   a reason naming the duplicate. Identical input ⇒ identical output ⇒
   pure waste. Mutating tools and shell commands are out of scope (a
   repeated `git status` is cheap and sometimes intentional).

2. **verify-gate** — a test/build command (`npm test|run test|build|
   typecheck|check`, `npx tsc`, `vitest|jest|pytest|go test|cargo test|
   tsx --test`, `node --test`) is allowed only when the tree changed since
   the last admitted verify. Tree fingerprint = sha256 of
   `git status --porcelain` + `git diff HEAD` (content-level, catches
   same-status edits). Unchanged → block "no file changes since last
   verify". Non-git dirs and git failures → allow.

Off-switch: `BRO_WASTE_GUARD=0` disables both (arena baseline leg).

Out of scope (follow-ups): batch-read nudge via additionalContext
(pre-tool has no context channel on all adapters), PostToolUse output
caps, bash-level dedup.

## Verify

- Unit: dup-read blocks the second identical call, allows a different
  path; verify-gate blocks an unchanged-tree re-run and allows after an
  edit; env off-switch passes everything; non-git cwd fails open.
- Arena dogfood: same opencode task with plugin hooks (guard on) vs
  `BRO_WASTE_GUARD=0` — compare tool-call counts.
