# bro-9rls.4 — the thin client: `/ui`

Milestone 4 of `specs/bro-9rls.1.md`. `/fleet` hand-lays its panels per
plane; `/ui` generates them from `GET /api/v1/planes` — the index IS the
layout contract, so the page can never disagree with the catalog about
what exists, what reads, or what is degraded.

## Shape

One self-contained page (`packages/cli/src/commands/ui-page.ts`), same
discipline as `FLEET_PAGE`: bundled module string, inline CSS/JS,
hash-pinned CSP (`connect-src 'self'` covers `EventSource`),
`textContent` only — nothing from the wire reaches `innerHTML`.

- `GET /ui` → 200 `text/html`, CSP header; non-GET → 405. Rides the
  `PAGES` table in `serve.ts` next to `/fleet`.
- One `<section>` per catalog entry: name, declared reads as GET links
  (`/api/v1/planes/<p>/<read>` — they open the JSON read), verbs as
  muted badges, live capabilities as ok/no badges.
- Readable planes render their `list()` rows as a generic table —
  columns are the union of row keys, `id` first, id links to
  `get(ref)`. Objects stringify truncated at 80 chars.
- `capabilities().read !== true` → the whole section dims and shows
  `unavailable` (with the `error` marker when the probe threw) — the
  page never fakes an empty list for a plane that can't read.
- A failed list fetch dims that plane to `unavailable — fetch failed`
  while the rest keep rendering; a failed index keeps last-good panels
  and flags the header `stale`.

## Transport

MVP poll: chained `setTimeout` at 2s — never overlapping (`inFlight`
latch), paused while `document.hidden`, re-armed on `visibilitychange`,
last-good frame survives a failed tick.

SSE upgrade is client-side: when the events plane's live capabilities
report `stream === true`, the page opens
`/api/v1/events/stream` (lands with bro-9rls.5 — absent endpoint errors
harmlessly and the poll cadence covers the gap). Any message re-arms an
early tick; stream death just falls back to polling — the header shows
`· live` while the stream is open.

## Read-only v1

Verbs render as badges, never buttons — writes need the serve.json
Bearer token, which a page cannot hold. `POST /ui` is 405; the CSP pins
`connect-src 'self'` so even a compromised page can't exfiltrate.

## Tests

`packages/cli/src/commands/serve.test.ts` — `GET /ui` 200 + HTML + CSP,
page references `/api/v1/planes`, no form/POST surface, non-GET 405.
The generic renderer is exercised by the REST router tests in
`planes/rest.test.ts` — the page only consumes that contract.
