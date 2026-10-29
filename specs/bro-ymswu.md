# bro-ymswu — comms nats connector: live fan-out over the events facade

`events.ts` was designed for this bead: the `EventsFacade`
(`publish`/`subscribe`/`probe`) names domain semantics — topic, kind,
key, cause, ref, `to` — and never a transport, with `connectors.events`
in `bro.config.json` as the pick seam. The doc comment literally
anticipates it: "a mailbox file today, the local bus, MQTT or AMQP when
the fleet goes multi-host." Today the only live transport is the local
unix-socket broker (`bus.ts`): one rig, one socket, pull-model. This
bead adds **nats** as the second `events` connector — the first
transport that can reach outside the rig.

What this is NOT: a `sinks.ts` type. Sinks are the human edge —
one-way HTTP POSTs to people, dedup'd on `minIntervalMs`, secrets via
`urlEnv`. The nats connector is a peer transport on the _agent_ event
plane: bidirectional-capable, filter-routed, sequence-honest. Nor is it
a mailbox replacement — notify drops stay files; the spool is a
feature.

## Design

- **`connectors.events: "nats"`** selects `NatsConnector`, a new
  `EventsFacade` implementation in `packages/core/src/` (client in a
  small `packages/nats/` if it outgrows a file). It uses the
  first-party, zero-dep `nats` npm package (nats.js) — pinned to a
  release ≥7 days old.
- **Decorate, don't replace.** The connector wraps the local bus
  facade: `publish` delivers to the local bus _and_ to nats; `subscribe`
  merges the local stream with the nats subscription **deduplicated on
  envelope `id`** — a local publish arrives once from the bus and again
  from its own nats fan-in, and must deliver once; `probe` reads the
  local bus only (it is the hook-path primitive — intra-rig by
  contract). A rig with `connectors.events=nats` and a dead nats-server
  keeps full local semantics: the nats leg reports
  `EventPublishResult.reason`, the local leg is untouched. Fail-open
  everywhere — the publish contract forbids a transport throw reaching
  a hook caller, and every nats call is bounded like `BUS_TIMEOUT_MS`.
- **Wire envelope**: `EventInput` + `{id, ts, gen, source}` as JSON —
  `id` is a fresh per-event unique id (the dedup key above). No
  `seq` — core NATS has no total order, and the facade leaves `seq`
  undefined for transports without one; inventing one is the dishonesty
  the field's contract forbids. `gen` marks the producing rig's run.
- **Subject grammar** — two disjoint subtrees so addressed events
  cannot leak to broadcast subscribers:
  `bro.<rig>.evt.<topic>.<kind>` and
  `bro.<rig>.to.<addr>.<topic>.<kind>`. `EventInput.to` maps onto the
  `to` subtree; a consumer subscribing `bro.<rig>.evt.>` provably sees
  only broadcast traffic (the `to` subtree sits under a different
  token — `evt` ≠ `to`). Every token is percent-encoded
  (`encodeURIComponent`) **with `.` additionally escaped to `%2E`** —
  NATS splits subjects on dots, so an unescaped period inside a value
  silently splits one token into two (`a.b`/`c` vs `a`/`b.c` would
  collide). Composite keys get a canonical form; `a.b` and `a_b` must
  not collide and `%` is not a legal NATS wildcard char.
- **Rig id**: `comms.nats.rig` → the mesh rig identity (`mesh://`) →
  basename of the **worktree root** (the directory containing `.git`),
  subject-encoded — never the common-dir basename, which is the
  constant `.git` for every ordinary repo and would collapse all rigs
  onto one subtree. One rig = one subtree owner; `source` in the
  envelope names it.
- **Egress-only for v1.** Local publishes fan out to nats; remote
  events do NOT re-enter the local bus — ingress republish is the mesh
  binding's job (bro-o6968), where a remote rig's `mesh/1` envelope is
  what arrives. Consumers of this connector are external: the herdr
  plugin (bro-762eh), `nats sub 'bro.>'`, dashboards.
- **Lifecycle — daemon-owned, adopt-first.** With
  `connectors.events=nats`, `bro fleet daemon` resolves
  `comms.nats.url` (default `nats://127.0.0.1:4222`): reachable →
  connect, the server is foreign; silent on a loopback url → spawn
  `nats-server` as a managed child, recorded in daemon state and
  reaped with it. `nats-server` must be on PATH for the managed path;
  `bro doctor` reports it when the backend is nats, like `gh`/`bd`.
  Publish-side processes hold no connection — connect-write-exit, the
  same model the bus uses; only daemon/host subscribers keep one.
- **Auth**: a loopback NATS is _looser_ than the unix socket (which
  asserts a 0700 dir) — any local process could pub/sub. Managed-child
  mode therefore generates a random token, stores it at
  `<git-common>/bro/nats.token` mode 0600, writes a minimal server
  config `<git-common>/bro/nats-server.conf` (0600) carrying an
  `authorization { token: ... }` block, and spawns the child with
  `--config` — never `--auth`, which would print the token in `ps`
  for every local user. Local publishers read the token file.
  Foreign-server mode
  takes `comms.nats.tokenEnv`/`credsFile` — env/file indirection, the
  sinks.ts secret rule: values never enter config, argv, or logs.
- **Deps**: `nats` npm package added to `packages/core` (or the new
  package). `nats-server` binary stays an external requirement — not
  vendored.

## Non-goals

- No JetStream — durability lives in mailbox files and the bus ring;
  streams/consumers arrive with the mesh binding (bro-o6968).
- No ingress bridging — remote→local republish is bro-o6968.
- No accounts/leaf-node topology, no per-subject ACL — bro-a2b0n.
- No mailbox/notify transport change; no CLI surface change —
  `bro comms`/`bro notify` are identical (facade rule: the CLI is the
  contract, the connector is the implementation).

## Verify

- Unit: subject grammar round-trips (`evt`/`to` subtrees disjoint,
  percent-encoding injective on hostile tokens); envelope maps
  `EventInput` fields 1:1; `to` events never land under `evt`.
- Integration (skipped when no `nats-server` on PATH): publish a real
  event, `nats sub 'bro.<rig>.>'` receives the envelope; addressed
  event lands only on the `to` subtree.
- Lifecycle: daemon spawns managed `nats-server` on a silent loopback
  url (token file written 0600), adopts a reachable one; dead server →
  publish reports `reason`, local bus still receives.
- `npm run build`, `npm run typecheck`, `tsx --test` green.

## Exit criteria

`connectors.events=nats` + `bro comms notify` produces a visible
message on `nats sub 'bro.>'` while `bro watch`/`bro notify` keep
working identically — external fan-out live, local semantics intact.
