# bro — pi extension

Agent's sidekick for pi: the live project board on pi's TUI plus the
same lifecycle mechanics the shell adapters carry, over pi's in-process
extension API. `bro.ts` is generated from
`packages/cli/src/adapter/pi.ts` — the shared adapter core folded into
one self-contained module (node builtins only) by
`npm run gen:plugins`; `check:plugins` fails when it drifts.

## What it wires

- **board widget** — `bro status --json` rendered via
  `ctx.ui.setWidget`/`setStatus`, refreshed on session start, turn
  end, and agent settle.
- **lifecycle** — pi events → `bro hooks <event>`: session-start and
  post-compaction rehydration injected once as a hidden context message,
  pre-compact carried across, prompt-submit nudges, post-tool arming,
  and `agent_before_settle` → the stop gate (a real gate: block lands
  the blocker as a message and continues the turn, once per session).
- **`/bro`** — bare opens the interactive board panel (collapsible
  sections, ↑↓/←→ navigation, `r` refresh, `q` close — an overlay over
  the transcript; a plain refresh where no TUI can mount);
  `/bro act|next|fleet|…`
  runs the CLI and drops the output into the transcript. The slash
  dropdown completes arguments: verbs and groups at position 1,
  group members / verb subcommands at position 2
  (`getArgumentCompletions`, table drift-tested against the plugin
  registry).
- **local checkout wins** — a session started inside the bro repo (or
  one of its worktrees) runs THAT checkout's adapter: `devAdapter`
  resolves `plugins/<client>/bro/bro.ts` up from the session cwd (both
  adapter and framework markers required) and the installed plugin
  defers to it, so local edits are live without reinstalling. Every
  other directory gets the installed plugin, unchanged.
- **`bro_status` tool** — the board JSON as a model-callable read.

## Install

```sh
bro plugins install pi            # both scopes
bro plugins install pi --global   # ~/.pi/agent/extensions/bro.ts
bro plugins install pi --local    # <repo>/.pi/extensions/bro.ts
```

Pi discovers extensions from `<cwd>/.pi/extensions/` and
`~/.pi/agent/extensions/` (jiti loads the raw .ts — no build needed),
or load it ad hoc: `pi --extension <path>/bro.ts`.

The module resolves the CLI as local dist (bundled sibling or the
checkout's `packages/cli/dist/index.js` found walking up), then `bro`
on PATH passing the `bro hooks` probe, then `npx -y --prefer-offline
@broject/bro@0.2.5`. Every call is async and fail-open —
a missing CLI or a non-bro directory means no widget and no context,
never an error.
