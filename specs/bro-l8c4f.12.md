---
parent: bro-l8c4f
scope:
  - packages/core/src/tasks.ts
  - packages/github/src/tasks.ts
  - packages/linear/src/tasks.ts
  - packages/jira/src/tasks.ts
  - packages/cli/src/commands/loop.ts
---

# bro-l8c4f.12 — TaskStore claim capabilities: exclusive claim vs best-effort assignment

Parent: `bro-l8c4f` (principal audit 2026-10-18 — claim-capability).

## Problem

`TaskStore.claim()` is documented as "atomic assignee + in_progress —
throws when already claimed", and every consumer reads a successful
return as *sole ownership*. Only the beads store keeps that promise:
`bd update --claim` is a single-winner write inside the addressed
store. The remote connectors all implement the same read → write →
verify re-read shape, which *detects* a held claim and *settles* most
races but cannot promise a single winner — an interleaving where the
loser's verify read lands before the winner's write is durable still
returns success to both callers:

- **linear** — `queryIssueSync → issueUpdate(assigneeId) →
  queryIssueSync`. No compare-and-swap on the API; the verify read can
  run before the other racer's `issueUpdate` commits.
- **jira / jira-dc** — `GET issue → PUT assignee → GET issue`. The code
  documents the residual race window itself; REST has no claim
  primitive at all.
- **github** — assignees are a set; two racers can both add themselves
  before either re-reads. The connector detects a contested set and
  deterministically unassigns the lexical loser, but the loser's verify
  can still snapshot the pre-write state.

There is a second, quieter gap: even when the race is lost correctly,
the claim binds a **viewer** — the API account the credential
presents — not a worker. Two workers behind one API token claim as the
same identity, so a verify that sees "the issue is assigned to me"
cannot tell which *worker* holds it.

Today nothing says any of this out loud: `bro next`, `bro work enter`,
and `bro loop`'s fallback spawn all call `store.claim()` and inherit a
guarantee the backend may not provide. The audit requires the contract
to *declare* the capability rather than imply it — no new lock service,
no CAS retrofit forced onto trackers that don't have one, and no
treating two syncing Dolt replicas as one authority.

## Terms

- **claim strength** — what a successful `claim()` return guarantees.
  `exclusive`: the backend arbitrates a single winner; a returned
  success is sole ownership *within the declared authority*.
  `best-effort`: `claim()` performs the assignment and refuses claims
  it can see, but a residual race window can still seat two winners —
  the claim is a marker, never a lease.
- **identity scope** — the identity a claim binds. `actor`: a
  per-worker identity (bd's actor chain — config → git user → `$USER`).
  `viewer`: the API account behind the credential, so every worker on
  one token claims as one identity.
- **authority** — the boundary exclusivity holds inside. `store`: the
  addressed store instance alone — two independently syncing replicas
  are two stores, never one authority. `service`: the backend's shared
  namespace (the Linear workspace, the Jira site, the GitHub repo).

## Contract

```ts
export interface ClaimCapability {
  strength: 'exclusive' | 'best-effort'
  identity: 'actor' | 'viewer'
  authority: 'store' | 'service'
}
```

`TaskStore` gains an optional `claimCapability?(): ClaimCapability`,
and `claim()`'s doc is reworded from "atomic" to the honest claim:
what a successful return *means* is the capability's word.

Capability rules:

- **Absent is not a promise either way.** Third-party connectors that
  predate the member are untouched — exclusivity-seeking callers treat
  an absent capability as non-exclusive (fail closed); assignment flows
  keep working unchanged (fail open). An absent member never reads as
  exclusive.
- **Declarations describe, they don't upgrade.** A best-effort store
  never reports or implies exclusive ownership — no call shape, flag,
  or config upcodes the declaration.
- **`claim()`'s signature is unchanged.** Assignment stays available in
  non-exclusive flows (`bro next`, `bro work enter`, `bro task claim`);
  only a caller whose algorithm needs a single winner consults the
  capability.

Declarations on the built-in stores:

| store                | strength      | identity | authority |
| -------------------- | ------------- | -------- | --------- |
| beads (`makeStore`)  | `exclusive`   | `actor`  | `store`   |
| github               | `best-effort` | `viewer` | `service` |
| linear               | `best-effort` | `viewer` | `service` |
| jira / jira-dc       | `best-effort` | `viewer` | `service` |

Beads is `exclusive` **per store instance**: `bd update --claim` is
one write against the addressed db, and every fleet caller that needs
a single winner already claims through `taskStoreAt(beadsDir)` — the
same store, not two replicas. `authority: 'store'` is what makes this
honest: `bd sync` replicas on two hosts are separate authorities and
the capability says so.

## Callers

- **Fleet/registry path** — `claimStep`/`rebindStep` claim on the
  pinned beads store, already exclusive. No change.
- **`bro loop` fallback** — when the registry spawn did not engage
  (`ctx.agents === undefined`), the loop claims through the resolved
  `tasks` facade. A non-exclusive store gets a startup advisory —
  backend name, what the claim means (assignment, not a lease; one
  viewer = one identity), and the remedy (one loop on this backlog, or
  an exclusive-claim store). `say()` keeps it on stderr under `--json`.
- **`bro next` / `bro work enter` / `bro task claim`** — single-session
  assignment flows; unchanged. Their `claim()` calls were never
  presented as leases to the session.
- **`claimUpTo`** — already race-tolerant (reread proves the item moved
  on a thrown claim); unchanged.

No flow is failed closed: every exclusivity-needing path in the tree
already claims on the beads store. Refusing to start a loop on a
best-effort backend would break single-issuer tracker rigs — the audit
explicitly keeps assignment legal in non-exclusive flows.

## Testing

Deterministic interleaving tests per remote connector, driving the
existing fake-CLI harnesses with a scripted issue-read sequence
(`FAKE_<X>_ISSUE_SEQ` dir of numbered response files):

- **two viewers, one race window** — A reads unassigned, writes, verifies
  "mine"; B reads unassigned (pre-A-write snapshot), writes, verifies
  "mine". Both `claim()` calls return success → the double-seat the
  capability declares.
- **two workers, one viewer** — same sequence with one credential: both
  verifies see the shared identity, both return.
- each store's `claimCapability()` reports `best-effort`/`viewer`/
  `service`; beads reports `exclusive`/`actor`/`store`.
- `claimAuthorityNote` builds the loop advisory naming the backend and
  the remedy; single-user operations (claim/update/list on a
  non-exclusive store) are unchanged.

## Non-negotiables

- **No new lock service** and no CAS requirement on trackers that don't
  offer one — the contract declares reality, it doesn't impose it.
- **Replicas are not one authority.** `authority: 'store'` on beads
  names the boundary; nothing extends exclusivity across `bd sync`.
- **best-effort never claims sole ownership** — in type, in docs, in
  user-facing output.
- **Single-user ops preserved.** No behavioral change to `claim()`,
  `update()`, or queue reads on any backend.
- **Facade contract stays compatible.** `claimCapability` is optional —
  existing third-party connectors compile unchanged and degrade to
  "undeclared", which callers read as non-exclusive.
