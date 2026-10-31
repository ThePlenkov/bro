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
