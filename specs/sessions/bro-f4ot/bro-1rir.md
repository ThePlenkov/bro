# bro-1rir — fleet webui: site route consuming bro serve

Parent: `bro-f4ot` (agents facade + bro fleet). `bro fleet --live`
(bro-n54z) is the human at the terminal; `bro watch` (bro-vf1j) is the
machine heartbeat; `bro serve` (bro-dr1s) already hosts every read plane
those views are built from. The webui is the same fleet view in a
browser — a site route on the serve host, no new data plane.

## Problem

A supervisor away from the terminal has no fleet view: `--live` needs a
TTY, `bro watch --json` needs a reader. The serve host already answers
`/api/v1/snapshot` with mols × gates × fleet — what's missing is a page
that renders it.

## Design

`bro serve` gains one site route:

```text
GET /fleet    text/html — the fleet dashboard
```

A single self-contained page (inline CSS + JS, no build step, no deps —
the CLI ships bundled `dist/` only, so the document is a TS module
string, not a static asset). The page polls `GET /api/v1/snapshot` and
renders the same planes `bro watch` prints:

- **attention** — the heartbeat's answer first; empty renders `quiet`.
- **fleet** — the `bro fleet` columns (mol, step, state, agent,
  worktree, pr). PR links are real `<a>` — the webui's one upgrade over
  the TTY.
- **gates** — per-PR act exit-gate state; `unavailable` when the review
  host can't resolve, never a phantom "no PRs".
- **mols** — every open molecule's `nextStep` state.

Same honesty rules as `--live` and `watch`: a degraded backend renders
`unknown`, never `lost`; a throwing plane renders `unavailable`, never a
false empty fleet. Fleet `degraded`/`conflicts`/`prErrors` notes render
as a warnings block.

- **Poll discipline** — chained `setTimeout` at 2s (a slow collect
  stretches the cadence, never stacks), `tick()` returns early while
  `document.hidden` or a fetch is in flight, `visibilitychange` re-arms
  and repaints immediately on return. A failed fetch dims the frame and
  reports the error — it never blanks the last good snapshot.
- **Read-only** — the page issues GETs only. The respawn decision stays
  a surface, not a button; spawn/stop stay API ops for real clients.
- **Injection-safe** — bead titles are user input: every value lands via
  `textContent`, never `innerHTML`. The response carries a CSP —
  `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…';
  connect-src 'self'` — hashes computed at module load from the exact
  `<script>`/`<style>` bytes served, so a smuggled title can't execute
  or load anything even if markup injection ever slips through.
- **Trust boundary unchanged** — the page rides the same loopback Host
  check as every route; DNS rebinding is refused before routing.

`ServeResponse` gains `contentType` (+ `headers`) so a non-JSON route
sends its body verbatim — the JSON envelope stays the default.

## Plan

- [x] `packages/cli/src/commands/webui.ts` — `FLEET_PAGE` document;
      client JS polls `/api/v1/snapshot`, renders the four sections via
      DOM `textContent`
- [x] `serve.ts` — `GET /fleet` in ROUTES + router; `ServeResponse`
      `contentType`/`headers`; `send` honors them; module doc route list
- [x] `serve.test.ts` — `/fleet` status+content-type+CSP on the wire,
      405 on non-GET, JSON routes unaffected
- [x] `skills/serve/SKILL.md` route table row; regen `skills-data.ts`
- [x] `npm test` (exact CI command)
