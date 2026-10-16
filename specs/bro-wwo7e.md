# bro-wwo7e — webui: per-agent live log pane via `/log?follow`

Epic `bro-j1kk2` (next-major release) work item. Consumer of
`specs/bro-j1kk2.3.md` — the SSE endpoint
`GET /api/v1/agents/<ref>/log?follow` — on the `/fleet` dashboard
(spec `bro-w4a45`). Depends on `bro-dojl5` (merged): worker logs now
coalesce message deltas into lines, so a line-pane shows prose, not
word-per-line noise.

## Problem

`/fleet` polls the read planes every `POLL_MS = 2000` and the agents
table's only log surface is the file path in the worktree cell's
tooltip. Watching a worker through the webui is snapshot-batch —
"running … exited" — while the wire already streams the log live. The
SSE follow endpoint exists and handles replay+follow, truncation/respawn
notes, and token gating; the page just never opens it.

## Shape

One affordance per row: a `log` column on the agents table carries a
`tail` link — only for rows whose ref the endpoint can resolve (the
`/api/v1/agents` board's registry agents; `<ref>` = agentId) AND whose
`log` is a local path. Loop-run and discovered rows aren't registry
refs (`404`); remote `scheme://` log pointers (`422`) render `remote`,
no-log rows `—` — same honesty rules as `logTarget`.

Clicking `tail` opens a pane below the agents table — outside the
`tbody`, so the 2s `replaceChildren` re-render never wipes it. The
pane is a scrollable `<pre>` fed by one `EventSource` on
`/api/v1/agents/<ref>/log?follow&lines=200&token=<t>`:

- `message` frames append as lines (a multi-`data:` frame is a chunk
  fanned out per line — each event's data + `\n` reconstructs the
  endpoint's intended line stream; a mid-line chunk boundary renders
  as a line boundary, the same approximation the endpoint itself
  makes when it trims the trailing `\n`).
- `event: note` frames (`[log truncated — resyncing]`, removed /
  reopened) append as muted lines.
- Auto-scroll pins to the bottom only while already near it — reading
  backscroll isn't yanked away on each append.
- The pane is character-capped (~300k chars, trims to ~150k) — a
  long-running tail can't grow the DOM unboundedly.
- Clicking `tail` again, `close`, `pagehide`, or a fatal stream error
  closes the source and collapses/ends the pane. `EventSource`'s own
  retry is kept: a reconnect re-fires `onopen`, where the pane wipes
  and lets the server replay refill it — no duplicated tail. A
  `readyState === CLOSED` error (auth refusal, gone log) ends it with
  a note; a `done` event closes cleanly if the endpoint ever sends
  one.

## Credential

The log route is write-grade gated (spec `bro-j1kk2.3`: Bearer or the
`?token=` EventSource fallback) and `/fleet` itself is a
Host-guard-only static document — **the page cannot ship the token**
(serving it inside the HTML would hand the session credential to any
local user who can hit loopback). The token therefore arrives
out-of-band, per tab:

- `#token=<t>` in the page URL — a same-UID handoff (a tokenized link
  a CLI prints, or the user building it from `serve.json`). The script
  strips it into `sessionStorage` and `history.replaceState`s the
  fragment away, so it never persists in history.
- A paste field inside the pane — "session token — the `token` field
  in `<git-common>/bro/serve.json`". Stored to `sessionStorage`
  (per-tab, cleared on close), reused across tails.

A fatal close before any data re-shows the field (the likely cause is
a refused token); a `token` link in the pane header re-opens it for
re-entry. Read-only is unchanged: the pane is still GETs only — the
token only unlocks the guarded read.

## Non-goals

- No server changes — the endpoint contract is consumed as-is
  (`?follow`, `lines`, `token`, `data:`/`event: note` frames).
- No tail for non-registry rows, no remote-log proxying.
- No framework, no build step — the page stays one template literal
  (no backticks/`${}` in client JS), hash-pinned CSP recomputes.
- No token mint/echo route — the credential never travels through a
  server response.

## Verify

- `serve.test.ts` `/fleet` route test: the document wires the live log
  — `EventSource`, the `/api/v1/agents/<ref>/log?follow` shape, the
  pane/token markup, `sessionStorage`, `replaceState` fragment strip.
- `npm run typecheck` clean; `npm test` on `packages/cli`.
- Manual smoke: `bro serve` + curl
  `/api/v1/agents/<ref>/log?follow&token=` streams replay then
  appends; the page tails a registry agent's log in a browser.
