# Pi plugin spec — bro as a pi extension

bro ships as a single self-contained pi extension: `plugins/pi/bro/bro.ts`,
generated from `packages/cli/src/adapter/pi.ts` via `npm run gen:plugins`.
`check:plugins` fails when the bundle drifts from source.

## Single command

Only one command is registered: `/bro`. Bare `/bro` refreshes the board
widget; `/bro <args>` passes through to the bro CLI (`bro act|next|fleet|drill|…`)
and drops the output into the transcript. No `bro-*` commands are registered.
The `bro_status` tool exposes the same board JSON as a model-callable read.

## Local TS loading

`bro plugins install pi` materializes the generated bundle to
`<repo>/.pi/extensions/bro.ts` (local) or `~/.pi/agent/extensions/bro.ts`
(global). `piArtifact()` prefers the repo's `packages/cli/src/adapter/pi.ts`
when running inside a git checkout, so local edits are live without a
rebuild. Pi loads the file with jiti (raw TS, no compile, no node_modules).

## Board

`bro status --json` → `ctx.ui.setWidget`/`setStatus`, refreshed on session
start, turn end, and agent settle. Bead rows carry a precomputed clickable
PR/issue link (`link` field) when the bead is linked to one (e.g. drive
fixer beads via `external_ref: drive:pr:<N>`), rendered as `[#N](url)`.

## Lifecycle

pi events → `bro hooks <event>` (same contract as other adapters):
session_start, session_before_compact, session_compact, before_agent_start,
tool_result, agent_before_settle (stop gate). Fail-open: a missing CLI or
non-bro repo yields no widget/context/gate, never an error.

## Fail-open

CLI resolution ladder: pinned command → bundled sibling → checkout dist →
`bro` on PATH (probe `bro hooks`) → pinned npx. Every spawn async with
timeout; stale ctx degrades to "no paint".
