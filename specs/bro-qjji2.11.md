# bro-qjji2.11 — pipeline: accept emit adapter — evidence bundles to notify/mailbox/A2A

Parent: specs/bro-7d5nb.md (§accept — "the engine emits the evidence
bundle `{verify rows, diff summary, draft_pr?}` to the run's recorded
customer channel (user → notify/mailbox; agent-customer → the A2A
surface)"). Sibling boundaries: bro-qjji2.10 shipped the production
run-starter and engine map — its `acceptEmit` placeholder binds the
seam to a bare mailbox drop + sentinel; this bead replaces that
placeholder with the real transport. bro-qjji2.10's spec already
names the split: "the emit TRANSPORT (A2A surface, rich notify) is
bro-qjji2.11". The audit gap: `acceptStage.emit` is an injected seam
with no production adapter — `verdictStore` got `fileVerdictStore`,
emit got a script log.

## Problem

`acceptStage`'s `emit` carries the evidence bundle to the run's
customer and MUST be idempotent on `(runId, stage)`: `invoke` emits
then parks pending; every wake's `recheck` re-emits while the
verdict is absent (the first emit may have died inside the pending
intent's crash window — at-least-once delivery on a dedup-keyed
channel beats a run that waits on a bundle nobody saw). The only
binding today is `scripts/pipeline-live-e2e.mts`'s console.log; the
prod map's `acceptEmit` drops a verbatim mailbox note for EVERY
customer — a human operator and an agent-customer get the same
broadcast, and an agent that cannot drain the notify mailbox (a
detached worker with no hook session) never sees the bundle at all.

## Design — `packages/cli/src/pipeline-emit.ts`

The production `emit` binding, constructed by `engines(dir)` in
`pipeline-engines.ts` (provider seams stay injected — the pipeline
package never learns what a mailbox or a session inbox is). One
factory, `pipelineEmit(deps)`, returns the `(call, bundle) =>
Promise<void>` the stage's `AcceptDeps.emit` wants.

### Delivery routing — the customer identity picks the channel

`call.customer` is the recorded acceptance authority — a free-form
identity string (`--customer`/`BRO_CUSTOMER`/`bdActor` at run
creation; `--by`/`BRO_AGENT_ID`/`bdActor` at verdict time). The
adapter classifies it once per emit:

- **agent → the A2A surface** (`sendSessionMessage`, the `bro msg`
  core — session-msg.ts): the customer names a session/agent
  address when it is
  - the `orchestrator` role,
  - `<host>:<sid>` session-key shaped (a `:`-bearing id —
    `bdActor`/git identities never carry one),
  - an agentId in the fleet registry (`readAgentRegistry` — covers
    a spawned worker whose session has not hooked yet), or
  - resolved against the session ledger (`sessionMsgRows` +
    `resolveMsgTarget` — a `spawnedBy` agentId, an exact sid, a
    unique ≥4-char sid prefix, or a session key with a live row).

  `sendSessionMessage` then picks the per-session channel itself:
  inbox-capable hosts get the F4 inbox file (Tier-0 wake on the
  next hook) plus an events `msg` record; everyone else gets the
  addressed mailbox drop (`to:` the mailbox vocabulary) plus the
  same record. Kind is `ask` — the bundle requests a verdict; a
  label, never a grant.

- **user → notify/mailbox**: everything else publishes ONE
  `topic:'notify'` event (`kind:'ask'`) through the `events` facade —
  the same surface `bro notify` writes, so `connectors.events: "bus"`
  opt-ins carry it too. Broadcast (no `to`): the notify mailbox's
  contract is every-live-session delivery, which is exactly what a
  human customer needs — there is no "user" address in the mailbox
  vocabulary, and an addressed drop to a bare name would reach
  nobody.

The classification fails SAFE toward the user leg: an identity that
resolves nowhere is a human label, and broadcast reaches every live
session — including an agent session that drains the mailbox. The
reverse mistake (addressing a human's name) would strand the bundle
on an address no session carries. An agent-classified customer whose
delivery resolves to nothing (ambiguous target, all legs down) is
NOT silently re-routed to broadcast — evidence must not leak to
sessions the customer did not name; the emit warns and leaves the
sentinel unwritten so the next wake retries (the world may repair:
the session registers, the ambiguity clears).

### Idempotency — the dedup key is the bundle, not just the stage

The sentinel ledger lives beside the pipeline plane
(`<git-common>/bro/pipeline/.emit-<runId>-<stage>-<digest>`; the
notify dir when no plane resolves — same fallback the placeholder
used). The digest is `contentDigest(bundle)` — the canonical
sha256 the customer channel already exports. Within one pending
accept entry the bundle is content-stable (the run is suspended;
nothing new settles), so every `recheck` re-emit computes the same
key and dedupes — the `(runId, stage)` contract the stage documents.
The digest earns its place on RE-ENTRY: `rejected → work` returns
to accept with fresh verify rows, a different bundle, a different
key — the customer sees the new evidence instead of the stage's
second emit being swallowed by a `(runId, stage)`-forever sentinel
(the placeholder's latent bug: post-rejection re-accepts never
re-notified).

The same key rides the published event's `key` field, so the
mailbox transport's `coalesceDrops` collapses pending same-key
drops — the crash-window double-emit (drop landed, sentinel write
died) supersedes rather than accumulates. `source` is the
runner-env identity (`BRO_AGENT_ID` → `BRO_SESSION_ID`, the `bro
msg` attribution rule); a sourceless publish claims no coalescing
identity and supersedes nothing — the sentinel still dedupes.

Ordering is at-least-once, never at-most-once: the sentinel is
written only AFTER a leg reports delivery (publish `published:true`
/ a landed inbox path or addressed drop). A transport failure —
`published:false`, zero deliveries, a throw — leaves no sentinel
and the next wake's recheck retries; a crash between delivery and
sentinel re-delivers once (the contract's tolerated duplicate,
now coalesced on the mailbox leg). A sentinel WRITE failure warns
and moves on — noisy re-delivery beats a lost bundle.

### What the bundle text is

Unchanged from the placeholder's proven wording: run id, item, the
full journaled `EvidenceBundle` JSON (verify rows, diff summary,
draft_pr — the customer signs what the journal can prove, never a
truncated view), and the verdict command
(`bro pipeline accept <item> <accepted|rejected|abandon>` — the
CLI auto-discovers the parked run). For the A2A leg the text is
the `msg` payload; the drain renders the `[msg ask <from> → <to>]
↳<cause>` envelope around it.

## Wiring

`pipeline-engines.ts`'s `acceptEngine` binds
`acceptStage({emit: pipelineEmit({dir}), verdictStore:
fileVerdictStore(dir)})`. Facades resolve LAZILY inside the emit —
`facade('events')`/`facade('ledger')` on first delivery, cached —
so building the engine map still needs no configured connector
(the existing lazy-seam contract). `connectors.ledger`/`connectors.
events` pins are honored through `loadConfig(dir).connectors`, the
same `connectorOpts` `bro msg` uses. `sendSessionMessage`,
`sessionMsgRows`, `resolveMsgTarget`, `readAgentRegistry`,
`dropMailbox`/`notifyDir` semantics, `contentDigest`, `pipelineDir`
are the only imports — no new core surface.

## Non-goals

- The verdict side — `fileVerdictStore` and the customer channel
  file are unchanged; this bead is emit-only.
- Interactive in-session negotiation (spec §customer channels
  "interactive" mode) — the formula does not branch on mode; a live
  customer still answers through `bro pipeline accept`.
- Foreign-agent transports (`bro request` mesh, `wl://` board) —
  the A2A surface here is the session inbox + events record this
  rig owns. An agent customer unreachable by both legs degrades
  to warn-and-retry, never a fake delivery.
- Re-delivery of an already-delivered bundle — once the sentinel
  lands the channel owns expiry (mailbox DROP_TTL, inbox no-TTL);
  the waker's re-emit cadence exists for emits that never landed,
  and this adapter makes "landed" durable.
- `scripts/pipeline-live-e2e.mts` keeps its console.log seam — it
  tests stage semantics, not transport; prod binding is asserted
  by the live smoke below.

## Verification

- `packages/cli/src/pipeline-emit.test.ts` — classification matrix
  (user label → notify publish; `orchestrator`/`host:sid`/registry
  agentId/ledger `spawnedBy`/sid → `sendSessionMessage`), dedup
  (second emit of the same bundle delivers once; a changed bundle
  re-delivers), undelivered → no sentinel → retry, sentinel-write
  failure → warn-only.
- `npm run build`, `npm run typecheck`, `npm test`.
- Live smoke: a real `runPipeline` accept park in a tmp repo with
  the prod `engines(dir)` map (or the emit adapter bound directly)
  → bundle lands in the repo mailbox for a user customer; an
  agent-customer id lands via `sendSessionMessage` (inbox file or
  addressed drop + events record); `recheck` without verdict → no
  duplicate; verdict present → emit stops.
