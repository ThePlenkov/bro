# Spike: acp-tui as vendored git source (bro-q2edc continuation)

User verdict on the current Solid pane: better but still not it —
too verbose, wants a control you feed events into that renders well
out of the box. Evaluation is done; the candidate is
`FasterPHP/acp-tui` (Apache-2.0, Bun+OpenTUI+Solid, monorepo with
`packages/acp-model` — a framework-free ACP-update reducer +
sanitiser + typed Item model incl. `ItemOrigin: "replay"`, and
`packages/acp-tui/src/conversation/` — card.ts, list.ts, view-model.ts
with density/collapse/output-snippet state, diff.ts, glyphs.ts,
windowed list, scroll/scrollbar). It is NOT on npm; packages are
private. opencode's tui/session-ui are also private and coupled to
their server model — rejected.

User direction: try git-module + bundling on our side FIRST, see
what it actually gives us, then decide how much to adopt vs
re-implement into our own layer.

## Task (spike, not migration)

A clone sits at /tmp/acp-tui (bun install already run). In THIS
worktree:

1. Vendor it: `git submodule add` or vendor-copy under
   `plugins/herdr/tui/vendor/acp-tui/` (pick whichever survives our
   bun toolchain; submodule preferred for upstream tracking).
   Wire package resolution so `import ... from "acp-model"` works
   from our tui code (bun workspace alias or tsconfig paths — your
   choice, document it).
2. Feed REAL data: take
   `/home/pepl/projects/bro/.git/bro/agents/native-af580313.events.jsonl`
   (a live loop archive, ~23MB), wrap each `session/update` row into
   the shape their `reduce()` expects (check their types/fixtures),
   drive a `createSession()`, and print a summary: item kinds/counts,
   whether tool outputs/diffs/permissions survive. Compare against
   what our `model.ts` produces for the same tail.
3. Component probe: can our `app.tsx` import their
   `conversation/card.ts` / `view-model.ts` standalone, or do they
   drag their session-store/config/keys? List which modules are
   self-contained.
4. Write findings to `specs/bro-q2edc.md` (a "vendored spike"
   section): what works, what is coupled, adoption table
   (take / adapt / skip per module), and your recommendation.
   Commit + push `work/bro-l8wqu`. No PR.

## Keep

- No changes to the running app needed yet — this is an evaluation
  spike; `main.ts`/`app.tsx` stay working as-is.
- Do not spawn sub-agents.

---

## Phase 2 — migrate onto the vendored stack (per spike recommendation)

Spike landed: `68947130` + `specs/bro-q2edc.md` "Vendored spike" section is
authoritative — read it first, plus `plugins/herdr/tui/spike-feed.ts` (the
working adapter) and `vendor/acp-tui` sources.

GOAL: the session pane renders through acp-model + vendored view machinery,
fold-by-default — the answer to "too verbose".

DO (take):
- `acp-model` as THE session model: session-feed rows -> their `reduce()`
  via the spike adapter shape (session_opening(load) -> session_update per
  row -> prompt_response per turn stop -> session_opened for live tail).
  Our `model.ts`/`state.ts` reduce-layer retires or becomes the thin adapter.
- `view-model.ts` — collapse/snippet/cursor machine. DEFAULT = collapsed
  (their baseline). Wire keys to expand/collapse, snippet-vs-full output.

DO (adapt):
- `card.ts`, `content.ts`, `format.ts`, `command-result.ts`, `glyphs.ts`
  — pure row-layout engine behind a small theme-shim onto our theme tokens.
- Markdown: Option B per spike — their layout decisions, OUR markdown/
  code renderables (skip their marked+grammar stack if cost is real; note
  the call you took in the spec).

DON'T take: items.tsx, WindowedConversation, their session-store/config/
keys, scrollbar/window/* (our scrollbox + session-feed stay).

KEEP (our shell, unchanged seams): `main.ts` bootstrap + preload order,
archive tail feed, scrollbox container, Herdr LED/report-agent, pane
bootstrap, `--dump` headless mode.

WATCH: @opentui skew 0.6.6->0.8.0 on every renderable-touching file;
`file:` dep copies — `bun install` again after touching vendored tree.

GATES (all green): `bunx tsc -p plugins/herdr/tui/tsconfig.json`,
root `npm run typecheck`, `npm test` touched scope, `npm run check:plugins`,
`npm run build`. Plus a headless `--dump` sanity render on
/home/pepl/projects/bro/.git/bro/agents/native-af580313.events.jsonl
and the PTY smoke you already have.

Update `specs/bro-q2edc.md`: extend with "phase 2" notes — what was taken,
adaptation shims, what was deliberately skipped, before/after.

Commit + push `work/bro-l8wqu`. NO PR.

## Phase 2 AMENDMENT — alternative impl, NOT refactor (overrides above)

This is a PARALLEL implementation, not a rewrite:

- NOTHING gets deleted: model.ts/state.ts/app.tsx keep working as the
  current default.
- Design a component seam instead: a small registry/interface where the
  renderer pipeline (feed->model->items->view) selects its IMPLEMENTATION
  per component — e.g. `--impl legacy|acp` flag / config key / env, with
  per-piece granularity where sane (model impl X + card impl Y).
- New code lands in its own files/dir (e.g. tui/acp/) implementing the
  same seam; app bootstrap picks impl at startup, default stays legacy
  until proven.
- Both impls must pass the same gates + a shared conformance probe:
  same archive -> both impls -> item counts/coverage compared in a test
  or script (spike-feed.ts already has the harness).
- The spec update documents the seam shape (the interface contract) so
  a THIRD impl can plug in later without touching the shell.

## Phase 3 — visual parity pass: opencode-grade look

User verdict on Phase 2 acp impl: "не близко к опенкод" — boxes are
noise, rows must be compact. Goal: the pane reads like a real coding
agent transcript (opencode/acp-tui density), not a stack of bordered
boxes.

FIRST, calibrate eyes (before writing code):
- `cd plugins/herdr/tui/vendor/acp-tui && bun run packages/acp-tui/src/cli.ts`
  against their fake-agent — see THEIR intended look live (compact
  rows, glyph prefixes, dim thoughts, colored diffs).
- Read their `src/conversation/`: `card.ts`, `format.ts`, `glyphs.ts`,
  `content.ts`, `diff.ts`, `list.ts` — the row-layout engine the spike
  deferred. This is now THE adaptation target.

TARGET DESIGN (per item kind):
- Tool call = ONE line by default: `⏺ execute · git log --oneline -5`
  (status glyph + kind + arg summary, truncated at width). Enter
  expands inline: output as an indented gutter block (thin `│`, no
  full box border), syntax-colored when detectable.
- Diffs = real colored +/- block (DiffRenderable or their diff.ts
  layout), not raw text.
- Agent text = markdown-rendered (headings/bold/code fences w/
  highlighting), not flat paragraphs.
- Thoughts = single dim-italic row `∴ thinking…` folded by default.
- Pure-JSON content (judge verdicts `{}`) = collapsed `▸ JSON` row,
  not scrollback noise.
- Turn/usage/mode = ONE compact status line or absorbed into the
  header — no `── turn complete ──` repeated separators.
- User/prompt surface = visually distinct (subtle bg or accent
  glyph) from agent text.
- Spacing/grouping per their list.ts: items grouped by role with
  tight rhythm, not per-card boxes.

CONSTRAINTS: seam stays (both impls render through it — apply the new
layout to the shared ops/item surface so legacy benefits too, or keep
it acp-impl-only if the contract forces a fork — say which and why in
the spec). No deletion. Keys/scroll/LED/report-agent unchanged.

GATES: same as Phase 2 + PTY smoke on both impls + `--dump` sanity.
Update spec Phase 3 section. Commit+push work/bro-l8wqu. NO PR.

## Phase 3 ADDENDUM — prompt visibility (user found: "промптов нет ни на вход ни на выход")

Archive fact (verified on native-af580313): session/update stream has
ZERO user-side records — prompts travel via session/prompt RPC and are
never journaled. Nothing is lost in render; the data isn't in the feed.

FIX (both impls, via the shared feed layer so the seam keeps parity):
- Source: sibling `<agentId>.prompt.md` next to the .events.jsonl
  (bro writes it at spawn). Inject it as the FIRST user-message item
  at session_opening — visually distinct surface (accent glyph/bg) so
  "what was asked" is readable at the top.
- If prompt.md is absent (hand-made rows, foreign archives) degrade
  to a `▸ prompt unavailable` marker — never fabricate.
- Agent output side: audit that agent_message chunks AFTER the final
  tool call are not dropped by classification (user reports missing
  output — verify in conform.ts: acp agent-text item count vs
  archive agent_message_chunk count, surface the delta).
- Optional if cheap: per-turn prompt echo — bro loop prompt file per
  runId if resolvable from the row; else single top prompt is fine.

## Phase 3 ADDENDUM 2 — drop the quit key

Remove `q`→quit entirely: herdr owns pane lifecycle (close pane is a
herdr action). The TUI must not grab `q` — remove the binding AND the
`q quit` hint from the footer. Process exits only via herdr pane close.

## Phase 3 ADDENDUM 3 — JOURNAL the prompt (bro-side, supersedes addendum-1's injection-only approach)

User is right: don't just work around the missing prompt — bro must
record it. The chokepoint already exists:

- `packages/providers/src/acp.ts` pumpTurn (~line 688): calls
  `plane.start()` BEFORE `session.prompt(prompt, req())` — and `prompt`
  is right there as an argument (string | ContentBlock[]).
- `packages/providers/src/acp-events.ts` agentTurnPlane.start()
  (~line 326): already records `{kind:'turn', phase:'start'}` into
  `.events.jsonl` + emits on the bus.

CHANGE: `AgentTurnPlane.start(prompt?)` — when prompt is present,
record an extra archive row `{kind:'prompt', text:<flattened>}` right
after the turn-start row (flatten ContentBlock[] to joined text; store
full — renderer folds). Optionally a compact bus event too (kind
'prompt', first ~200 chars — the bus is not the archive). pumpTurn
passes `prompt` through. Fail-open like every record() call.

TUI SIDE: the model renders `kind:'prompt'` archive rows as the
distinct user-message surface (accent glyph). prompt.md injection
downgrades to FALLBACK for old archives that have no prompt rows —
keep it, cheap.

## Phase 3 ADDENDUM 4 — judge turns as structured controls (jev)

Bro CONSTRUCTS the judge prompts (typed questions: noul/score/choice)
— the archived {kind:'prompt'} row already gives the formatted request
for free. The missing half is the RESPONSE side:

- Archive rows carry `by` (provenance label) — judge turns are
  identifiable (judge/jev label; verify the real `by` string on
  native-af580313 — grep its rows, don't guess).
- jev responses are SMALL structured JSON ({"route":{"choice":"a"}},
  score objects, noul maps) — the model classifies agent-text items
  that parse as a known verdict shape (shape-sniff: route/score/
  choice keys, or short single-object JSON under N bytes on a
  judge-labelled turn).
- Render as a structured VERDICT CONTROL — not a JSON blob:
  `⛨ jev · route: a` badge line + fields table expanded on Enter;
  unknown shape → falls back to the ▸ JSON collapsed row.
- Same machinery serves any JSON-speaking caller — shape table is
  data-driven, judge is the first entry, not a special case.

Net effect in the pane: `❯ prompt` (formatted request) → `⛨ jev
route: a` (verdict control) — the whole judge exchange readable as
two lines instead of a JSON wall.

## Phase 3 ADDENDUM 5 — TIMELINE, human-meaning filter, spacing (the frame for all of phase 3)

User reframed it: this is an END-USER feed, not an agent dump —
"I must see when was what; no technical meaningless steps".

TIMELINE: every archive row already carries `ts`. Render a subtle
HH:MM time gutter (or per-turn header `── 12:34 ──` + relative
offsets inside) — one glance tells WHEN each step happened. Group
items by turn (prompt → activity → reply) with a thin divider +
elapsed time, not repeated `turn complete` noise.

HUMAN-MEANING WHITELIST (what earns a row):
prompt · thinking (dim, folded) · agent text (markdown) · tool call
(one-line + expandable body) · diff · verdict control · permission
request · error/warning · turn boundary (thin, with time+tokens)

NOISE FLOOR (absorbed, never a row): usage ticks → header status;
session_info/config_option/current_mode/available_commands → session
state only; empty/{} chunks → drop; unknown kinds → ▸ N hidden row.

SPACING: grouped rhythm — tight inside a group, one blank line
between groups (their list.ts spacing rules are the reference).
Cap: card bodies folded, tool outputs snippet-first.

CAVEAT on test data: native-af580313 is a grep-storm judge loop —
unrepresentative. Calibrate visuals on a RICH archive too:
bro--bro-xiq2m's archive (prose + diffs + real replies) and, better,
run the vendored fake-agent for the full item spectrum before
declaring the look done.

## Phase 3 ADDENDUM 6 — drop the git dependency; own control kit

User decision: no git dependency on acp-tui. Revised form:

1. REMOVE the submodule plugins/herdr/tui/vendor/acp-tui
   (git submodule deinit + rm + .gitmodules cleanup).
2. VENDOR only `packages/acp-model` source into
   `plugins/herdr/tui/vendor/acp-model/` — plain source copy with an
   ATTRIBUTION header noting Apache-2.0 + upstream URL + pinned commit
   70b8a6d. It's a copy we own; no submodule, no file: workspace
   indirection — import the source files directly.
3. The acp impl keeps working through the seam — only its import root
   moves from submodule to vendored source.
4. Our OWN control kit grows in tui/ (rows, fold-line, verdict, diff,
   markdown) — their conversation/ layer stays a reference we already
   studied, never an import.

Also seen live on their TUI (pane demo confirmed):
`▸ 2 tool calls · 1 thought · 1 plan · 1 permission · 45.4s` and
`end turn · 45.5s · ctx 38k/200k` — one collapsed activity line per
turn + compact end-turn line. THAT is the baseline density for
phase 3's timeline design.

## Phase 3 ADDENDUM 7 — mouse capture OFF (copy/selection must work)

User: can't copy — Ctrl+C kills the process, right-drag does nothing,
herdr selection also dead. Cause: OpenTUI enables mouse reporting by
default; our pane uses NO mouse features.

FIX: disable mouse capture in the TUI (renderer option /
renderer.disableMouse() / createRenderer({useMouse:false}) — find the
real knob in @opentui/core 0.8.x). Effect: native terminal selection +
herdr's own selection both work again; Shift+drag stops being the only
escape. If a future feature needs mouse (click-to-expand), put it
behind a flag — off by default.

## Phase 3 ADDENDUM 8 — Ctrl+C copies to clipboard (OSC 52), never exits

User wants standard copy-paste. In raw mode 0x03 arrives at the app —
we decide. Implement:

- Ctrl+C → copy the CURRENT item's full text (the selected/focused row,
  expanded or folded — its raw content) to the system clipboard via
  OSC 52 (`\e]52;c;<base64>\e\\` — works in xterm.js/wezterm/kitty/
  ghostty/tmux-passthrough). If a native selection exists the terminal
  handles it first; our path is for "copy this row/card".
- Confirmation: brief footer toast "copied" (non-modal, fades).
- If an input field is focused and has selected text → copy that text.
- SIGINT exit is gone by design (herdr owns pane lifecycle). If a
  hard-quit is still wanted for standalone runs, keep it behind
  Ctrl+C twice within ~800ms or a different chord — decide and note.
- Gate: tsc + bun tests + PTY smoke showing OSC52 sequence emitted.

## Phase 3 ADDENDUM 9 — wheel scroll WITHOUT mouse capture

Regression: disabling mouse capture killed the wheel — wheel events
were delivered to the app as mouse reports; now the terminal eats
them and alt-screen has no host scrollback. User needs BOTH: plain
drag selection (works now) AND wheel scroll.

Do NOT re-enable button tracking (1000/1002/1003 all consume button
presses → selection dies again). Options in priority order:

1. Alternate scroll — emit `CSI ? 1007 h` on start (`\e[?1007h`, reset
   on exit). Terminals that support it translate wheel into arrow-key
   input when the app is NOT mouse-capturing; our arrows already
   scroll. Verify in a REAL herdr pane (xterm.js): restart the w3R
   instance or use a throwaway session, then check wheel produces
   arrow keys reaching the app. If herdr's terminal ignores 1007,
   check herdr's own wheel handling — does it scroll pane scrollback,
   or forward wheel some other way?
2. If herdr forwards wheel bytes/keys some other way — bind that
   instead.
3. Document fallback in the footer (PgUp/PgDn/j/k work now), but
   wheel is expected UX — try hard for (1) or (2).

Gate: same gates + verify in the live pane that BOTH wheel scrolls
and plain drag selects at once.

## Phase 3 ADDENDUM 10 — wheel: render INLINE, drop alt-screen

Root cause found (herdr 0.9.5 binary strings): herdr OWNS the mouse.
`mouse_capture = true` default; wheel is consumed by herdr's own
scrollback logic (`mouse_scroll_lines`, copy_mode, pane scrollbars).
DECSET 1007 is irrelevant — herdr enables alternate-scroll on its own
HOST terminal for its own UI; it never proxies wheel into a
non-capturing pane. In alternate-screen there IS no pane scrollback,
so wheel is dead — confirmed: keyboard scroll works (ctrl+b paged up,
scroll region has all rows), only wheel does nothing.

Fix: `useAlternateScreen: false` — render the feed inline. Then rows
flow into herdr's native scrollback: wheel scrolls (mouse_scroll_lines),
drag-select copies, copy-mode/search all work — for free. This pane is
a read-mostly timeline viewer; herdr is the right owner for scroll.

Details:
- Keep ?1007h emission — harmless under herdr, still helps in plain
  terminals where the app IS the alt-screen owner... wait: with
  useAlternateScreen:false there is no alt-screen at all, so 1007 no
  longer applies — remove it or leave gated; your call, note why.
- Verify in the LIVE w3R pane: wheel reveals earlier feed rows via
  herdr scrollback AND drag-select still copies. Live-tail must keep
  appending without breaking scroll position.
- If inline mode wrecks the pinned footer/selection model, report
  what breaks — but try hard; herdr's scrollback is the UX we want.
- If herdr scrollback still shows nothing (e.g. it only scrolls the
  normal buffer which inline output doesn't populate the way it
  expects), fall back: document `mouse_capture` interplay and surface
  a clear "use copy-mode / PgUp" hint in the footer.

## Phase 3 ADDENDUM 11 — session header, generic model-call surface, drop "end turn"

User wants:

1. SESSION HEADER (top of feed, first thing rendered): agent id/name,
   provider, MODEL, cwd where launched, launch date+time. Sources:
   archive rows carry `by`/model fields (usage/session-init metadata
   already lands in session-state — use it); cwd = workspace arg we
   already take; launch ts = first row ts or a {kind:'prompt'}/start
   marker. Render as a compact one/two-line header block, dim but
   readable — it's the "what am I looking at" answer.

2. GENERIC MODEL-CALL SURFACE — not jev-specific: every model call
   (agent turn OR judge/hook OR any provider call) shows WHO called
   (provider/model from turn metadata — the `by` label or session
   state, NEVER the literal 'jev' branding), WHAT the input was (the
   {kind:'prompt'} journal — formatted prompt surface, already built),
   and the outcome (verdict control where shape-sniffed, else normal
   output). User's words: "it's not clear when this model is called,
   hook or what the agent is doing — be fully generic, put
   provider/model". So label each turn block with its provider/model
   and origin (agent/hook/judge — from `by`/kind where available).

3. REMOVE standalone `end turn` rows — user: "not sure end turn
   brings useful information". Fold anything worth keeping (duration,
   ctx) into the ▸ activity summary line or turn header; drop the
   separate row entirely.

## Phase 3 ADDENDUM 12 — role-distinct message surfaces (devin/opencode style)

User: can't tell which message belongs to the caller vs the LLM.
Like devin/opencode:

- CALLER surfaces (our {kind:'prompt'} journals, any future user
  input) render as BLOCKS WITH A DISTINCT BACKGROUND (subtle bg
  fill — theme-aware, not a heavy border). Full-width up to the
  screen edge, padded, clearly "us → model".
- LLM/agent text stays markdown prose (its own quiet treatment —
  optionally a left gutter marker), visually different from caller
  blocks at a glance.
- BOTH must RESPECT SCREEN WIDTH: wrap multi-line properly at the
  actual pane width, never clip or overflow horizontally. Watch
  ANSI-width math with the bg fill — pad wrapped lines to the same
  bg run so the block reads as one surface.
- Applies to BOTH impls where the surface exists; acp impl primary.
  Folded/unexpanded state unaffected.

Gate: tsc + bun + PTY smoke at narrow width (~60 cols) proving
wrap + bg integrity, then verify live in w3R.

## Phase 3 ADDENDUM 13 — match REAL opencode chrome (ANSI capture)

I dumped a live opencode pane — /tmp/opencode-view.ansi (real SGR,
inspect it: `cat -v` or a small parser). Target look = theirs, as
close as possible. Concretes from the capture:

PALETTE (truecolor):
- content bg #0a0a0a; elevated surface bg #141414 (blocks, sidebar)
- prose #eeeeee · dim/meta #808080
- cyan #56b6c2 — ⏺ row markers, links (cyan + UNDERLINE e.g. #829)
- amber #97682c — `+ Thought · 37.3s` collapsed-thought rows
- orange #f5a742 (bold) — errors/warnings (`Ошибка`, `1/3`)
- green #7fd88f — ok status bits · blue #5c9cf5 — subagent names
- peach #fab283 — interactive blocks' left bar (Questions card)

SHAPES:
- Interactive/caller blocks: bg #141414 + `┃` left bar (2 cols, peach
  for questions; pick role-appropriate accent for prompts), indented
  content, numbered options, key hints INSIDE the block bottom
  (`↑↓ select  enter submit  esc dismiss`).
- Rows: `⏺ <name> · <dim subtitle>`; subagent `⠋ <Name> Subagent —
  desc`; tool title regular weight, subtitle dim — no boxes.
- `+ Thought · Ns` collapsed thought = one dim amber row.
- `Jump to latest ↓` chip appears when scrolled off bottom (gray).
- Links cyan+underline. Blank line between groups.

MAP IT TO OURS: prompt/user surfaces → Questions-style block (their
bg+bar grammar), our accent maybe cyan/green instead of peach.
Verdict controls → same block grammar, accent by severity. Agent
prose → #eeeeee on #0a0a0a, markdown styled. Time gutter stays —
ours is finer than theirs; keep dim #808080.

Their right context-sidebar (tokens/used/$) — skip for now; our
header line (addendum 11) covers identity. Note the split.

## Phase 3 ADDENDUM 14 — perf sanity on real volume

User likes the collapsible tool chains (we already have ▸ run-collapse)
but asks whether it holds on large archives. Measure, then fix what
the numbers say:

- BENCH: time + peak RSS for full replay of the real archive
  (~25.5k rows) through acp-model → drain → renderable build. Report
  numbers in the spec next to the spike table. Also measure the
  live-tail append cost per row (steady state).
- If renderable-per-item is the hot spot on big feeds, add WINDOWING:
  materialize only visible rows (+ overscan), like their
  WindowedConversation — but ours, through the seam (a view-layer
  concern, not the model).
- Immutable reducer 43x bulk cost is a known spike finding — if the
  bench shows it dominating initial open, consider chunked/incremental
  reduce or a mutable fast-path for replay origin. Don't redesign;
  measure first, fix only if the number is actually bad.
- Acceptance numbers to report: open-to-first-paint, replay wall time,
  RSS, scroll/expand latency feel in the live pane.

## Phase 3 ADDENDUM 15 — clean start in inline mode

Bug (user-visible): in inline mode the app draws BELOW existing
scrollback — the launch command line and previous pane output stay
visible above the feed; looks like a stale-screen bug.

Fix: before the first frame (after renderer init, before first
drain), clear the screen AND scrollback — `\e[2J\e[3J\e[H` — so the
feed starts at the top of a clean pane. That's the intended UX for a
session view; the pane's prior scrollback is not content we own.
Keep it startup-only — never clear mid-run.

Gate: tsc + bun + live verify: pane shows feed starting at top, no
leftover command line above it.

## Phase 3 ADDENDUM 16 — PIN the session header at screen top

Bug (user-visible): ` bro: session — <worktree> · session` is the
first feed row — it scrolls away during replay. It must be CHROME:
a pinned top bar, like the footer at the bottom, always visible.

You found screenMode:'split-footer' + footerHeight — check the same
renderer options for a header/top variant (split mode, headerHeight,
topRows — grep the native chunk like you did for split-footer). If
the kit supports top-pinned rows, move the header there: the
addendum-11 identity block (agent, provider/model, cwd, launch
date+time) renders in the pinned top region, feed scrolls beneath
it, footer stays pinned at bottom.

If no top-split exists: alternative — keep footer pinned and put the
identity line INTO the pinned region (footer two rows: header line +
keys line), or reserve row 0 via a fixed overlay. Pick the least
hacky; note the choice.

Gate: tsc + bun + live check — w3T shows ` bro: session` at row 0
ALWAYS (scrolled or not), feed flows under it.

## Phase 3 ADDENDUM 17 — plugin OWNS the view lifecycle (user directive)

User ruling: loading a session view for a live agent is the PLUGIN's
job, not orchestrator improvisation. Today I hand-wrote
`.git/bro/fleet-status/bro--bro-mktj6.<hash>.json` and manually
spawned a workspace+pane — that's scaffolding, now supersede it:

1. The herdr plugin (projector/reconcile — the same machinery that
   already creates session workspaces) must, for ANY live bro agent
   (loop runs, fleet agents, convoy workers — anything with a
   `<id>.events.jsonl` archive), write the fleet-status entry AND
   create/refresh a labeled view workspace+pane running the TUI.
   Discover agents from `bro fleet agents status` / the loop registry
   / archives dir — pick the source bro already owns.
2. main.ts should also accept the archive/agent directly
   (`<events.jsonl>` or agent id) — resolution is plugin logic, the
   state file is just the cache. Keep back-compat with worktree arg.
3. Herdr honors neither \e[3J nor offers `pane clear` CLI — so the
   clean start is a LIFECYCLE fix: a fresh pane has no scrollback.
   When (re)launching a view, prefer creating/replacing the pane over
   reusing a stale one; if a reset API exists in the herdr endpoint
   surface (check the API, not just CLI), use it.
4. My hand-written file for mktj6 stays working meanwhile — but the
   plugin path must produce the same result end-to-end: `bro` spawns
   agent → view appears in herdr → wheel/select/copy all native.

Keep the seam intact; this is plugin-side orchestration, the TUI
stays a dumb viewer.

## Phase 3 ADDENDUM 18 — real markdown preview via <markdown>

User asks for actual markdown formatting in message blocks —
opencode does it, and so can we: @opentui/core ships
MarkdownRenderable (solid: <markdown content syntaxStyle
treeSitterClient conceal renderNode>) plus CodeRenderable with
tree-sitter highlighting.

- Route ALL prose surfaces through <markdown>: caller prompt blocks
  (the ┃ blocks already render md-looking text like [**link**](url)
  RAW — links must become cyan-underlined links, bold bold, lists
  proper), agent prose, thinking content.
- Code blocks inside prose → highlighted via treeSitterClient when
  feasible, else CodeRenderable/plain with bg.
- Mind wrap + bg: markdown content inside our ┃ block must respect
  pane width and the block bg padding (same addendum-12 rule).
- Check bundle/runtime cost of treeSitterClient — if heavy, gate it;
  concealing (hide md markers) should stay ON.
