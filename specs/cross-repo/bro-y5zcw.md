# bro-y5zcw — cross-repo WAIT phase: `bro wait external:<ref>`

## Problem

`bro request <repo> <title> --for <bead>` (phase LOCAL) ends with
`bd dep add <bead> external:<rig>:<id>`. bd stores that edge verbatim
and resolves it at query time against the named project: the dependent
leaves `bd ready` only once that project holds a **closed** issue
carrying `provides:<capability>`. The block is therefore real and
machine-enforced, and it releases whether or not anyone is watching.

What a session still lacks is the read. `bro mesh wait <thread>`
reduces mesh/1 lifecycle envelopes across stores — it answers *whose
turn is it*, and it sees only what the mesh scan returns, which is open
rows: `scanLocal`/`scanReplica` drop closed beads. `bd`'s own readiness
view answers the local side of the question; the edge it resolves
carries no state, no reason, no liveness of its own. Neither can answer
what a waiter actually has — *may I pick my work back up yet, and if
not, why not?*

Without the watcher the failure modes are both silence: a session that
idles inside a turn waiting, or one that reports "waiting on the other
repo" with no evidence behind it. Neither notices the case that
actually costs a day — the far side closed the bead and nobody shipped
it, so the dep will never release and no poll of the thread would ever
say so.

## Design

### `bro wait external:<ref>` — the dep-plane point-check

One command, one question, a bounded poll over the dep's two stores —
the posting store and the foreign peer plane. It is read-only by
construction: no claim, no close, no `bd ship`, no dep writes — it
modifies neither store; a write into the peer plane would be a
sovereignty violation on top of the read contract.

**Ref parsing.** The argument is an external dep ref,
`external:<project>:<capability>`, where `<project>` is a rig URI
(`mesh://<org>/<repo>`) and `<capability>` is the request bead id —
exactly what `wireDep` writes (mesh: `post.ts`). The rig URI carries
its own colon, so the split is on the **last** colon after the
`external:` prefix, then `parseRigUri` must accept the project half.
Anything else — a bare `external:` fragment, a non-rig project, or an
argument that isn't an external ref at all — exits 2 with a message
naming the fix (`bro mesh wait <thread>` for the thread-plane read).

**Plane resolution.** `<project>` resolves through `mesh.peers`: the
binding whose `rig` matches picks the foreign read plane. A `local`
binding reads the peer's live store directly (`bd -C <checkout>`); a
`beads-remote` binding reads the replica as it stands — sync is not
this command's job (non-goals), so the verdict annotates the replica's
age rather than freshening it. No binding for the rig is a config
error, not a wait: exit 2 naming the rig, because polling a plane that
cannot exist reports "still waiting" forever.

The request bead's location depends on the transport — where `<id>`
lands is the transport's (specs/mesh Lifecycle): `local` delivers the
post into the peer's checkout, so the peer's store holds it;
`beads-remote` keeps the post on the requester's own store for the
peer to pull, so the replica never carries it. The request bead is
read on the **posting store** — the peer plane for `local`, `dir`
itself for `beads-remote`. An `<id>` absent there is a bad ref (exit
2), not a transient failure: the transport says where it must land,
and it is not there.

**The read.** Two store reads carry the dep verdict; a third, reused,
carries the thread's progress. All are status-bearing:

```text
bd -C <post-store> show <id> --json                      # request bead: status, labels
closed issues labelled `provides:<id>` on the peer plane # bd's ship rule, restated
meshThread(<dir>, peers, <id>, common, {pull: false})    # stage/turn annotation
```

`<post-store>` is the posting store above; the peer plane is always
the foreign store — the worker ships `provides:` into its own store,
which is exactly the project the dep names. For `local` both calls hit
the same checkout; for `beads-remote` they deliberately split.

The second call is bd's own resolution rule, restated: the capability is
released when the target project holds a closed issue labelled
`provides:<capability>`. How the query reaches the store is the
transport's — `bd -C <checkout> list --label provides:<id> --json
--all` on a `local` peer's checkout; `dolt sql` on the replica for
`beads-remote`, the `meshIssues`/`issueLabels` precedent in pull.ts,
because a raw dolt clone is not a beads project and `bd` cannot
address it. It is deliberately *not* the inbox path —
`meshScan`/`scanLocal` drop closed rows (`packages/mesh/src/inbox.ts`),
because an inbox is open work. The single record the waiter needs is
precisely the one the inbox scan cannot return.

The third is `bro mesh wait`'s reduction with LOCAL's anchor-admit
rule (bro-oam4): on a `local`-anchored thread the requester's own
records live in the peer's store, so `admitPeerRecord` must admit a
`from` equal to the reader's rig there — the strict peer-rig check
still holds on pull transports. A request threads to itself, so the
capability *is* the thread id. It is the progress line and the one
lifecycle fact that is actionable from the requester's side — a
`reject` means the request must be re-posted. It is an annotation,
never the verdict. The rejected read is the envelope set, not the
reduced `stage`: concurrent `accept`/`reject` verdicts on the
requester's side can both pass the `submitted` check, `meshThread`
ranks the two terminal stages equally, and record order then picks
the reported stage — so `stage === 'rejected'` can hide a real
`reject`. `bro wait` reports the thread rejected iff a `reject`
envelope is present in the set; a thread carrying both verdicts is an
anomaly a human must untangle, and `actionable` is the honest answer.

### Verdicts — the exit code is the answer

`bro convoy wait` already sets the house shape: a bounded poll loop,
stdout stays parseable, the exit code tells the caller which verdict it
woke to. `bro wait` mirrors it, with one addition — a read that failed
is a *different answer* from a read that found nothing.

| exit | verdict   | meaning |
|------|-----------|---------|
| 0    | `free`    | the capability is shipped in the target project; bd releases the dep |
| 1    | `unreadable` | a store the dep names could not be read (checkout gone, `bd`/`dolt` read failed) — transient; retry, never a verdict |
| 2    | `unresolved` | bad ref (including `<id>` absent on its posting store), or no peer binding for the rig — loud, immediate, fix the config |
| 3    | `actionable` | the dep will not clear on its own: the request bead is closed without `provides:` (**closed-unshipped**), or the thread was **rejected** |
| 4    | `timeout`  | still open at the deadline; the ref rides out in the summary for re-arming |

Two properties are load-bearing. First, `closed-unshipped` is its own
verdict rather than a flavour of "waiting": on a delivered thread the
far side closed the request bead without shipping it, so the dep will
never release; on an own-posted thread the closed bead is ours — a
withdrawn or reaped record the dep still names. Either way the
session's next move is a decision it can take inside its own store
(`bd dep remove <bead> external:<…>`) or a nudge to the far side.
Surfacing that is the watcher's whole payoff.
Second, a replica-sourced `free` is annotated with the source and the
replica's age — a stale copy saying "free" is a claim the wait cannot
support. `local` bindings are authoritative; replicas are best-effort
and say so.

`free` and `actionable` outrank the deadline: a ref that resolves or
becomes decidable on the last poll is a verdict, not a timeout.

Consecutive read failures are tolerated (`maxFetchErrors: 3`, the
`waitForGate` precedent) so one `bd` blip does not kill a long poll —
but the loop still ends on a failure verdict rather than on the deadline.

### Flags

```text
bro wait external:<ref>… [--every SEC] [--timeout SEC] [--json]
```

The ref *is* the argument — there is no `--for <bead>` in this phase.
`bro request` prints the ref it wired, and bd 1.3.1 does not expose the
raw external edge in any JSON row (`bd dep list <bead> --json` and
`bd show <bead> --json`'s `dependencies[]` both hydrate *local* issues;
an `external:` edge has no local id to hydrate into), so re-deriving a
bead's refs would mean a second source of truth that can drift from the
edge bd actually holds. The caller reads its own edge and passes the
ref; `bd dep remove`/`bd dep list` stay bd's business.

`--every` is bounded by the same `MIN/MAX_INTERVAL_SEC` window
`convoy wait` uses (a NaN interval is a busy loop, not a poll).
`--timeout` defaults to **45 minutes**, the `bro act wait` default, so
the unbounded case is opt-in (`--timeout 0`) — the named pattern is
"act wait", and the doctrine is that a session never parks on a wait.

**Never a sleeping session.** The loop exists so a caller can wait
without hand-rolling `while … sleep`, which is the ad-hoc orchestration
bro exists to absorb. A session point-checks this *between turns*: the
command returns a verdict and the dep in bd is what frees the work.
Progress goes to stderr (`wait external:<rig>:<id>: stage=claimed
shipped=no`), the verdict to stdout (one line, or one JSON object with
`--json`) so a caller can re-arm on the ref it carries back.

### The loop must close: `provides:`

The dep cannot release until the target project has a closed
`provides:<capability>` issue, and bd's transition is `bd ship`. mesh/1
has no ship verb, so on today's wire a delivered request would block its
requester forever even after the work lands — the watcher would report
`closed-unshipped` forever, which is honest but not a fix.

The pin belongs on the **worker** side: a delivered request bead carries
`export:<id>` so the worker can `bd ship <id>` when it closes the thread
through `bro mesh done` (phase LOCAL's anchor-store write). The
requester never pins it — completion is never self-declared (specs/mesh
Trust), and `accept` is a verdict on a thread, not a licence to forge
the capability label in a store it merely reads. Wiring
`export:`/`provides:` into the delivery and `done` paths is LOCAL's
slice of this (named in its plan); this phase owns reading the labels,
and surfacing their absence as an actionable verdict.

## Non-goals (this phase)

- **Waking the session** — no notify emission, no mailbox drop, no
  background daemon, no detached resurrection. `bro watch` owns cadence;
  a cross-repo dep has no PR to merge on settle and no human arming
  decision to survive, so `act wait`'s rearm machinery has nothing to
  rearm.
- **Expanding a bead's edges (`--for <bead>`)** — bd 1.3.1 JSON rows
  hydrate local issues only, so an `external:` edge is not readable back;
  a bro-side record of what it wired would be a second source of truth
  that can drift from the edge bd holds. Revisit when bd exposes
  `depends_on_external` (or bro persists its wiring deliberately).
- **Any write to the foreign store**, including `provides:`.
- **A general dep viewer** — local edges stay `bd blocked`'s business.
- **Replica/sync management** — a stale replica is reported with its age,
  never papered over by a forced sync.
- **A GitHub-issue / wasteland plane** — phase REMOTE (bro-kim1e).

## Owns

```text
packages/mesh/src/wait.ts             externalRef parse, rig→store resolution,
                                      closed/shipped predicates, replica age
packages/cli/src/commands/wait.ts     bro wait — verdicts, exit codes, loop
packages/cli/src/plugins.ts           registry entry for `wait`
AGENTS.md                             session-facing point-check rule
```

## Plan

- [ ] `packages/mesh/src/wait.ts` — `parseExternalRef` (last-colon split
      after `external:`, project must `parseRigUri`),
      `resolveWaitPlane` (peer binding by rig → local checkout | replica,
      unbound is an error), `readForeignState` (`show <id> --json` on the
      posting store — peer checkout for `local`, `dir` for
      `beads-remote` — for status/labels; the ship predicate (closed +
      `provides:<id>`) queried `bd`-side on a local checkout and `dolt
      sql`-side on a replica; `meshThread` — LOCAL's anchor-admit
      included — reduced to stage/turn), replica source/age annotation
- [ ] `packages/cli/src/commands/wait.ts` — `bro wait external:<ref>…
      [--every SEC] [--timeout SEC] [--json]`; verdict → exit-code
      table above; stderr progress line, stdout one line or one JSON
      object; `maxFetchErrors` tolerance
- [ ] AGENTS.md Conventions bullet tail — the dep-plane point-check and
      the truth clause
- [ ] tests: ref parse matrix (mesh:// rig, last-colon split, malformed,
      non-external arg → exit 2 + mesh-wait hint); unbound rig → exit 2;
      `<id>` absent on the posting store → exit 2; unreadable plane →
      exit 1 with 3-strike tolerance; open at deadline
      → exit 4 carrying the ref; closed without `provides:` → exit 3
      naming the ask; `reject` envelope → exit 3 as rejected; `accept`
      + `reject` on one thread → exit 3 (envelope-set read, not stage);
      shipped + closed → exit 0; replica-sourced `free` annotated;
      posting-store split (own-posted thread: `show` reads `dir`,
      `provides:` reads the replica); e2e two
      checkouts: `bro request --for` → waiter exits 3 closed-unshipped →
      far side `bd ship` → waiter exits 0

## Alternatives

- **Keep `bro mesh wait` as the only watcher** — rejected: it answers
  the thread-plane question from replicas, and the inbox path cannot
  return a closed record at all. "Whose turn" and "am I free" are
  different reads against different stores.
- **One read, no loop; the caller polls** — rejected: that hands every
  caller a hand-rolled wait loop, the exact anti-pattern bro absorbs.
  The bounded default keeps the loop from parking a session.
- **Detached watcher with rearm, like `bro act wait`** — rejected here:
  no PR, no merge, no human arming decision — a rearm marker would nag a
  session whose dep already released in bd. Point-check between turns.
- **The watcher pins `provides:` itself to unblock** — rejected:
  self-declared completion, and a write into a store the requester only
  reads. The actionable verdict names the ask instead.
- **Read every plane through the mesh replica (one code path)** —
  rejected: for a `local` peer the replica is a stale copy of a store we
  can read directly, and staleness is precisely the bug this command
  exists to remove.
- **`--for <bead>` to auto-expand a bead's external deps** — rejected
  for this phase: bd 1.3.1 does not surface raw external edges in any
  JSON row, so it would be bro re-deriving a second copy of the edge it
  wrote and trusting that copy over bd's. The ref is printed by
  `bro request` at wire time; passing it is one argument.

## Related

- specs/mesh/spec.md — envelope, lifecycle, Trust (completion is never
  self-declared), transports.
- specs/cross-repo/bro-oam4.md — LOCAL: `bro request`, the anchor-store
  delivery this phase reads, and the `export:`/`provides:` wiring it
  still owes.
- specs/cross-repo/spec.md — the phase map (LOCAL / WAIT / REMOTE).
- bro-5nnj — epic; bro-kim1e — REMOTE, the other plane this command
  must read the same way.