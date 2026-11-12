# bro-izpyk.1.2 — fleet F1b: `bro sessions` + `bro fleet hosts` read surfaces over the session ledger

Child of bro-izpyk.1 (epic contract `specs/sessions/bro-izpyk.md` on branch
`devin/1792972271-fleet-spec`; landed write path specs/bro-izpyk.1.1.md via
PR #1006). **Read surfaces only** — the ledger write path (spool v2, ingest,
killed synthesis, stats rollup) is F1a's and untouched here. `bro sessions
resume`, `bro msg`, claims and the doctor rows are sibling beads
(bro-izpyk.4 / .3 / .1.3) and out of scope.

## Problem

F1a landed the machine-wide ledger — every agent session on the machine now
appends spool rows that drain into `ledger.db` (`sessions`, `installs`,
`events`, `hook_stats_daily`). Nothing surfaces it: an operator still cannot
answer "which agent sessions exist, where, in what state" without reading
sqlite by hand. The epic spec's Visibility section names the two reads:

- `bro sessions` — every agent session on the machine: host, id, project,
  mode, state, last activity.
- `bro fleet board` — hosts × installs: adapter version, last event,
  whether hooks fire, p95, timeouts, last error; sessions per project below.

## Naming decision (recorded per the bead)

- **`bro sessions`** — new top-level plugin, `group: 'fleet'` (the agent
  plane). No collision: nothing named `sessions` exists in the registry or
  doc-type nouns. `resume` stays unimplemented — F4 (bro-izpyk.4) adds it as
  a subcommand of this plugin.
- **`bro fleet hosts`** — a `fleet` subcommand, NOT `bro fleet board`.
  `bro fleet` already IS the board (mols × steps × agents × worktrees ×
  PRs over bro-spawned workers); a `board` subcommand would name the same
  word for a different plane and read as a duplicate. `hosts` names this
  view's actual axis — the hosts × installs table — and cannot be mistaken
  for the spawned-agents board. Group dispatch makes `bro fleet sessions`
  an automatic alias spelling of `bro sessions` (sessions is a fleet-group
  member); that is accepted, not designed.

## Design

### 1. `bro sessions` — `packages/cli/src/commands/sessions.ts`

```text
bro sessions [--project|--all] [--host <h>] [--live] [--json]
```

Reads `facade('ledger', { dir }, { prefer })` — the F1a sqlite backend,
which opportunistically drains pending spool rows on every read, so the
listing is always fresh without a worker tick. Machine-wide by default
("every agent session on the machine"); `--project` narrows to the current
checkout's project via `sessionProject(cwd)` — the same identity function
ingest uses, so worktrees fold into one project exactly as recorded.
`--all` is accepted as the explicit spelling of the default (epic spec
compat). `--host <h>` filters one host. `--live` keeps only sessions whose
derived state is `live`.

**Columns** (human table; `--json` emits every field):

| column | source |
| --- | --- |
| host | `SessionRow.host` — the agent product, verbatim from the ledger |
| sid | `SessionRow.sid`, display-truncated; full in `--json` |
| state | stored `SessionRow.state` + read-time derivation (below) |
| mode | `SessionRow.mode` |
| agent | `SessionRow.spawnedBy` — the BRO_AGENT_ID badge, `—` when interactive |
| bead | resolved from the agent registry (below), `—` when unresolvable |
| worktree | `SessionRow.cwd` (`~`-collapsed), `—` when null |
| branch | `SessionRow.branch`, `—` when null |
| started | `SessionRow.started` as relative age |
| seen | `SessionRow.lastSeen` as relative age |

**State derivation.** The store only ever writes `live` (the `ended` latch
exists for writers that set it; `idle`/`interrupted` are read-time
vocabulary per `ledger.ts`). The ledger records no per-session end marker
today, and `sessions.pid` is the ephemeral run.sh pid — useless for
liveness — so the only provable derivation is the epic spec's own rule:
*a session whose last event predates this boot cannot be live.*

```text
deriveSessionState(row, bootTimeMs):
  row.state === 'live' && row.lastSeen < bootTimeMs → 'interrupted'
  otherwise → row.state
```

`bootTimeMs = Date.now() - os.uptime() * 1000` — no /proc parsing, works
everywhere Node runs. A stored `ended`/`idle`/`interrupted` passes through
untouched (future writers keep their verdict). The derivation is pure and
unit-tested; `bootTimeMs` is injectable for fixtures.

**Bead resolution.** The spool/ledger carry no bead id (the write path is
F1a's, frozen here). The one honest binding that exists today: a
bro-spawned session's `spawnedBy` is its `agentId`, and the per-project
`agents.json` registry maps `molStep → { agentId }` where molStep IS the
bead/step id. For each session with `spawnedBy` set, resolve
`cwd → git common dir → agents.json`, reverse-lookup `agentId → molStep`.
Grouped by cwd so each unique working dir pays one registry read; every
failure mode (no git, deleted worktree, corrupt registry, no match) is
`—`, never an error — a missing bead is a missing fact, not a fault.
Interactive sessions (`spawnedBy` null) skip the lookup entirely.

**JSON shape** — `{ sessions: [...], warnings: [...] }`; each row carries
the `SessionRow` fields plus derived `state` and resolved `bead`. Times
stay epoch ms (the ledger's native unit; the human table renders ages).
`warnings` collects non-fatal degradations (e.g. a registry read that
threw) so `--json` consumers see them without parsing stderr.

**Failure policy.** The ledger is the command's only source: an
unavailable store (no `node:sqlite`, unwritable state dir) is
`error: ledger unavailable — <reason>` on stderr, exit 1 — never an empty
table that lies "no sessions". Usage errors exit 2 via the shared
`positionals(strict)`/`CommandError` path; `--help` exits 0.

### 2. `bro fleet hosts` — `packages/cli/src/commands/fleet-hosts.ts`

A `fleet` subcommand dispatched beside `leases`/`walls` in
`dispatchFleetSubcommand` (made async — facade reads are async).
`bro fleet hosts [--json]`.

**Hosts table** — one row per host, the union of `installs()`,
`sessions()` and `stats()` host sets (a host can appear in any one:
installs prove wiring, sessions prove sid-carrying fires, stats prove
paired ends). Per host:

- `adapter` — `adapterVersion` of the most recently seen install row
  (`—` when never recorded)
- `roots` — distinct `pluginRoot` count across install rows
- `seen` — max `lastSeen` across installs + sessions + stats days,
  rendered as relative age
- `status` — recency bucket on that timestamp: `firing` (< 24 h),
  `quiet` (< 7 d), `silent` (≥ 7 d). Constants, documented here; the
  board is a glance surface, not a monitor.
- `sessions` — total ledger sessions for the host, `live` = derived-live
  count in parens
- `events` — summed `n` over retained `hook_stats_daily` rows
- `p95` — worst (max) daily p95 across the host's event rows
- `timeouts`, `errors` — summed over the same rows
- `last error` — most recent UTC day with `errors > 0` (`—` when none)

Honest limitation, stated in output footer and spec: the installs table
only learns a host BY firing — a wired-but-never-fired install is
invisible to the ledger. "Installed but silent" detection (adapter
probes) is doctor scope, bro-izpyk.1.3.

**Sessions per project** — second section: sessions grouped by
`SessionRow.project` (null-project rows group under their own cwd digest
bucket, displayed `—`). Label = basename of the group's most-recent
session cwd, with the short project hash in parens when known; columns
`project`, `sessions`, `live`, `hosts` (sorted unique host list).

**JSON shape** — `{ hosts: [...], projects: [...], generatedAt }`;
`generatedAt` is epoch ms so consumers can age the snapshot themselves.

### 3. Contract + docs

- `sessions` plugin: `contract.flags` for every flag, `json:
  schemas/cli/sessions.schema.json`, exits `{0, 2}` (+1 documented as the
  ledger-unavailable failure).
- `fleet` contract gains `subs.hosts` (flags `--json`, exits) and the
  summary prose names `hosts` beside `walls`/`leases` — spaced pipes only,
  per the gen-command-docs signature() constraint.
- New schema files `packages/cli/schemas/cli/sessions.schema.json` and
  `fleet-hosts.schema.json` (the contract.test.ts ref-existence gate
  requires them).
- `contract/cli.json` regenerated via `npm run gen:contract`;
  `site/content/docs/reference/sessions.md` + updated `fleet.md` via
  `npm run gen:command-docs` (`check:command-docs` green).

### 4. Facade contract — no extension needed

`sessions()`, `installs()`, `stats()` cover every read above; state/bead
resolution is client-side over `SessionRow` + the agent registry. The
`LedgerFacade` contract is unchanged — noted per the bead's "extend
minimally" clause: nothing was missing.

## Non-goals

- `bro sessions resume` / interrupted-session launch (bro-izpyk.4).
- Claims columns — the `claims` table is empty until bro-izpyk.3; the
  bead column above is the interim honest binding.
- Doctor rows: installed-but-silent, firing-but-killed, duplicate wiring
  (bro-izpyk.1.3).
- Mode writes (`setMode` exists on the facade; `bro mode` is F2).
- Any ledger-store or spool change — read side consumes F1a as merged.

## Tests (hermetic)

- `sessions.test.ts` — arg parsing (strict flags, `--project|--all`,
  `--host`, `--live`, `--json`); `deriveSessionState` boot-boundary
  cases; table rendering; bead resolution against a fixture git repo +
  agents.json (match, miss, no-git); an integration pass seeding a real
  `ledger.db` via `drainHookSpool`/`append` through `ledgerFacade({env})`
  → `collectSessionRows` → rendered output.
- `fleet-hosts.test.ts` — host union across installs/sessions/stats,
  status buckets at the 24 h/7 d edges, per-project grouping + labels,
  `--json` shape, empty-ledger rendering.
- `help-contract.e2e.test.ts` — add `sessions --help` and
  `fleet hosts --help` to the help→stdout+0 matrix.
- Registry/contract: plugin registration is covered by the existing
  plugins.test.ts invariants (grouped, unique name); `check:contract`
  and `check:command-docs` are the regen gates.
