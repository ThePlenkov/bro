# bro-izpyk.11 — `bro sessions` claims + resume columns (the deferred epic fields)

Governing spec: `specs/sessions/bro-izpyk.md` (branch
`devin/1792972271-fleet-spec`), "Sessions and resume":

> `bro sessions [--project|--all] [--host h] [--live] [--json]` lists rows
> from the ledger: host, id, project/branch, mode, state, last activity,
> **claims and the resume command**.

F1b (`specs/bro-izpyk.1.2.md`, PR #1009) deferred the claims column — "the
`claims` table is empty until bro-izpyk.3" — and F3 landed it (PR #1032)
without the listing being revisited. F4 (`specs/bro-izpyk.4.md`, PR #1034)
landed `bro sessions resume` and the `SessionPlane.resumeArgv` member, but
the listing still carries neither held resources nor resumability. This
bead closes that gap: it is a **read-surface join**, no write path, no
facade-contract change.

## What already exists (audit-verified on main)

- `ClaimFacade.list(q?: ClaimQuery)` (`core/claims.ts`) returns live
  `ClaimRow`s — `resource`, `host`, `sid`, `project`, `exclusive`,
  `leaseUntil`, `claimedAt`, `pid`, `detail`. The first provider
  (`claims-store.ts`) keeps non-`task:*` URIs in the ledger's `claims`
  table, sweeps dead leases on read, and is bound on the built-in
  ledger connector (`facade('claims')` resolves everywhere
  `facade('ledger')` does). `task:*` never enters the claims table —
  the bd claim stays the source of truth and `list` does not enumerate
  it (specs/bro-izpyk.3.md §3).
- `sessionResumeArgv(host, sid, cwd)` (`cli/session-planes/resume.ts`)
  answers the plane's resume argv or `null` — the exact lookup `bro
  sessions resume` and `bro fleet resume` already render, so all three
  surfaces can never disagree about which hosts resume.
- `bro sessions` renders `SessionViewRow`s collected by
  `collectSessionViews` — derived state, registry-resolved bead, mode
  overlay — into the padded table and the `{sessions, warnings}` --json
  payload.

## Design

### 1. Claims join — one `list`, grouped by session key

`collectSessionViews` gains `opts.claims?: ClaimFacade`. When present it
issues **one** `claims.list({})` per collect pass — machine-wide, then
grouped in memory by `host\0sid` onto each stored row. Deliberately not
`list({session})` per row (N store round-trips, and the claims table is
small) and deliberately not `list({project})` under `--project`: a
session's claim may carry a project tag the row filter would drop while
the hold itself is real — the session-key join is the honest binding;
`--project` already filtered the sessions.

A failed `claims.list` (store unreadable, connector fault) degrades like
the drain failure: a `claims unavailable — …` warning rides
`views.warnings`, every row's `claims` stays absent, and the listing
itself still answers. An absent `opts.claims` skips the join silently —
the test seam for claim-free collects.

### 2. Row shape

`SessionViewRow` gains:

- `claims?: string[]` — this session's held resource URIs, sorted for
  deterministic rendering. Absent/empty → the cell renders `—`.
- `resumeArgv?: string[] | null` — `safeResumeArgv`-style: the plane's
  answer, `null` when the host has no resume command bro knows, and
  `null` when a plane *throws* (a broken plane reports the same as no
  plane — the fail-safe `bro fleet resume` already applies). `cwd` for
  the argv call is the session's own ledger cwd (`''` when none — the
  planes that consume cwd treat it as a scope hint, not a gate).

### 3. Rendering

- Table gains **CLAIMS** and **RESUME** columns after BEAD:

  - `CLAIMS` — sorted URIs joined ", ". `worktree:` values are
    `~`-collapsed through the same `displayWorktree` the WORKTREE
    column uses (display-only; --json carries the full URI).
    `role:*`/`branch:*`/`pr:*`/`path:*` render verbatim.
  - `RESUME` — `yes` when the host answers a resume argv, `—` when it
    does not. The full command stays out of the cell (a uuid sid makes
    it ~60 chars of noise); the actionable spelling is uniform —
    `bro sessions resume <host>:<sid>` — and --json now carries the
    resolved argv itself. This is the bead's "mark resumeArgv
    availability" exactly.

- `--json` rows gain `claims` (`string[]`, always present — `[]` when
  none held) and `resumeArgv` (`string[] | null`), matching the field
  name `bro fleet resume --json` already emits for the same datum.

### 4. Wiring

`runSessionsCommand` resolves the claims facade next to the ledger one —
`facade('claims', {dir}, {prefer})` with the same `connectors` pin — and
passes it into `collectSessionViews`. `SessionsDeps.claims` is the test
injection point, mirroring `deps.ledger`. A `facade('claims')` resolution
failure is caught and reported as a warning, never a failed listing.

USAGE/help and the `sessions` plugin contract text name the two new
columns; `schemas/cli/sessions.schema.json` gains `claims` +
`resumeArgv`; `contract/cli.json` and
`site/content/docs/reference/sessions.md` regenerate through the
existing `gen:` scripts.

## Files

- `packages/cli/src/commands/sessions.ts` — view-row fields, claims
  join, safe resume lookup, CLAIMS/RESUME columns, --json fields,
  `deps.claims` seam, USAGE.
- `packages/cli/src/plugins.ts` — sessions summary/flag prose.
- `packages/cli/schemas/cli/sessions.schema.json` — `claims`,
  `resumeArgv` properties.
- `contract/cli.json`, `site/content/docs/reference/sessions.md` —
  regenerated artifacts (`gen:contract`, `gen:command-docs`).
- `packages/cli/src/commands/sessions.test.ts` — the tests below.

## Tests (hermetic)

- Claims join: seeded `claims.list` rows land on the matching session —
  a claim for `host+sid` renders in CLAIMS and `claims` in --json; a
  claim held by another session never bleeds across; `worktree:` URIs
  `~`-collapse in the cell only.
- Claims failure: `list` throwing yields the `claims unavailable`
  warning and rows still render (claims absent).
- No claims facade: `collectSessionViews` without `opts.claims` renders
  `—`, no warning.
- Resume marker: `claude`/`codex` rows render `yes` + --json argv;
  a no-plane host (`'ghost'`/`'unknown'`) renders `—` + `null`.

## Non-goals

- `task:*` enumeration into the column — the bd claim is the source of
  truth by design (specs/bro-izpyk.3.md); a per-project tasks-store scan
  to attribute assignees back to sessions is a different bead.
- The resume *action* — `bro sessions resume` already owns it; the
  column marks availability, never spawns.
- `bro fleet resume` output — already renders interrupted rows with
  their argv; unchanged.
- Doctor/occupancy consumers of claims — separate beads.
