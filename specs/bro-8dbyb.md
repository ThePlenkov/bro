# bro-8dbyb — herdr plugin v2: LiveSource bus subscriber → workspace status tokens + one renderer pane + dead-workspace reaper

## Problem

v1 reconciles on a 30s poll and labels workspaces with the bead title —
the workspace list reads as a row of names with no state in them. Three
gaps, all visible on the live rig:

- **A workspace label carries no status.** A silent-for-16h loop worker
  and a green-gated PR read identically — the operator has to open each
  workspace (or run `bro watch`) to learn which is which. The signal
  exists (`worker.silent`, the act-state cache) but nothing projects it
  onto the herdr surface. `workspace report-metadata` tokens alone are
  NOT the fix — they are display-only metadata the workspace UI does not
  render; the **label is the status surface** (proven: a label prefix
  like `[silent16h·#765 blocked]` is visible in the workspace switcher
  today).
- **Plugin-opened workspaces sit on an empty root terminal.** `worktree
  open` leaves one shell pane; unless the mirror convergence has a live
  native agent to tail, the pane shows a bare prompt — a workspace that
  looks dead while it is not.
- **Dead workspaces never get reaped.** When a worktree's checkout dir
  vanishes (`bro work leave`, loop cleanup), the workspace herdr opened
  for it stays behind forever — w22 (`loop/bro-ymswu`) was exactly that:
  the worktree was removed, the workspace kept showing an empty dead
  root terminal.

Meanwhile the trigger side improved: bro-294hf landed `worker.*` /
`worktree.*` lifecycle events on the local bus (`emitLifecycle` mirrors
journal rows: `worker.spawned` / `worker.exited` / `worker.silent` /
`worktree.added` / `worktree.removed`, plus `notify`-topic dual-writes).
The `LiveSource` seam in `sources.ts` was declared for exactly this —
time to fill it.

## Design

Facade-only rules hold (spec bro-762eh): bro state is never written —
the only mutations are herdr CLI calls and the plugin's own state file;
the only bro invocations stay read verbs (`fleet status`, `act status`).

### LiveSource — event-woken polling (`sources.ts`, `sync.ts`)

- `LiveSource implements EventSource` — `AsyncIterable<Planes>`, same
  shape `converge()` already consumes. v2's `sync.ts` swaps
  `new PollSource(...)` → `new LiveSource(...)` on one line, per the
  seam's contract. `BRO_SYNC_SOURCE=poll` selects PollSource back.
- The feed is **`bro bus subscribe --topic worker --topic worktree
  --topic gate --topic notify --json` spawned as a child** — the CLI is
  the plugin's whole API surface (no socket protocol re-implemented in
  the plugin, no core import). `gate` is subscribed speculatively — no
  gate publisher exists yet; the filter is in place for when one lands.
  `notify` catches the mailbox→bus dual-write (drive alerts, watch
  verdicts).
- Event frames set a `dirty` flag and wake the sleep — the loop is
  PollSource's own (diff-key + FORCE_EVERY heartbeat) with the sleep
  made interruptible: `Promise.race([timeout(everyMs), wake])`. A wake
  coalesces ~300ms before the snapshot so an event burst costs one
  `readPlanes`, not one per frame. A `gap` frame is a wake too (a hole
  means re-derive — same fact, delivered).
- **Broker down is routine, not an error**: the child exits non-zero
  when nothing listens → the source keeps polling exactly like v1 and
  respawns the subscriber on a bounded backoff (floor ~5s, ceiling
  ~5min, reset on a stable connect). Child lifecycle is the source's —
  killed when the iterator returns (pane close stops the loop).

### Status tokens — the label is the surface (`status.ts` new, `reconcile.ts`)

- Per armed tree, a compact prefix renders ahead of the title:
  `[worker·pr] title` — tokens joined `·`, e.g.
  `[silent16h·#765 blocked] loop: rate-lane pacing`. No tokens → the
  v1 label unchanged.
- **Worker token** (first match wins): live loop run with
  `silentMs >= loop.stallMin` → `silent<N>` (bucketed `<1h`: 5m floor,
  `silent45m`; `≥1h`: `silent16h` — bounds rename churn); live loop run
  under stall → `working`; running fleet agent → `working`; dead loop
  run → `dead`; else absent (a marker-armed session workspace with no
  worker shows no worker token).
- **PR token** `#<N> <gate>` — two local joins, no network on the read
  path: (a) the tree's bead (`claim`/loop `beadId`/agent step) →
  `beads.inProgress[].link` carries `pull/N` for drive beads; (b) the
  act-state file plane — `<git-common>/bro/act-state/*.json` entries
  whose `state.headRef` equals the tree's branch give the PR and the
  last fetched `PrActState` (written by watch/drive/`act status`
  pollers; the plugin only reads).
- **Gate token is a summary, not the gate** — mapped from the cached
  `PrActState`: `merged`/`closed` (state ≠ OPEN), `draft`, `conflict`
  (mergeable CONFLICTING), `blocked` (openThreads|ciFailing|sastPending
  > 0), `pending` (ciPending|reviewersPending > 0), `ok`. Absent cache
  → `#<N>` alone; absent PR → no token. It answers "is it moving",
  never "may it merge" — the real verdict stays `bro act status`.
- The same tokens go to **`workspace report-metadata`** — machine
  surface beside the human one (tokens persist server-side but the UI
  renders nothing from them — verified: `workspace get` shows
  `tokens.status`, the switcher shows only the label): the plugin
  reports source `bro.fleet` with tokens `bro.worker`
  (`working|silent<N>|dead`), `bro.pr` (`<N>`) and `bro.gate` (`<…>`),
  clearing each with `--clear-token` when it vacates. Metadata rides
  `--seq` = `Date.now()` so stale drops cannot overwrite newer ones;
  writes dedupe via a `meta` record on the workspace rec so an
  unchanged pass writes nothing.
- Renames stay inside the existing drift rule: only managed workspaces,
  only when the rendered label differs.
- **`pane report-agent` was deliberately unused at the time** — verified:
  agent identity binds to a live pane process; reports on dead panes
  are silently dropped (and the vocabulary is `idle|working|blocked|
  unknown` — no `done`). Spec bro-awqde later superseded this: the
  daemon projector (never a session plugin) reports the fleet
  projection onto busy ledger panes every tick, exactly because the
  authority is process-bound and non-persistent.

### One renderer pane per workspace (`renderers.ts` new)

- A managed workspace always offers something to look at: a live-agent
  **mirror** (existing `mirrors.ts`) counts; otherwise an **event
  tail** — a pane running a resilient subscribe loop
  (`while; bro bus subscribe --topic worker --topic worktree --topic
  notify --topic gate; sleep 5; done` — each retry prints its banner,
  broker-down gaps are visible, not silent).
- Convergence mirrors `mirror-pane.ts` discipline: recorded pane wins;
  an unrecorded pane still carrying our `bro: events` label is adopted
  (never a duplicate); an idle pane is armed in place; else split below
  an existing pane. Records live in plugin state under a new
  `renderers` map (worktree-path keyed — mirrors are step-keyed).
  A live mirror retires the fallback tail in the same pass — one
  renderer, never two.
- Renderers attach only to plugin-managed workspaces — a user's own
  workspace is never given a pane it did not ask for.

### Dead-workspace reaper (`reconcile.ts`)

- Reap rule: herdr's `worktree list --cwd <repo>` (already repo-scoped)
  entry with `open_workspace_id` whose `path` fails `existsSync` on two
  consecutive passes ≥60s apart → `herdr workspace close <id>` and drop
  the `state.workspaces`/`state.renderers` records. The two-sighting
  grace (`goneSince` stamped in plugin state) makes a transient fs
  hiccup unable to close a live workspace — the same defensive-absence
  rule `paneGone` already encodes.
- Unmanaged workspaces reap identically — a workspace whose worktree is
  gone is dead whoever opened it; the plugin's label/ownership rules
  (which exist to protect user naming) do not apply to a workspace
  whose subject no longer exists.

## Non-goals

- No NATS / cross-rig fan-out — the ymswu connector's job; LiveSource
  consumes the local broker only.
- No `gate.*` publishing — the topic is subscribed ahead of time; the
  publish side is its own bead.
- No attach/mirror of live agent TUI sessions — ACP one-client rule
  (spec bro-5vjpg); the agent mirror stays the log tail.
- No `herdr worktree remove` of the stale registration — the workspace
  is the visible corpse; sweeping herdr's worktree bookkeeping is a
  separate call (note: `worktree remove` exists if a follow-up wants it).

## Plan

- [x] `src/sources.ts`: `LiveSource` — bus-tail child + interruptible
  poll loop + respawn backoff; keep `PollSource` (poll fallback /
  `BRO_SYNC_SOURCE=poll`).
- [x] `src/status.ts` (new): worker/PR token computation — loop-run
  silence bucketing, bead-link + act-state `headRef` joins,
  `PrActState` → gate token; pure functions over `Planes`.
- [x] `src/reconcile.ts`: label = `[tokens] title` via the tokens map;
  `workspace report-metadata` tokens beside it; dead-workspace
  reaper with `goneSince` grace.
- [x] `src/renderers.ts` (new): event-tail pane convergence for managed
  workspaces without a live mirror (record/adopt/arm/split, state
  under `renderers`).
- [x] `src/sync.ts`: `new LiveSource(...)` per `BRO_SYNC_SOURCE`.
- [x] `src/lib.ts`: extend `BroStatus` bead rows with `link`, add the
  act-state dir reader + `HerdrWorktree` fields used by the reaper.
- [x] `test/`: token mapping + LiveSource source-swap unit tests (fake
  planes + a stub tail command); `tsx --test` green.
- [x] `npm run typecheck` (any surface that covers plugins/) + manual
  smoke against the live rig.

## Verify

- `tsx --test plugins/herdr/test` green incl. new cases.
- Live: broker up → `worker.silent` event lands → the workspace label
  shows `[silent16h·…]` within one pass; broker down → the loop polls
  like v1 and never logs an error storm.
- A worktree removed under a live workspace → the workspace closes
  within the grace window (two passes), state records dropped.
- A managed workspace with no agent gets a `bro: events` pane tailing
  the bus; killing the pane re-creates it on the next pass.
