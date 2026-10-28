# bro-5vjpg — herdr acp pane: readonly ACP session renderer (spike)

ACP (Agent Client Protocol) is JSON-RPC over stdio — one protocol,
many backends: `devin acp`, `gemini --acp`, claude-code-acp,
qwen/opencode ACP modes, anything that speaks it. A spawned acp worker
is invisible: the protocol is technical, nothing renders it. Meanwhile
every herdr agent pane shows a TUI you can read — but a TUI stalls on
questions, and a headless acp worker has no readable surface at all.
This spike adds a pane that renders **any** ACP session's structured
`session/update` stream in agent-legible form.

**Backend-agnostic by contract**: the pane's only dependency is the
ACP protocol itself — `initialize`, `session/new`, `session/prompt`,
`session/update`, `session/request_permission`. The agent command is a
parameter (`--cmd`, default `devin acp`); the renderer must not contain
a single backend-specific branch. What works for devin works for
gemini or any future acp server.

Scope is deliberately **readonly**: the pane visualizes a session it
spawns (or a stream it is handed); it has no composer. Multi-turn input
(`session/prompt` between turns) and permission *decisions* are later
increments.

## Design

- **New action in `plugins/herdr`** (the bro.fleet plugin that landed
  on main via [#758](https://github.com/ThePlenkov/bro/pull/758)):
  `bro.fleet.acp.watch` — splits/opens a pane running the renderer
  against a spawned ACP-server child. Params: `--cmd <acp-cmd>`
  (default `devin acp` — first verified backend, nothing more),
  `--prompt <task>` optional seed turn.
- **One client per session.** ACP is a single-client protocol — you
  cannot attach a second client to a live session. The pane therefore
  OWNS its session: spawn child → `initialize` → `session/new` →
  optionally `session/prompt`. Mirroring a fleet worker's live session
  is a different mechanism (events replayed via the future LiveSource,
  bro-ymswu) — explicitly out of scope.
- **Renderer** — line-mode (no curses): the pane's terminal gets an
  appended stream, scrollback-friendly:
  - `agent_thought_chunk` → dim/grey
  - `agent_message_chunk` → plain text
  - `tool_call`/`tool_call_update` → `⣿ name  status` with title, kind,
    status transition (pending → running → completed/failed)
  - `plan` → re-rendered checklist (`[x] done / [>] doing / [ ] todo`)
  - `session/request_permission` → a visible `⚠ <title> [options]`
    line; v1 answers per a fixed policy (`allow` reads, otherwise
    `allow-once` — chosen so the session never stalls on the viewer;
    interactive decisions are the input increment's job)
  - turn boundaries → `── turn complete (stopReason) ──` separator
- **Exit contract**: child exit or `session/prompt` returning a
  terminal stopReason prints a closing marker; the pane stays readable
  (scrollback preserved) instead of dying silently.
- **Facade invariant holds**: this pane is UI surface only — claims,
  scheduling, registry, exit records stay bro's; the renderer speaks
  ACP to a child process and nothing else.

## Non-goals

- No composer/input line, no `session/prompt` mid-turn, no
  `session/cancel` key — input is a follow-up bead.
- No attach/mirror of foreign sessions (needs LiveSource replay or an
  ACP-aware proxy; the one-client rule forbids a second attach).
- No new agent kind in herdr — a native `acp` kind is the upstream
  endgame, filed as a herdr feature, not built here.

## Open questions

- Does `devin acp` implement `session/load`/`session/list`? If yes,
  readonly reattach to a past session id becomes possible and a
  "resume" param is cheap.
- Does the permission-request payload distinguish read vs write
  operations well enough for a smarter default policy?

## Verify

- Fixture test: feed a recorded `session/update` JSONL stream into the
  renderer — assert thought-dimming, tool status transitions, plan
  checklist, permission chip formatting.
- Live spike: `herdr plugin action invoke bro.fleet.acp.watch -- --prompt
  "list files and summarize"` renders a complete turn in a
  herdr pane: thought stream, tool calls, final message, closing
  marker — against `devin acp` AND at least one second ACP backend
  (gemini/claude-code-acp if installed), proving no backend coupling.
- `npm run typecheck` green; `tsx --test` green.

## Exit criteria

A herdr pane shows a live, continuously-rendered ACP session —
thoughts, tools, plan, permissions, turn boundary — with zero input
surface, and the pane survives the session's end for scrollback.
