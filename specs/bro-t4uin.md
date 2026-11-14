# bro-t4uin — the interactive ACP pane: a composer that steers

The session pane (`bro-q2edc`) renders an ACP session beautifully and
can do exactly nothing with it. It is a **tail of
`<git-common>/bro/agents/<id>.events.jsonl`** — a file replay, not a
wire. `j/k` walk the cards, `Ctrl+C` copies a row, and the pane's
footer says nothing about typing. Every message a human would want to
send to the agent has to leave the pane, go through some other
surface, and come back as another turn.

Two specs already deferred this. `bro-5vjpg` scoped its pane
readonly on purpose — *"no composer, no `session/prompt` mid-turn, no
`session/cancel` key — input is a follow-up bead"* — and named the
increment: *"Multi-turn input (`session/prompt` between turns) and
permission decisions are later increments."* `bro-olfvd` M5/M6 scoped
the client half (*"an acpx-like ACP client (a session you can drive)"*)
and the terminal surface over it.

This spec lands that increment: **the pane speaks ACP and takes
input.** A composer line at the bottom, a queue for follow-ups, a
cancel key, and permission asks the human answers instead of the
headless driver denying.

## The measured facts this design rests on

Nothing here is inferred. `scripts/acp-capability-probe.ts` (landed
with this spec) asks each installed agent's `initialize` for its own
capabilities — the wire, not our assumptions about it:

| agent | `loadSession` | `resume` | `session/delete` | `session/list` | image |
| --- | --- | --- | --- | --- | --- |
| `devin acp` | yes | no | yes | yes | yes |
| `kilo acp` | yes | yes | no | yes | yes |
| `opencode acp` | yes | yes | yes | yes | yes |

Three facts follow, and each one kills a design:

**1. `loadSession` is real — so "continue a finished session" is
possible.** The open question in `bro-5vjpg` (*"Does `devin acp`
implement `session/load`/`session/list`? If yes, readonly reattach to
a past session id becomes possible"*) is answered: yes. The registry
already records `acpSessionId` (`packages/core/src/agents.ts:682`),
the fleet doc already carries it (`packages/herdr-kit/src/fleet/state.ts:47`),
and `resolveTarget` already assembles the `SessionSpec` with the
provider's command (`packages/herdr-kit/src/fleet/target.ts:51`).

**2. `resume` is NOT universal — so the attach path must speak
`session/load`, not `session/resume`.** `devin acp` does not advertise
`sessionCapabilities.resume`. A design that reaches for `resume` first
works on kilo/opencode and fails on devin. `session/load` is the
portable spelling: every agent in the table supports it, and the spec
guarantees the same continuation (*"The Client can then continue
sending prompts as if the session was never interrupted"*).

**3. ACP has no mid-turn prompt — so the composer QUEUES.** The
baseline is `session/new` · `session/prompt` · `session/cancel` ·
`session/update`; a second concurrent `session/prompt` on one session
is an **error**, not a queue. Our own broker enforces it
(`packages/cli/src/commands/serve-acp.ts:68` — *"a prompt turn is in
flight — a second concurrent prompt is an error: the update queue is
per-session single-reader"*). So the pane's queue is **the client's**,
not the agent's — exactly the property `acpx` implements and ACP
does not. This is why the client half is ours to write.

## The boundary

**This spec lands the client half and the composer's first half.** The
pane's ability to steer a session that **bro's fleet worker owns** is
the follow-up (named at the end), because it collides with the
worker's exit-code contract.

The client half lives in **`packages/acp/client`** — a new package
beside `packages/acp/{model,session,tui}`. It is dependency-free
NDJSON JSON-RPC over stdio, like `plugins/herdr/src/acp-watch.ts`
already is, and it is **Node-testable**: the TUI's Bun-only walls
(Solid JSX transform, OpenTUI native FFI) must not reach the protocol
code, or the protocol code has no test.

The package contract:

- `AcpClient` — spawn an agent command (`argv` words, never a shell),
  `initialize` → `session/new` (or `session/load`), and expose the
  session's lifecycle.
- **one prompt at a time**; a second `prompt()` while a turn is in
  flight is **queued**, not an error, and the queue drains on turn
  end. This is the client-side property ACP lacks.
- `cancel()` — `session/cancel` for the in-flight turn.
- **permission requests are the caller's business**: the client
  surfaces the ask (`onPermission`) and the caller answers with
  `answerPermission(optionId)`. The client never invents an approval —
  the option must be one of the **agent's own**, an unknown id is
  refused, and the fallback for "nobody answered" is a **denial**
  (`denyPermission`, `denyAllPermissions`, and `close()` denies what
  is left).
- **the client emits the SAME archive rows the file carries** — the
  `kind:'turn'|'prompt'|'update'|'permission'` shapes from
  `packages/acp/session/src/archive/rows.ts`. That is the seam that
  makes the pane's renderer untouched: the live feed and the file
  replay are the same bytes, so the model, the fold policy, the LED
  verdict and every card already work.
- **the client's state is pushed, not polled**: `onState` fires when
  the queue, the pending ask or the status moves, so the pane redraws
  on the change and never on a timer.

The TUI's live mode therefore **feeds rows into the existing impl**,
not a parallel renderer. `packages/acp/session/src/view/acp-impl.ts`
already maps a row to a `ModelEvent` (`eventsOf`) — `kind:'update'` →
`session_update`, `kind:'prompt'` → the prompt card, `kind:'permission'`
→ `permission_opened`. The model's reducer already knows
`permission_answered` and `permission_cancelled`
(`packages/acp/model/src/reducer.ts:845`). **The permission decision
needs no new renderable at all** — the card exists; it was just never
answerable.

**One row shape grew, additively.** The headless driver journals a
permission as ONE row that carries the verdict
(`packages/providers/src/acp-worker.ts:326`); an interactive client has
an ask and an answer at two different moments. The rows therefore
carry a `phase` (`'ask'` | `'answer'`) — the ask opens the record, the
answer closes it, and a row with **no** phase means both (the archive's
shape). `ArchiveRow` grew three optional fields for it: `options`,
`optionId`, `optionKind` (`packages/acp/session/src/archive/rows.ts`).
The archive's own rows carry none of them, so the old rendering is
unchanged — and a record that *does* carry options prints the menu
instead of the headless driver's tail (*"open a terminal in this
workspace to handle interactively"* — a panel that HAS the terminal
must not say that).

## The pane

The composer is OpenTUI's `InputRenderable` — verified present in the
installed `@opentui/core@0.8.0`
(`node_modules/@opentui/core/renderables/Input.d.ts:31`), exposed to
Solid as `<input>` through the component catalogue
(`node_modules/@opentui/solid/src/elements/catalogue.ts:34`). It emits
`InputRenderableEvents.ENTER` on submit.

Layout: the feed keeps its scrollback; the composer is **one line
pinned above the footer**, dim until focused. The keymap splits by
mode, because the existing keys are single-purpose and must not
change meaning:

| key | browse mode | compose mode |
| --- | --- | --- |
| `i` / `/` | focus the composer | — |
| `Enter` | fold the selected card | **send** the queued prompt |
| `Esc` | — | cancel the composer (the queue survives) |
| `Ctrl+C` | copy the current row | copy the current row |
| `Ctrl+X` | **cancel the in-flight turn** (`session/cancel`) | same |

`Ctrl+X` rather than `Ctrl+C` for cancel: `Ctrl+C` is the copy
gesture everywhere in this pane (OSC52), and a pane whose copy key
also stops the agent would make the copy gesture unreliable.

**The queue is visible.** A queued prompt shows under the composer —
`⏳ 2 queued · next: …` — so the human sees that their message is
waiting rather than delivered — the herdr skill's rule (*"never
assume a sent prompt was read"*) applied to our own pane. The queue
line is a LINE, not a feed row: a queued prompt has not been sent
yet, and printing it in the feed would make it look delivered.

**Permission asks are answerable.** The bar above the composer lists
the agent's own options (`⚠ permission ‹Run ls› — 1) Allow once ·
2) Reject · d deny`); `1`/`2`/`3` answer with that `optionId`, `d`
denies. The answer goes back on the wire; the card closes with the
outcome. A permission nobody answers ends as a **denial** — the pane
never auto-approves, and a pane that exits with an open ask denies it
rather than leaving the agent waiting for a yes that will never come.

## Standalone — the pane without herdr

The pane must work as a plain TUI, not only as a herdr pane. The
herdr shell (`plugins/herdr/tui/main.ts`) is herdr-shaped by
construction: it resolves a target from the fleet doc, reports a LED
to a pane id, and returns early when `HERDR_ENV` is unset
(`plugins/herdr/tui/main.ts:185`). That shell stays as it is.

The standalone entry is `packages/acp/tui/main.ts` — a **new** file,
not a mode of the herdr one:

```bash
bun packages/acp/tui/main.ts --cmd 'devin acp' [--cwd DIR] [--session ID] [--resume] [--prompt TEXT]
```

It spawns the agent, opens the session, feeds the rows into the same
impl, and renders. `--session ID` takes the `session/load` path
(continue a finished session); without it, `session/new`. The herdr
pane and the standalone pane are then **the same TUI with two
shells** — the renderer, the model and the client are shared, only the
target resolution differs.

## Non-negotiables

- **No second ACP implementation in the TUI.** The client half is one
  package; the pane speaks to it, never to the wire.
- **No auto-approval.** A permission the human does not answer is
  denied. The pane's `autoApprove` posture is unchanged from the
  headless default.
- **The client's queue is ours, and it is visible.** A prompt sent
  while a turn runs is queued, numbered and shown. It is never
  silently dropped and never delivered twice.
- **The renderer is untouched.** The live feed and the archive replay
  are the same row shapes; the model and the cards do not learn a
  second source of truth.
- **Provider-agnostic.** The client speaks ACP and nothing else. No
  agent's name appears in the client's code; the command is a
  parameter.

## The follow-up this spec does NOT land

**Steering a session bro's fleet worker owns.** The fleet's
`acp-worker` is one-shot by contract: one prompt file, one
`pumpTurn`, then the exit code IS the verdict
(`packages/providers/src/acp-worker.ts:443`).
`packages/cli/src/commands/serve-acp.ts:68` enforces one prompt at a
time. So steering a live fleet session means the worker must survive
its turn and accept a follow-up — which changes what the worker's
exit means, and that is a fleet-contract change, not a pane change.

Until that lands, the honest split is:

- **the pane's own session** — fully steerable now (this spec);
- **a finished session** — continuable now via `session/load` (this
  spec, `--session ID`);
- **a live fleet worker's session** — not steerable yet (the
  follow-up).

The pane says which one it is, in its header. Never a lie.

## Plan

- [x] `scripts/acp-capability-probe.ts` — the capability probe (the
      facts above are its output)
- [x] `packages/acp/client/` — the package: `AcpClient` (spawn,
      initialize, new/load, prompt-queue, cancel, permission ask +
      answer), row emission in the archive's shapes
- [x] `packages/acp/client/test/*.test.ts` — Node tests over a fake
      agent: queue drains on turn end, cancel reaches the wire,
      permission ask/answer round-trips, load-attach continues
- [x] `packages/acp/tui/live.ts` — the keymap and the composer lines
      (framework-free, so they are Node-testable)
- [x] `packages/acp/tui/app.tsx` — the composer line, the queue line,
      the answerable permission bar, the mode-split keymap
- [x] `packages/acp/tui/main.ts` — the standalone entry
- [x] `packages/acp/tui/live.test.ts` — the keymap's tests (Node)

## Two traps this design walked into

**The Solid runtime must load AFTER the Bun plugin.** The JSX
transform is a Bun plugin that REWRITES `solid-js/dist/server.js` into
the client build on load. A plain `import { createSignal } from
'solid-js'` before the preload caches the SSR build, and the tree then
renders as orphan text (`Orphan text error: "" must have a <text> as
a parent`). The standalone entry therefore preloads the plugin and
imports `solid-js` dynamically (`packages/acp/tui/main.ts`).

**The key that opens the composer must not land in it.** The renderer's
global key handler runs BEFORE the focused input's, so `i` would both
open the composer and type an `i` into it. The mode-switching keys
call `preventDefault()`; without it the draft starts with the letter
that summoned it.

## Verify

- `npx tsx --test packages/acp/client/test/*.test.ts`
- `npx tsx --test packages/acp/tui/live.test.ts`
- `bun test packages/acp/tui/pane.test.tsx`
- `npm run typecheck` — the whole workspace, the CI command
- `npm test` — the whole workspace, the CI command
- Live: `bun packages/acp/tui/main.ts --cmd 'devin acp'` — a composer,
  a queued prompt, a cancel, and a permission ask the pane answers.

## Non-goals

- **No fleet-worker steering** — the follow-up above.
- **No multi-agent panes** — one session per pane.
- **No ACP client library** — the client half is bro's, not a
  published package.
- **No change to the fleet contract** — the worker's exit code keeps
  meaning what it means today.
