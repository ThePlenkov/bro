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
- `lines.ts` — the vendored **row language**: `toolLine` /
  `thoughtLine` / `planLine` / `permissionLine` / `turnEndLine` from
  their `conversation/format.ts`, plus `LIVE_GLYPHS` and
  `DEFAULT_THEME` — imported straight from the submodule (it loads
  clean). `acpLine(vi, width, frame, findTool)` resolves an item's
  `Segment[]`; `segStyle` resolves each `TokenName` through their
  `DEFAULT_THEME` (`ref` hops, `{color, light, bold, italic, dim}`
  styles) into `<text>` props.
- `conform.ts` — the shared conformance probe: the same archive
  through every registered impl, coverage compared **on the op
  stream** (the seam's currency), not the eviction-windowed state —
  two impls emitting different item mixes otherwise disagree at the
  500-item frontier for no real reason.

### The row language on the pane

Every acp-projected item carries its source `Item` on `vi` (opaque
to the seam — `Item.vi?: unknown`, `Op` unchanged since `append` /
partial `tool` ops carry it for free). `app.tsx` branches per row:
`item.vi !== undefined` renders `AcpSegRow` — the `format.ts`
one-liner painted segment-by-segment — while legacy items keep the
`ToolCard` chrome. An expanded tool keeps its vendored line and
opens into an `│`-guttered body over the existing `<markdown>` /
`<code>` / `<diff>` renderables (Option B verbatim: their layout,
our payload blocks). `permissionLine` links back to its tool via a
`toolCallId` lookup over pane items; `renderer.width` feeds
`toolLine`'s right-aligned tail; the running-tool spinner is the
existing 10 fps `onAnimationTick` frame. `--dump` prints the same
`lineText` rows so the headless readout matches the pane.

Vendored sources now sit on the tsc graph (through `format.ts` →
`layout/segments` → `live-glyphs`), so `vendor-env.d.ts` declares
the two Bun symbols they touch (`Bun`, `bun:ffi`). `bun-types` was
rejected: its globals redeclare `ReadableStream` and break
`serve-provider.ts` across the packages this tsconfig reaches.

### What was taken, adapted, skipped

- **Taken**: `acp-model` whole — session, reducer, item types,
  replay/other origin semantics.
- **Adapted**: `conversation/format.ts` + `live-glyphs` +
  `theme/default-theme` — the collapsed-line engine and its
  palette, called directly; only our `Segment` → `<text>` paint is
  new. The vendored view-model's _fold semantics_ (collapse default
  = every body, user toggle survives updates) as a fold policy on
  `state.ts`, and their item→card language as a projection
  (`tool_call` → ToolItem incl. `rawOutputText` fallback;
  `plan`/`permission_record`/`marker` → the side rows our model
  already used). Tool args keep OUR `toolArg` extraction — their
  items do not carry `rawInput`.
- **Skipped**: `items.tsx`/`WindowedConversation`/session-store/
  config/keys (their app shell — ours stays), `card.ts` and the
  markdown subtree (our renderables paint the expanded body), the
  `outputShown` snippet key (our fold IS the snippet: collapsed =
  the line, expanded = full), their cursor-over-all-items walk (our
  j/k stays tool-cards-only), and their `theme` switching — the
  pane paints `DEFAULT_THEME` ("terminal", their out-of-box look).

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

## Phase 3 — own control kit, the prompt, and the audit

**Vendoring** (addendum 6): the git dependency is gone — the
`vendor/acp-tui` submodule was removed; only `packages/acp-model`'s
source is vendored at `tui/vendor/acp-model/src/` (Apache-2.0
LICENSE + NOTICE preserved, `ATTRIBUTION.md` pins upstream
`70b8a6d`). The acp impl imports `vendor/acp-model/src/index.ts`
directly — no submodule, no `file:` workspace indirection.
`vendor-env.d.ts` died with the submodule (acp-model's src is pure
TS, only `import type` on the sdk).

**Own control kit**: `tui/acp/lines.ts` is now OUR implementation of
the row language we studied — the `conversation/` layer stays a
reference, never an import. `acpLine` renders their one-liners
(`$ ✓ execute  Bash …  #N` with the right-aligned index tail, `∴`
thoughts, `◈ plan n/m`, `⚠ permission ‹t› — outcome`) resolved
through OUR theme tokens (`Segment.token` → `theme.*`, diff fills as
dark-tint washes), and the turn boundary is the compact confirmed
form `end turn · Ns · stopReason` (0.0s on replay — archive rows
carry no live duration). `acpCardRows` is our card language
(numbered diff hunks with `diff.add.bg`/`diff.del.bg` row fills,
terminal notice, blank-row block separators, `▸ JSON` for pure-JSON
results), `itemGroup`/`spacingBefore` our `list.ts`-rhythm grouping
(user/agent/activity/plan/marker, blank row on group change).
`Item.vi` remains the seam's escape hatch — geometry is shared,
vocabulary is per-impl.

**Prompt journaling** (addendum 3, supersedes the sidecar-injection
note below): bro JOURNALS the prompt — `AgentTurnPlane.start(prompt?)`
records `{ kind:'prompt', text }` in `.events.jsonl` right after the
turn-start row (fail-open like all archive telemetry), `pumpTurn`
passes the flattened prompt through. Both impls consume journaled
rows INLINE (per-turn chronological position — the acp impl emits a
prompt item as the row arrives, `dump()` interleaves by recorded
position). `main.ts` reads `.prompt.md` ONLY as a legacy fallback
when the archive carries no journaled prompt row.

**Activity collapse** (addendum 6's confirmed baseline): runs of
≥2 consecutive activity items (tool_call/thought/plan/
permission_record) collapse into ONE `▸ N tool calls · N thought ·
Ns` item — their live TUI's per-turn density, now ours. The run's
leader keeps its slot and morphs in place via a `tool` op when the
second member lands (no order churn); members hang under the `│`
gutter when the row expands (`ToolItem.runs` carries them). A lone
tool stays its own card — the collapse is run-shaped, not
kind-shaped. On the grep-storm archive the item stream drops to
less than half (appended 9583→4479) with tool coverage unchanged
(5248 member-counted, conform compares members not group rows).

**Judge verdicts** (addendum 4): `tui/verdict.ts` — a data-driven
shape table over the typed-answer wire (`noul`/`choice`/`score`,
provider-judge's contract). Classification is shape-based — every
answer must match the table, so prose never trips it — because the
real archive proves `by` carries provider labels
(`acp provider 'devin-acp'`, `provider:kilo`), never a judge label;
the journaled prompt preamble or a `judge`/`jev` `by` narrows it
further on post-journaling archives. A structured reply renders as
`⛨ jev` — badge, one-line summary, field table — never the JSON
wall, in the pane and in `--dump`. Unknown/malformed bodies fall
back to `▸ JSON`.

**Timeline** (addendum 5): every item carries the archive `ts` on
`Item.at`; the pane renders a dim `HH:MM` gutter. Unknown/absorbed
update kinds tally into a single `▸ N hidden` row — the noise floor
is counted, never silently dropped.

**Prompt fallback** (pre-journaling archives): `main.ts` reads the
sibling `<agentId>.prompt.md` and feeds `{ kind: 'prompt', text }`
only when the archive has no journaled prompt row.
`TextItem.kind: 'prompt'` renders as a distinct surface — accent `▸`
gutter, markdown body; absent everywhere degrades to
`▸ prompt unavailable` (empty text, never fabricated).

**The audit** (addendum): `conform.ts` counts archive
`agent_message_chunk` rows and the tail AFTER the last tool row —
`audit: msgChunks=… postToolChunks=… postToolChars=… prompts=…/…` —
and fails if either impl's message text covers fewer chars than the
post-tool tail. On the rich `native-84dfbac4` (xiq2m) archive:
tools 5248=5248, messages 2120=2120, prompts 1/1 — covered by both.

**Quit removed** (addendum 2): the `q`/`escape`/`Ctrl-C` self-quit
binding and the `q quit` footer hint are gone — herdr owns pane
lifecycle. The process exits on herdr's pane close (signal →
`process.exit` → `'exit'` releases the session lock); `quit()` was
deleted with its last caller.

**Mouse off** (addendum 7): the pane uses no mouse features, so
capture is disabled twice — `useMouse: false` on `createCliRenderer`
(never enables) and `renderer.useMouse = false` in `mountPane` (the
chokepoint for every mount). Wire check: no `?1000/2/3/6` sequences
emitted at all, so native terminal selection and herdr's own
selection both work without Shift. A future click feature goes
behind a flag, off by default.

**Ctrl+C copies** (addendum 8): `exitOnCtrlC: false` hands 0x03 to
the key handler (kitty disambiguation delivers `ctrl+c` as an
event). `PaneImpl.copyText(item)` is the seam's copy payload — the
impl's own line language at copy width, unclipped (a run emits every
member line, a tool its one-liner + full body, a verdict its control
text). `writer.copy()` resolves the selected card, else the latest
row. The shell writes `OSC 52;c;<base64>` to stdout — terminals that
speak OSC 52 put it on the system clipboard — and the footer shows a
1.5s 'copied' toast. No input fields exist, so the selected-text
branch of the spec is vacuous. Decision: NO quit chord — addendum 2
stands; the process exits only on herdr's pane close or a signal.
Copy verified on the wire: `\x1b]52;c;` emitted, payload decodes to
the run's tally + member lines.

**Wheel without capture** (addendum 9): alternate scroll `?1007h` on
start (`?1007l` on exit) — terminals translate the wheel into arrow
keys when the app holds no mouse mode, so scroll returns while plain
drag still selects (button tracking stays off). Arrows/PgUp/PgDn/
Home/End now actually scroll — `pane.scroll`/`scrollPage`/`scrollEdge`
drive the captured `ScrollBoxRenderable` (`scrollBy`/`scrollTo`),
previously the footer claimed bindings that never existed.

**Inline rendering** (addendum 10 — the wheel's actual root cause):
herdr owns the mouse; in alt-screen its wheel scrolls HERDR's
scrollback, which is empty while our pane owns the alt buffer.
`screenMode: 'main-screen'` renders the feed inline — every row lands
in herdr's native scrollback, so wheel scroll, drag-select, and
copy-mode all ride the terminal for free; keyboard scroll
(arrows/PgUp) keeps working as before. `?1007` was removed with it:
alternate-scroll only exists for alt-screen apps, and on the primary
screen it would inject phantom arrows while the terminal scrolls
natively — a double-scroll. `split-footer` (footer-pinned variant)
stalled the renderer under a dumb pty and was not pursued; the
hints row scrolls off with the feed like any other line. Verified
on the wire: `?1049h` absent, OSC52 copy still fires, `▸` tally rows
flow. What inline mode costs: frame repaints land in scrollback too
(stale footer/header copies accumulate above — cosmetic only for a
read-mostly feed) and the live tail keeps appending below the user's
scroll position — herdr pins or tracks that per its own pane
semantics.

**Feed header + generic turn labels** (addendum 11): the acp dump
and pane open with a `▸` header — agent, worktree, provider, model,
launch stamp (`setContext({worktree, agent})` on both the live and
dump paths; model resolves from the session's `currentModelId` or
config options). Every model call carries its caller label — the `▸`
activity line suffixes `· <provider>` from the row's `by` (`shortBy`
strips `acp provider 'X'`/`provider:X`/`conductor:X` to `X`), and
verdict badges go generic: `⛨ <model>` when the reply JSON carries a
`model` field (e.g. `typesafe/jev-1.13`), `⛨ <by>` when it does not
(e.g. `⛨ kilo`) — no `jev` branding anywhere; the shape table in
`verdict.ts` is the classifier. `end turn` rows are gone: their
duration and `ctx used/size` fold into the most recent `▸` activity
line (`endFold` mutates the leader item in place on the live path,
same fold in `dump()`); a `turn_end` with no preceding activity is
absorbed silently.

**Opencode chrome** (addendum 13 — supersedes addendum 12's generic
bg-block spec with concrete capture values): `theme.ts` IS the real
opencode palette, extracted from a live ANSI capture
(`/tmp/opencode-view.ansi`): base `#0a0a0a`, block `#141414`, text
`#ffffff`, emphasis `#eeeeee`, muted `#808080`, peach `#fab283`,
thought amber `#97682c`, cyan `#56b6c2`, info blue `#5c9cf5`,
warning `#f5a742`, success `#7fd88f` (`error` was absent from the
capture slice; it keeps opencode's standard red). Their row grammar
maps onto our surfaces: `⏺ ` peach bullet on assistant message rows;
`+ Thought · gist` amber rows for thought items (legacy kind AND
the acp `thoughtLine`); `┃`-barred `#141414` blocks — `BarRow`
paints two base cells, the peach `┃`, two pad cells, and fills the
surface to the right edge — for caller prompts (`Prompt` title,
emphasis text, cyan-underlined links), `Verdict` cards, and
`Permission` cards (legacy `permission` items and acp
`permission_record` both map — their Questions card IS a permission
ask). Prompt bodies pre-wrap (`wrapPlain`) so every visual row
carries the bar. The feed header is a `#141414` bar; a dim
right-aligned `Jump to latest ↓` chip appears above the footer
while the scrollbox is off-bottom (keyboard scrolling only — the
wheel rides herdr's native scrollback); the footer gains the
right-aligned worktree slug (their `path:branch` bottom status).
Links render cyan+underline via `markup.link` and `LinkRuns` in
block content. Diff row fills retinted for the dark base
(`#14231a`/`#2a1518`). Wire-verified on the s7409 tail: palette
bytes `48;2;10;10;10`/`48;2;20;20;20`/`38;2;250;178;131` emit, `┃`
verdict cards, `⏺` bullets, `▸` tallies, and prompt `┃` lines with
a cyan link row all paint.

**Perf bench** (addendum 14 — measured, then fixed the one proven
hotspot). Real archives: 92MB (`native-94a96fb1`), 77MB
(`native-6cabfb8a`), 29MB (`native-af580313`). The pane only ever
replays the last `TAIL_BYTES` (64KB) — `readTailSlice` stats+seeks,
no whole-file reads even at 92MB. Numbers (bun, model path):
tail read 0-3ms; `feed` 328 rows 3-4ms; `drain` 0-1ms; 203 items
appended legacy / 97 acp (run-collapse halves it); RSS +4-7MB over
replay; live-append cost p50 0-0.06ms, p95 <=0.15ms (worst single
row 5.8ms, a GC or burst edge). Materialization is already windowed:
`MAX_ITEMS=500` evicts, `viewportCulling` clips, the 64KB tail caps
replay — no further windowing was added; the measured costs don't
justify it. The proven hotspot was steady-state, not replay: every
row's `segs` memo read `props.frame()` unconditionally, so the 10Hz
spinner tick re-ran `acpLine` (~0.2ms/row) across ALL rows — ~1
core at 500 items. Fix: `frame()` is now read only when
`item.status === 'live'` — settled rows hold one derived line and
never re-subscribe to the tick; run members gate the same way.
Append path unchanged (p95 0.15ms), spinner still animates live
rows at 10Hz.

**Clean start** (addendum 15): inline mode was drawing BELOW the
pane's existing scrollback — the launch command line and prior
output read as a stale screen above the feed. One
`\x1b[2J\x1b[3J\x1b[H` lands between renderer init and the first
frame: screen AND scrollback cleared, cursor home, the feed begins
at the top of a clean pane. Startup-only — never mid-run; the
pane's prior scrollback is not content we own. Wire-verified:
`2J`/`3J`/`H` emit before the first painted glyph.

**Pinned chrome** (addendum 16): the top ` bro: session` bar was a
feed row and scrolled away during replay. The renderer offers no
top-split — `screenMode` is `alternate-screen`/`main-screen`/
`split-footer` and `footerHeight` is the only pinned-region knob —
so the sanctioned fallback is taken: `screenMode: 'split-footer'`
- `footerHeight: 2` pins the frame's last two rows. The identity
  line (worktree, agent, LED, mode) sits directly above the keys
  line — both are pinned chrome now; the feed scrolls under them
  into herdr's scrollback. The addendum-11 feed header (`▸
provider · agent · cwd · launched`) stays an in-feed item — it is
  the archive's identity block, not chrome. Verified: the frame's
  last two painted rows are identity + keys; the feed no longer
  carries the bar.

**Expansion without a mouse** (live bug report): clicks can never
reach the pane — capture is off (addendum 7) and herdr owns the
mouse — so runs/cards open via selection: j/k lands on a collapsed
`▸` run or card and PREVIEWS it (members/body shown, `▾` glyph);
Enter/c pins the toggle. `foldTouched` on the item records an
explicit fold so toggling a selected card SHUT holds — the preview
only opens folds the user never touched. A run member copy still
emits every member line.

**Real markdown** (addendum 18): all prose surfaces route through
`<markdown>` — assistant `⏺` prose already did; the caller prompt's
`┃` block now does too, so `[text](url)`, `**bold**`, lists and
fences render instead of painting literal markers (`conceal` on;
fences highlight through the shared tree-sitter client `<code>`
already uses). The `┃` grammar moved from per-line `BarRow`s to a
`heavy`-bordered `BarBlock` — the border IS the bar, so markdown's
variable-height output keeps bar + `#141414` wash without
pre-wrapping; wrap/bg integrity holds by construction.
Verdict/permission blocks ride the same `BarBlock` with their
field rows. Oddity found: without `streaming` the renderable
paints nothing under this version — both call sites set it; for a
static prompt it merely leaves the trailing token unfinalized.

**Plugin-owned view lifecycle** (addendum 17 + field bugs A/B):
`src/live-views.ts` converges live bro agents to view panes every
tick — discovery reads state bro already owns: `agents.json` first,
then `<id>.<run>.go` handle files without a sibling `.exit` (the
janitor reaps registry entries; attempt pins outlive them — field
bug B: hand-written fleet-status entries were reaped the same way,
which is why the viewer never touches a foreign fleet doc at all).
Each live agent gets a FRESH `workspace create`d `🤖 view:<id>`
workspace — never `worktree open`, which resolves to an existing
workspace and would hijack someone's pane (caught in the field:
two records briefly pointed `pane run` at the user's main ws). The
record carries `owned:true`; retire closes only owned workspaces,
a flagless or foreign record just drops. Pane state lives in the
plugin's own `state.liveViews` map — the fleet-status ownership
answer is therefore "neither": no daemon writer call, no foreign
file, the viewer resolves the archive DIRECTLY via `--events`/
`--agent` (main.ts arg additions) and tail-police the events file
itself; a missing/empty archive just keeps polling inside the same
pane. Live-tail retry: `armFeed` widens the replay window 64KB →
4MB → whole file when the slice is ALL `update` rows (a tool-call
update storm can fill the tail and drain zero items — measured on
native-656ebe78: 64KB → 113 updates → 0 items; 4MB → 6927 rows →
32 items). Fixes found by the field exercise: the positional argv
scan treated a flag's VALUE as the worktree arg (`--events <path>`
without a worktree made the archive path `ctxDir` → ENOTDIR on
fleetStatusPath); `loadState` reconstructed `PluginState`
field-by-field and DROPPED `liveViews`, so records never survived
a tick (every converge would have re-opened duplicate workspaces).
**Render-mode regression found in the field, resolved**: under a
real herdr pane the feed painted blank even though `impl.drain()`
delivered ~7.3k ops into `writer.apply` and `applyOps` yielded
items in isolation. Root cause: `split-footer`'s render geometry
gives the renderable tree ONLY the footer strip
(`renderHeight = footerHeight`, `renderOffset = terminalHeight - N`)
— the scroll region is fed by _captured stdout_, never by
renderables. The first attempt reverted to `main-screen`, which
restored visible paint but silently CLIPPED every row past the
viewport (a 72-row replay yielded exactly 48 lines, 50 of 70 tool
rows lost — nothing ever reaches herdr scrollback). The final
shape is the designed mechanism: `screenMode: 'split-footer'` +
`footerHeight: TAIL_BUDGET + 3` — the renderable tree is ONLY the
footer strip (in-flight rows + the pinned ` bro: session` identity
- keys chrome), and the feed reaches the scroll region as captured
  stdout writes. `createPane` retires a PREFIX of the item order:
  settled items (`isSettled` — terminal tools, closed text blocks)
  flush the moment they settle, and any prefix past `TAIL_BUDGET`
  live rows follows. Prefix-only eviction keeps scrollback order
  identical to the feed; the selected item and the still-open tail
  chunk always stay live. Verified live: a 70-tool replay yields
  148 scrollback lines (`max_offset_from_bottom` > 100), mktj6 573,
  the l8c4f.16 live pane 1737; prompt `┃` blocks, compact `⏺ ✓`
  rows, and the pinned chrome all present. `pane run` does NOT
  replace a busy pane — code changes need a fresh workspace to be
  seen.

**Addendum 20 — folds + markdown integrity**: every text-ish block
longer than `FOLD_TEXT_AT` (8) source lines folds by default to a
`first line · +N lines` summary (prompt, message, thought, note —
`TextItem.collapsed`, same `foldTouched`/selection-peek grammar as
tool cards; the j/k walk now includes foldable text rows). Enter/c
expands — prompts, prose, thoughts and notes render through
`<markdown conceal streaming>` (fences highlight via the shared
tree-sitter client); a pinned-open tool body renders its full
content as `toolBodyMd()` markdown (diffs become ` ```diff `
fences). The scrollback path cannot carry renderables, so
`printLines()` runs `mdPlain()` — the plain-text `conceal`
equivalent: `**`/`` ` ``/link syntax/HTML tags strip, links print
`text (url)`, fence bodies keep as indented code. A folded row
prints only its summary. Field-verified on w4W: mktj6's 458-line
review-thread prompt paints as `┃ Prompt / +458 lines`, zero raw
`**`/`<details>`/`<review-threads>` literals in the buffer.

**Addendum 21 — the scrollbox feed (supersedes the addendum-16
split-footer split)**: split-footer's trade turned out wrong for a
read-first pane — every scrolled-past row degenerated to plain text
(`printLines`), markdown/conceal/colors survived only inside the
18-row strip, and captured stdout escaped the ESC byte so styling
could never reach the scroll region anyway. Final shape:
`screenMode: 'main-screen'` + ONE `<scrollbox>` holding the whole
feed — `flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom"
scrollY` — every row a retained renderable, scrolling is the
scrollbox's own `scrollTop` (the opencode/acp-tui `ConversationScrollBox`
model). `HeaderBar`+`FooterBar` sit OUTSIDE the scrollbox with
`flexShrink={0}`, so the ` bro: session` + keys chrome is pinned at
the bottom edge structurally — no scroll-margin tricks, no clipping
race; it stays put while the feed scrolls AND while rows append
(stickyScroll only follows when already at bottom — scrolled up,
`Jump to latest ↓` appears). Keyboard scroll:
arrows/PgUp/PgDn/Home/End → `scrollBy`/`scrollTo`; the wheel rides
herdr's alternate-scroll (`?1007`) into the same arrow keys since
`useMouse` stays off (native selection + herdr copy preserved).
`mountPane` drops `onRetire` — the eviction seam survives as an
optional test path. Companion fixes: **tool bodies fold on landing,
always** (`applyOps` append/tool branches — a completed call is one
compact `⏺ ✓` row; file/JSON dumps never own the feed); routine tool
ops strip `collapsed`/`foldTouched` (`SessionModel.pushTool`, the acp
convention) so status churn can't clobber pane-owned fold state — the
spread bug that kept unfolded bodies open on replay; `mdSource()`
strips HTML furniture (`<sub>`, `</review-threads>`, `<!-- -->`,
details/summary) before `<markdown>` since the renderable prints raw
tags literally — fences keep real code tags. Verified on w56/w57:
expanded 458-line review prompt renders clean markdown (rules lists,
placeholders like `<millis>` survive the narrowed strip), scroll +
`Jump to latest ↓` + scrollbar gutter live, chrome pinned.

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
