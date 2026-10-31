# bro-q2edc — the session pane becomes a real OpenTUI app

`bro herdr session-view` renders rich _line_ output — a scrollback
dump, not an application. A human watching a live session wants a real
viewer: sticky auto-scroll with manual navigation, markdown that
actually renders, diffs with syntax colors, tool cards that collapse.
This bead turns the acp lane's `bro: session` pane into an OpenTUI app
(`plugins/herdr/tui/`), keeping the line renderer as the fallback.

## Architecture

- **`plugins/herdr/tui/`** — a self-contained bun package: its own
  `package.json` + `bun.lock`, dep `@opentui/core@0.8.0`. Not in the
  npm workspace graph — `plugins/*` never were; `node_modules` is
  gitignored and `bun install`/`bun add` is the operator step, same as
  the plugin's herdr install.
- **Pane command** (`sessions.ts` `sessionCommand`): when bun is on
  `PATH` — `'bun' run '<plugin-root>/tui/main.ts' <worktree> [pane]`.
  Bun resolution: `BUN_BIN_PATH` env override, else `bun` on PATH
  (probed per reconcile). No bun → today's `bro herdr session-view`
  line pane. Degrade, never break.
- **Data** — the same `.events.jsonl` archive tail as the line view.
  The Step-0 verdict (spec bro-l8wqu) stands: `session/load` is
  replay-only; the archive is the live cross-process wire. The TUI
  never opens a second ACP client and never sends `session/prompt` —
  readonly, exactly like the line view.
- **Shared feed** — the archive pump, row→LED verdict, report envelope,
  and target resolution are not TUI code; they're extracted to
  `packages/cli/src/commands/session-feed.ts`, imported by both
  `herdr-session-view.ts` (line mode) and `tui/main.ts` (bun resolves
  the repo `.ts` sources directly — plugin scripts already do this).
  The LED contract — `pane report-agent` with `bro-session` as the
  pane agent, working/idle/blocked states — is identical on both
  renderers.

## Layers

- **`tui/model.ts` — pure, headless.** Archive row → a growing item
  tree + an ops stream for the shell: `append` (new item), `text`
  (streaming chunk append), `tool` (status/content/collapse update),
  `evict` (oldest items past `MAX_ITEMS`, opencode's
  `destroyRecursively` bound). Same-kind chunk runs merge into one
  item; tool calls keep `status`, `title`, `arg`, `kind`, `content`;
  turn/permission/plan/unknown rows land as side items. Sanitization
  posture kept — `safe`/`chunkText` strip ESC+C0 before any text
  reaches a renderable (opentui escapes anyway; the strip is defense
  in depth). Node-testable without a terminal — `SessionModel.feed()`,
  `drain()`, `dump()`.
- **`tui/main.ts` — the shell.** `createCliRenderer` → sticky
  `ScrollBoxRenderable` (`stickyScroll`, `stickyStart:'bottom'`,
  viewport culling builtin) → renderables per item: `MarkdownRenderable`
  (`streaming:true`) for agent text, `CodeRenderable` for tool output,
  `DiffRenderable` per file patch, bordered `BoxRenderable` per tool
  card (collapse = body `visible` toggle), `TextRenderable` side rows.
  Ops drain on a ~32 ms cadence (opencode's delta buffer — the archive
  feeds the model as fast as it produces; the tree commits on a timer
  so token-wise chunks don't re-render per event). Keys are
  scrollbox-builtin (arrows/PgUp/PgDn/Home/End) plus `j`/`k`/`enter`
  for card collapse; `q`/`esc` exits — never an ACP verb. Banner
  carries the worktree + help, same as the line view's header.
- **`--dump`** — replay the archive through the model and print
  `SessionModel.dump()` to stdout; the headless preview + test seam
  (no terminal required).

## Fallbacks

| pane          | bun present                                     | no bun                               |
| ------------- | ----------------------------------------------- | ------------------------------------ |
| acp lane      | `bun run tui/main.ts`                           | `bro herdr session-view` (unchanged) |
| non-acp lanes | native TTY / mirror / events+status — untouched | same                                 |

The lane machinery (spec bro-l8wqu) doesn't change: same archive,
same verdicts, same `sessionAgentOf` identity, same report/release
envelope — only the renderer differs.

## Screens

```
╭ bro: session — tree-1XYU7V · j/k collapse · arrows scroll · q quit
  ── session update ────────────────────────────────────────────
  User: Fix the flaky land e2e — heartbeat prints under load…
  ⣿ Bash [execute] npm test …
  ╭────────────────────────────────────────────╮
  │ PASS 2330/2330                              │
  │ …                                            │
  ╰────────────────────────────────────────────╯
  ✓ Edit [edit] packages/cli/src/loop.ts
  ╭────────────────────────────────────────────╮
  │ ─ packages/cli/src/loop.ts                 │
  │ - const floor = HEARTBEAT_MIN_MS            │
  │ + const floor = heartbeatFloor()            │
  ╰────────────────────────────────────────────╯
```
