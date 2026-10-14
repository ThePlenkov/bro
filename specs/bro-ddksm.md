# bro-ddksm — conductor: BRO_HOOKS=0 for machine-backend acp trees

Retro bro-p0baz: a stateless `/v1/messages` caller (claude's auto-mode
classifier, permission checks) pays a deadline the conductor's pooled
acp child cannot meet — every `session/new` fires the agent's
session-start hooks, and bro's rehydrate pass (`bd ready`, worktree
list, mailbox, watch rearm) costs seconds a permission classifier
doesn't have. The warm pool made spawn+initialize cheap; the hooks are
the per-request tax that remained.

## Mechanism

- `BRO_HOOKS=0` marks a process tree as a machine backend — no human
  session exists to rehydrate, gate, or notify, so every session-lifecycle
  hook event is pure latency.
- The acp provider binding pins it on every agent it spawns
  (`withAcp`, `acpOpen` — judge one-shots AND the conductor's pooled
  peer): `env: { BRO_HOOKS: '0', ...process.env }` — the pin is a
  default, an explicit ambient `BRO_HOOKS` still wins for debugging.
- `bro hooks <event>` honors it: after the payload is parsed (a Cursor
  `permission` still answers `ask` — that host blocks on silence), the
  dispatcher returns before opt-in checks and probes. Only the
  session-lifecycle events gate — `install`/`uninstall`,
  `prepare-commit-msg`, `reference-transaction`, `post-merge`, `perf`
  and the bare capability probe stay live: installed git shims
  (provenance trailers, the shared-ref guard) are a different contract
  than session context, and the flag must not weaken a safety control
  inside the spawned tree.
- `hooks/run.sh` exits 0 on it before resolving any bro binary — the
  commonest hook path (plugins' hooks.json → run.sh) then costs a
  shell test, not a node spawn. The `bro hooks`/`npx` fallbacks in the
  same hooks.json are covered by the CLI-side check.

## Deliberately not done

- `bro acp-worker` (fleet spawn unit) does not pin the flag — its
  session is the work product, a long-lived agent session where
  rehydrate context is arguably useful. The flag is for disposable
  turn-serving sessions.
- No bare-session pooling: with hooks off, `session/new` is already
  the cheap call the pool assumed; a session pool would add lifecycle
  complexity to save nothing.
- Per-event granularity (`BRO_HOOKS=session-start` only) — a machine
  tree needs none of them; a knob matrix buys nothing.

## Verifies

- e2e: `BRO_HOOKS=0 bro hooks session-start` emits nothing, exit 0 —
  and via `run.sh` the launcher path short-circuits the same way.
- providers: the spawned acp child's env carries `BRO_HOOKS=0`; an
  ambient explicit value wins over the pin.
