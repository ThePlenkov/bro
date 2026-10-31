# bro-q2edc — the session pane renders through @opentui/solid

The pane shipped in `562e1c70` as an imperative `@opentui/core`
shell: `tui/main.ts` hand-builds a `TextRenderable` banner, a
`ScrollBoxRenderable`, and one renderable per item, then keeps
`views`/`cards` maps and replays a manual op stream onto them. It
works, but the shell is ~250 lines of renderable bookkeeping whose
correctness nobody can check: the item tree lives in the model, the
renderables live in the shell, and the two are kept in sync by hand.

`@opentui/solid` (0.8.0) is the same framework with a Solid
reconciler: the item tree becomes a Solid store, the shell becomes
declarative JSX, and the store updates drive the renderables. This
spec records what that migration buys, what it costs, and the two
Bun-only walls it hits.

## The constraints that decide the design

Both were verified against the installed packages, not inferred.

**1. The Solid JSX transform is Bun-only.**
`@opentui/solid/preload` throws under Node
(`"@opentui/solid/preload is Bun-only"`); the Node build of the
runtime plugin support throws the same way. The transform is a **Bun
plugin** that rewrites `.tsx` through `babel-preset-solid`. Without
it, Bun's default JSX handling resolves `react/jsx-dev-runtime` and
the app dies at import.

**2. OpenTUI's native FFI is Bun-only.**
`createCliRenderer` throws under Node — `OpenTUI native FFI is not
available for this runtime yet`. The Zig core ships as a Bun FFI
binding, so no renderer exists on Node at all.

Together these mean the pane stays a Bun program. It already was —
`sessionCommand` probes `bun` and falls back to the line-mode
`bro herdr session-view` when it is absent. **The migration adds no
new runtime requirement**; it constrains _where_ the JSX transform
is registered, not _whether_ the pane can run.

**3. `solid-js` must resolve to its client build.**
Bun's default `solid-js` resolution picks the `server` build, where
effects never fire — a Solid app that renders once and never
updates. The `@opentui/solid` preload installs an `onLoad` hook that
rewrites `solid-js/dist/server.js` to `solid.js` (and the same for
`solid-js/store`). So the preload is not optional polish: without it
the pane renders a static frame.

**4. The preload must register before Solid's modules LOAD.**
This is the constraint that decides the entry file's shape, and it
is stricter than "before the `.tsx` loads". Bun **builds a module's
import graph before evaluating it**: a static
`import '@opentui/solid/preload'` in the entry registers the plugin
_after_ the entry's own imports have already been loaded — and
`solid-js` is one of them. The rewrite then never fires, `solid-js`
stays the server build, and the tree renders but never updates.

Measured on the installed packages, one identical signal-driven
`<text>` (the value must change from `v=0` to `v=42`):

| preload site                                              | result |
| --------------------------------------------------------- | ------ |
| none                                                      | `v=0`  |
| `import '@opentui/solid/preload'` (static)                | `v=0`  |
| `import '@opentui/solid/runtime-plugin-support'` (static) | `v=0`  |
| `bun --preload=@opentui/solid/preload` (CLI)              | `v=42` |
| **dynamic** `await import('@opentui/solid/preload')`      | `v=42` |

Only a dynamic preload works without changing the spawn command, so
the entry loads the preload dynamically and statically imports
nothing Solid.

## Architecture

Three layers, each with one job.

### `tui/model.ts` — pure, unchanged, node-testable

Archive rows → an item tree plus an op stream. No renderables, no
fs, no timers, no framework. It is the piece the CI gates can
actually check, and this migration does not touch it. The Solid
layer consumes it; it does not absorb it.

### `tui/app.tsx` — the Solid tree (new)

The declarative renderer. The shell's imperative state becomes Solid
state:

| imperative (today)             | Solid (after)                                     |
| ------------------------------ | ------------------------------------------------- |
| `views: Map<id, Renderable>`   | `createStore` keyed by item id                    |
| `cards: Map<id, CardView>`     | a `<ToolCard>` component per tool                 |
| `mount`/`patchCard`/`applyOps` | store writes + `<For>` over the tree              |
| `toolOrder` + `paintSelection` | a `selected` signal                               |
| `destroyRecursively` on evict  | `<For>` drops the row; the reconciler disposes it |
| `contentSig` rebuild guard     | Solid's own diffing                               |

The item tree becomes a `createStore<{ items: Item[] }>`; the store
is written by the same op stream the model already emits, so the
model's contract is unchanged and its tests stay valid.

Component mapping, from the imperative shell to the catalogue:

| today (imperative)             | after (Solid) |
| ------------------------------ | ------------- |
| `TextRenderable` banner        | `<text>`      |
| `ScrollBoxRenderable`          | `<scrollbox>` |
| `MarkdownRenderable`           | `<markdown>`  |
| `CodeRenderable`               | `<code>`      |
| `DiffRenderable`               | `<diff>`      |
| `BoxRenderable` tool card      | `<box>`       |
| `TextRenderable` styled header | `<text>`      |

### `tui/main.ts` — the shell (slimmer)

Keeps everything that is _not_ rendering: argument parsing, the
`--dump` headless readout, target resolution, the archive tail pump,
the LED verdict, and the release envelope. It hands the store to the
Solid tree and lets the reconciler own the renderables.

### `tui/theme.ts`, `tui/view.ts`, `tui/state.ts` — the look and the fold

- `theme.ts` is the semantic palette (`accent`, `success`, `error`,
  `warning`, `muted`, `surface`, `border`, `text`) — tokens, not raw
  hex, the way opencode's theme context names roles. It stays
  import-free so the Node tests can reach it through `view.ts`; the
  one `SyntaxStyle` derived from it lives in `app.tsx` where
  `@opentui/core` resolves.
- `view.ts` is the pure text/geometry the tree renders: the card
  header (glyph + title + kind + the arg's FIRST meaningful line —
  a multiline arg never flattens to `⏎`), the arg's body form,
  border/glyph colors by status, the side-item tone color, the body
  line count, and the synthesized unified-diff text.
- `state.ts` adds the header bar's `meta` (`worktree`, `agent`,
  `led`, `mode` — pushed by the shell's report path via
  `writer.setMeta`) and the auto-fold: a card whose body lands past
  `COLLAPSE_AT` (12) lines arrives folded with a `… N more` hint;
  the user's fold key overrides it and a later op never re-folds.

The look that falls out: a surface-backed header bar (`bro: session`
- worktree slug + agent, LED chip on the right colored by verdict),
  a dim one-line footer of key hints, `rounded` tool cards whose
  border takes the status color (the selected card takes the accent
  border over a subtle surface), a live spinner in place of the
  static `⣿`, agent speech as streaming markdown, thoughts dim+italic,
  turns as dim `── … ──` dividers (failed in the error color), and
  permission asks in the warning color.

## The transform: where it registers

The pane is spawned by herdr with an arbitrary cwd, so a `bunfig.toml`
in the plugin directory is not reliably found. The transform is
therefore registered **in the entry file itself**:

```ts
// tui/main.ts
await import('@opentui/solid/preload'); // registers the Bun plugin
const { mountPane } = await import('./app.tsx'); // .tsx, transformed on load
```

Three properties make this work, all verified:

- The preload's `onLoad` hook is a **Bun plugin**, so it applies to
  every module loaded _after_ it is registered.
- The preload import must be **dynamic** — Bun builds the import
  graph before evaluating, so a static preload import lands after
  `solid-js` has already loaded as the server build (constraint 4).
- The entry stays `.ts`, so `--dump` keeps its headless readout with
  no Solid in the graph (`main.ts` must not become a `.tsx` or the
  readout would need the transform).

The entry therefore statically imports **nothing** Solid: no
`solid-js`, no `@opentui/solid`. `@opentui/core` is fine — it does
not depend on Solid, and both the entry and the tree must resolve it
to the _same_ instance (one hoisted copy; a second copy would give
the tree a different renderer than the entry's).

`--dump` stays exactly where it is: a headless readout of
`model.dump()` with no Solid and no renderer. It runs under Bun —
the entry's static graph reaches `packages/cli` sources that use
TypeScript parameter properties, which Node's type-stripping rejects
— but it never touches the Solid wall, which is the property the
split exists to preserve.

## What the migration does NOT do

- **No second ACP client, no new data source.** The archive tail is
  the wire, unchanged.
- **No change to the LED contract.** `report-agent` with the
  `bro-session` agent and the `working`/`idle`/`blocked` verdicts
  are produced by the same `session-feed.ts` seam.
- **No change to `model.ts`.** Pure in, pure out.
- **No change to the fallback.** No Bun → `bro herdr session-view`.
- **No change to the readonly rule.** The pane never sends
  `session/prompt`.

## Testing

Two test surfaces, split by what can run where:

- **The model** stays under `tsx --test` (Node). It is unchanged, so
  its existing tests stay green — that is the regression net for the
  item tree.
- **The state fold** (`tui/state.ts`) is pure data, so it is Node-
  testable too: `plugins/herdr/test/tui-state.test.ts` covers the
  fold's semantics — eviction, late ops for evicted items, the
  tool-only selection walk — without a renderer.
- **The Solid tree** is tested through `createTestRenderer` from
  `@opentui/core/testing`, which is a headless renderer: no
  terminal, no FFI screen, and `captureCharFrame()` returns the
  rendered characters. This is the seam that makes the UI assertable
  at all. The assertions are on _rendered output_ — the banner, the
  card border, the tool body folding, the eviction dropping a row —
  not on internal state.

The tree test needs the Solid runtime, so it runs under `bun test`
and lives beside the app it exercises (`tui/pane.test.tsx`). It loads
the preload **dynamically**, in the same order the entry does — a
test that imported the app statically would load `solid-js` as the
server build and assert on a tree that never updates.

### The end-to-end proof

The headless renderer proves the tree. The pane is also proven in a
real terminal: a PTY smoke runs the entry against a fixture worktree
whose fleet-status file points at an event archive, and asserts that
the banner, the archive's rows, and a row appended _while the pane
runs_ all reach the screen. The last one is the property the whole
migration is for — a live session streaming into the pane.

## Vendored spike — `FasterPHP/acp-tui`

The user's verdict on the Solid tree above: better, but still not
it — too verbose, and the ask became "a control you feed events
into that renders well out of the box". The candidate is
`FasterPHP/acp-tui` (Apache-2.0, Bun + OpenTUI + Solid): a monorepo
whose `packages/acp-model` is a framework-free ACP-update reducer
and whose `packages/acp-tui/src/conversation/` is the card/list
rendering it feeds. Not on npm — the packages are `private: true`.
This section records the spike: what vendoring costs, what a real
archive produces through their reducer, which modules are
self-contained, and what to adopt.

### The vendor

`plugins/herdr/tui/vendor/acp-tui` is a **git submodule** pinned at
upstream `70b8a6d` (v0.2.0) — upstream tracking stays cheap
(`git submodule update --remote`), `.gitmodules` records the source.
`tui/package.json` resolves the model as a `file:` dependency:

```json
"acp-model": "file:vendor/acp-tui/packages/acp-model"
```

`bun install` copies the package into `tui/node_modules` and pulls
its declared dep — `@agentclientprotocol/sdk@1.5.0`, their exact
pin, isolated inside tui scope (repo root carries `^1.7.0`, no
conflict). `marked@17.0.1` and `zod` also resolve — bun walked the
vendored workspace root's dependency set. **Two caveats:**
`file:` deps are COPIES, not links — editing the vendored tree
needs a reinstall; and a checkout without `--recurse-submodules`
leaves the dir empty, breaking `bun install`. The tui package is
outside the npm workspace so repo CI never builds it, but the
operator step (`bun install`) documents the need.

### The real-archive feed

`spike-feed.ts` replays
`native-af580313.events.jsonl` (25,562 rows, ~23 MB, a live loop
archive) through `createSession()`/`reduce()`. The adapter maps
rows to `ModelEvent`s: `session_opening` (mode `load` — the
archive IS a replay, so every item gets `origin: "replay"`), each
`update` row as `session_update` with the row's `ts`, each
`turn stop` as `prompt_response` (the `turn_end` marker lands;
duration is 0 since the archive never carries a `prompt_sent`),
`turn start` as nothing (a `prompt_sent` would fabricate a
`user_message`), permission rows as `permission_opened` with a
minimal request, and a closing `session_opened` that finalises
everything.

Result, verbatim from the probe:

```
rows=25562 feedMs=11451
items=6088 — tool_call=4643, agent_message=786, thought=199, marker=460
byOrigin={"replay":6088}  byStatus={"final":6088}
contentTypes={"text":4593,"diff":72,"terminal_unavailable":1}
toolCalls=4643 withContent=4601 withRawOutput=0
debug-dropped: unknown_mode=4  (no session_created → no modes list)
state=idle stopReason=end_turn
```

Versus our `SessionModel` on the same rows: 266 ms, 500 items
(the `MAX_ITEMS` bound evicts the rest). Every shape survives —
tool calls with content, **72 diffs**, the terminal-unavailable
note, all 460 turn boundaries — with zero fabricated user items.
Post-`session_opened` rows land `origin: "other"` (verified): a
live tail is observed-client activity, exactly the pane's posture.
The 43× feed cost is the price of their immutable fold
(`new Map(items)` + `[...order]` per event); it only matters on
bulk replay — keep the `TAIL_BYTES` window and per-row live cost
is the same as ours.

### What imports standalone

Probed by importing each module directly under bun from `tui/`:

| module                                                                                                                | verdict                  | what it takes                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp-model` (whole)                                                                                                   | **take**                 | reducer + typed `Item` union (permission, plan, turn_end with usage, tool index, `rawOutputText`), `ItemOrigin` incl. `replay`, pure, sdk types only. Replaces `model.ts` wholesale behind a row→`ModelEvent` adapter.                                                                                                                                                      |
| `conversation/view-model.ts`                                                                                          | **take**                 | `solid-js` + `import type Item` — nothing else. The collapse/snippet/cursor/anchor state machine; default is COLLAPSED with 10-row output snippets — the "not verbose" behaviour is their baseline.                                                                                                                                                                         |
| `conversation/card.ts`                                                                                                | **adapt**                | pure row layout — rows of styled spans, no OpenTUI/Solid — but drags `marked`, `command-result`, `content`, `format`, `live-glyphs`→`glyphs`→`config/problems` (light), and `markdown/{code,context,emoji,layout,project,wrap}`. Imports as-is today; adoption means shimming their `theme/index` tokens to ours.                                                           |
| `conversation/format.ts`                                                                                              | **adapt**                | collapsed-line formatting (`tool …`, `plan 3/5`, thought one-liner); drags `layout/modules`→`keys/hints`+`keys/keymap` for statusbar helpers — lift the item formatters, skip the key parts.                                                                                                                                                                                |
| `conversation/content.ts`, `command-result.ts`, `glyphs.ts`, `live-glyphs.ts`, `list.ts`                              | **adapt**                | content-block→card-lines, envelope detection (exit code/output), glyph tables, solid glyph signals — each small; glyphs needs `config/problems` (itself light: `node:path` + `sanitise`).                                                                                                                                                                                   |
| `conversation/markdown/*` (19 files)                                                                                  | **adapt — biggest lift** | their real renderer: lex/wrap/layout/draw/highlight/table/emoji/footnotes. Pulls `marked`, `grammars.ts` (23 MB bundled tree-sitter), `renderer/capabilities` (terminal probe), `theme/code`, `render/emoji`, `@opentui/core` drawables. Option A: take the subtree + grammar assets + shims. Option B (cheaper): keep `<markdown>`/`<code>` inside their row-layout frame. |
| `conversation/window/heights.ts`, `entries/geometry/range`                                                            | **adapt**                | measured-height windowing over card layouts — needs the card subtree. Their answer to big sessions; our `MAX_ITEMS` cap answers it differently.                                                                                                                                                                                                                             |
| `conversation/scroll.ts`                                                                                              | **adapt**                | anchor+following scroll controller; `renderer/wheel`→`capabilities` is terminal-specific — take the anchor logic, keep our scrollbox.                                                                                                                                                                                                                                       |
| `conversation/scrollbar.ts`                                                                                           | **skip**                 | drags `selection/cells`→projection+rows — their selection machinery; `ScrollBoxRenderable` covers us.                                                                                                                                                                                                                                                                       |
| `conversation/items.tsx`, `window/WindowedConversation.tsx`                                                           | **skip**                 | drag `app/context`, `keys/keymap`, `keys/register`, `renderer/mouse` — their app shell, key system and mouse layer are not ours.                                                                                                                                                                                                                                            |
| `session/`, `config/`, `keys/`, `app/`, `agent/`, `platform/`, `render/`, `selection/`, `overlay/`, `find/`, `cli.ts` | **skip**                 | application machinery — sessions store, config schema, key bindings, screens.                                                                                                                                                                                                                                                                                               |
| `fake-agent`                                                                                                          | **skip (useful)**        | scriptable ACP agent for tests — reference for our own fixtures, not a dependency.                                                                                                                                                                                                                                                                                          |

API skew to price in: they pin `@opentui/*@0.6.6`; we run `0.8.0`.
Every module that touches renderables (`draw`, `scroll`, `scrollbar`,
`items.tsx`, `WindowedConversation`) needs an API pass — another
reason the renderable-free modules are the take/adapt set.

### Recommendation

Adopt `acp-model` as the pane's model behind a thin
`ArchiveRow`→`ModelEvent` adapter (`session_opening` once,
`session_update` per row, `prompt_response` per `turn stop`,
`session_opened` on attach-end — the live tail then flows in as
`"other"` items with no extra seam). Adopt `view-model.ts` as the
collapse/cursor/snippet machine. Adapt `card.ts` + `content` +
`format` + `command-result` + `glyphs` as the card engine on
Option B first — their row layout, our `<markdown>`/`<code>`
drawables, our theme tokens — and keep our scrollbox, j/k and LED
shell. That is the "control you feed events into" shape without
their app: collapse-by-default cards, 10-row snippets, `⣿`-class
glyph language, a model that has already eaten a 23 MB real
archive. Re-evaluate the markdown subtree (Option A) only if the
look still misses after the card engine lands.

Spike artifacts: `vendor/acp-tui` (submodule @ `70b8a6d`),
`tui/spike-feed.ts` (the replay probe + adapter), this section.
`main.ts`/`app.tsx` untouched — adoption is a follow-on decision.

## Phase 2 — the seam and the `acp` impl

The spike's recommendation landed as a **parallel implementation
behind a seam**, not a refactor — per the brief's amendment, nothing
was deleted and `legacy` stays the default until the `acp` impl
proves itself in the live pane.

### The seam contract (`tui/impl.ts`)

The shell (`main.ts`) speaks one interface:

```ts
interface PaneImpl {
  readonly name: string; // 'legacy' | 'acp'
  readonly fold: 'legacy' | 'folded'; // the impl's fold policy
  feed(row: ArchiveRow): void; // archive rows in
  beginLive(): void; // replay/live boundary
  drain(): Op[]; // ops for the state fold
  readonly verdict: { led; mode } | undefined; // rowVerdict shape
  dump(): string[]; // headless projection
}
```

The seam's currency is the `Op` stream `state.ts` already consumes —
`app.tsx`, the writer, and the key bindings are impl-agnostic by
construction; a third impl registers one factory in `IMPLS` and
nothing else moves. Selection resolves `--impl <name>` >
`BRO_TUI_IMPL` > `'legacy'` (`pickImpl`/`implArg`), and the `acp`
factory lazy-imports `acp-model` so Node tests and the `--dump`
path never touch it. The impl's `fold` reaches the fold as
`PaneState.foldAll` via `mountPane`/`emptyState` — `legacy` keeps
the COLLAPSE_AT heuristic, `folded` collapses every card body (the
vendored view-model's `expanded(item) === false` baseline — the
"too verbose" answer). A `tool` op may now omit `collapsed` so an
update never stomps the user's toggle.

### The `acp` impl (`tui/acp/`)

- `model.ts` — `AcpImpl`: the vendored session behind the seam. The
  feed adapter is the spike's verbatim (`session_opening(load)` →
  `session_update` per row → `prompt_response` per `turn stop` →
  `permission_opened` per permission row); `beginLive()` reduces
  `session_opened` so the live tail lands `origin: "other"`. Their
  session is immutable and delta-free, so `drain()` diffs the item
  map against the last snapshot and emits our ops — a changed item
  re-projects whole. Their `ToolCallItem` drops `rawInput`, so
  `feed()` stashes `toolArg(u)` per `toolCallId` on the way past —
  the card header keeps its exact arg fidelity. `rawOutputText`
  projects as a content fallback when `content` is empty (their
  view-model's same fallback). Verdict maps session state:
  `replaying` → working/replaying, `disconnected` → blocked,
  `requires_action` → blocked/permission, `running` → working/turn,
  `idle` → idle (+`turn complete` when a stop reason stands).
- `conform.ts` — the shared conformance probe: the same archive
  through every registered impl, coverage compared **on the op
  stream** (the seam's currency), not the eviction-windowed state —
  two impls emitting different item mixes otherwise disagree at the
  500-item frontier for no real reason.

### What was taken, adapted, skipped

- **Taken**: `acp-model` whole — session, reducer, item types,
  replay/other origin semantics.
- **Adapted**: the vendored view-model's _fold semantics_ (collapse
  default = every body, user toggle survives updates) as a fold
  policy on `state.ts`, and their item→card language as a
  projection (`tool_call` → ToolItem incl. `rawOutputText`
  fallback; `plan`/`permission_record`/`marker` → the side rows our
  model already used). Tool args keep OUR `toolArg` extraction —
  their items do not carry `rawInput`.
- **Skipped**: `items.tsx`/`WindowedConversation`/session-store/
  config/keys (their app shell — ours stays), the `card.ts`/`format`/
  markdown row engine (our Solid card renders the same fold
  contract; pulling their row layout is the deferred Option), the
  `outputShown` snippet key (our fold IS the snippet: collapsed =
  header + count, expanded = full), and their cursor-over-all-items
  walk (our j/k stays tool-cards-only).

### Conformance on the real archive (25,562 rows)

```
legacy: tools=4643 wContent=4388 diffs=78 msg=791 thought=199 turn=460 perm=0 note=537
acp:    tools=4643 wContent=4601 diffs=72 msg=786 thought=199 turn=460 perm=0 note=0
```

Tool calls and turn markers match exactly. The `acp` impl covers
**more** of the wire: `wContent` is higher (the `rawOutputText`
fallback fills cards ours left empty), and on unique
`(toolCallId, path)` pairs the diff coverage is 72 vs 39 — their
model keeps diffs our repeat-status dedupe drops. `note` collapses
537 → 0: `usage_update`, `current_mode_update`,
`available_commands_update`, `session_info_update` become session
state in their model instead of scrollback noise — the other half
of "too verbose". `bun run tui/acp/conform.ts <events.jsonl>`
re-runs the check on any archive.

### Before/after

- `model.ts`/`state.ts`/`app.tsx` unchanged as the default path —
  `SessionModel` is now `LegacyImpl` (zero delegation loss).
- `main.ts` resolves `pickImpl` once and speaks the seam —
  `--impl acp` flips a pane; `--dump` honors it too.
- `biome.json` excludes `**/vendor/**` — upstream code is not ours
  to lint or format.
- `--dump` on the acp impl projects `collapsed: false` — a dump is
  the full readout; the fold is pane state, not model state.

Dogfood: `bun run plugins/herdr/tui/main.ts <wt> --impl acp` in a
pane (or `BRO_TUI_IMPL=acp` for a whole attach). `default stays
legacy` is load-bearing — flipping the default is a one-line
`pickImpl` change after live review.

## Risks

- **Solid's prop application is post-construction.** The reconciler
  creates a renderable with `{ id }` and then sets properties, while
  the imperative shell passed options to the constructor. Every
  option the pane uses was checked to have a setter that does the
  same work (`border`, `borderColor`, `borderStyle`, `visible`,
  `content`, `streaming`, `stickyScroll`, `stickyStart`,
  `viewportCulling`, `syntaxStyle`, `filetype`, `diff`, `view`).
  One that lacked a setter would silently do nothing.
- **`<scrollbox>` needs `stickyScroll` set before content lands.**
  The setter calls `_applyScrollOptions`, so it must be applied —
  the catalogue's prop order applies it at creation, before children
  arrive. Verified: content appended after mount still scrolls to
  the bottom.
- **Selection state must not fight the reconciler.** The selected
  card's border style changes; a `borderStyle` write marks the
  raster dirty without a layout pass.
- **The store must be keyed by id, not by index.** Items evict from
  the front; index-keyed state would mis-attribute a row's updates
  after an eviction.
- **A static Solid import in the entry is a silent regression.**
  It compiles, it renders, and it never updates — the pane looks
  right in a screenshot and is dead in the terminal. The headless
  test catches it (it asserts a _changed_ value, not a rendered
  frame), which is why the tree test asserts on the update rather
  than only on the first paint.
