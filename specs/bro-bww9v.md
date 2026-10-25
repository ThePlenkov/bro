# bro-bww9v — the host-wide session cap: one budget, every start

## Problem

`agents.<kind>.maxSessions` is a cap on **bro's own spawns**. It is not a
cap on the account. Two populations draw on the same provider budget:

- the sessions bro opens (fleet workers, an ACP conversation the
  conductor retains, an interactive `bro agents up`);
- the sessions nobody routed through bro — an agent running the vendor
  CLI inside its own worktree, the operator at a terminal.

Only the first population is checked. The second is free, and the
account's free tier is shared by both. What happened on 2026-10-18
(measured from the provider's own session store, `message_nodes`):

```text
2026-10-18 14:06 — 17 devin sessions live in one minute
                  1  of them the fleet's (bypass)
                  15 in one ad-hoc agent's worktree (accept-edits,
                     zero bro registry rows) + 1 more
                  14 of the 17 were model-calling on swe-2-max
```

The cap was 6. The fleet's own spawns were refused correctly, over and
over — 1010 refusals in the daemon log, among them:

```text
spawn-refused — devin session quota reached — 8/6 live sessions
spawn-refused — devin session quota reached — 6/6 live sessions
```

`8/6` is the tell: bro saw **more** live sessions than its own cap and
refused *its* spawns, while the unbudgeted sessions kept running. Those
sessions are what drained the free tier; the wall that followed
(`Reached free model rate limit … reset in N minutes`) then hit the one
session the fleet did own.

So the defect is not "the cap is too high" and not "the cap was
misconfigured". It is that **a cap about the account is enforced at one
of the places the account is spent.**

And the count it is enforced against was wrong in two ways, found while
measuring the incident:

- **a recycled pid reads as a live session.** The lock file carries a
  pid and nothing else, so a devin session that died leaves a lock
  whose number now belongs to another program. On this host a
  `tailscaled` pid held a devin lock and counted as a session;
- **the lock dir is not devin's alone.** Another CLI (`pi`) writes
  devin-shaped session locks into the same directory — 30 of them on
  this host. Those sessions draw on a different account, and counting
  them charged the devin cap for someone else's sessions.

A cap is only as good as its denominator, so the count is fixed in the
same change: **a lock's pid must still BE a devin process** (argv[0]),
and a pid whose identity cannot be disproved still counts (the count
fails closed).

## Design

### The cap is per kind, host-wide, and config

The knob stays `agents.<kind>.maxSessions` — n sessions of this agent,
m sessions of that one, in one config, per kind. The spec pins what it
*means*, because today the meaning is narrower than the wording suggests:

- the cap counts **every live session of that kind on the host** — the
  operator's own, the fleet's workers, a foreign agent's. The plane's
  `countLive` already counts exactly that population;
- it is **not** a per-repo budget and **not** a per-lane budget (the
  worker lanes — `maxWorkers`, `maxBatchWorkers` — stay as they are);
- an unset (or 0) cap means uncapped, as today.

### The plane owns the vendor knowledge; core owns the policy

Core stays vendor-neutral (REVIEW.md §"packages/core is vendor-neutral").
The cap's arithmetic never names a provider — it asks the **plane
registry**:

- the kind of a command is resolved by the plane that claims the CLI
  (`sessionPlaneForCli`) — core already owns that resolution;
- the plane's count is the plane's own (`countLive`), with the plane's
  own state (lock dir, socket listing, local API);
- one method is added to the plane contract: **`startsSessions(command)`**
  — how many sessions of this kind does this command open. The plane
  owns its CLI's grammar (`devin models` opens nothing, `devin acp` opens
  one); a plane that does not implement it never claims a command, so
  the guard abstains instead of guessing.

Core gains one module — `session-cap.ts` — holding the policy:

```ts
sessionCapViews(command, agents)   // the kinds this command would start
sessionCapRefusal(view)             // the reason line, or undefined
```

Both are pure and vendor-blind: a kind, a live count, a cap, a start
count.

### One policy, three call sites

The same policy is applied wherever a session of a kind can start:

1. **the admission** (unchanged) — bro's own spawn, already refusing with
   `session quota reached`;
2. **the ACP surface** — the conductor's session facade. A request opens
   a session on the shared peer and a retained conversation keeps one
   alive. The plane counts live devin PROCESSES, and the conductor's
   conversations share one peer — so the plane sees one where the
   conductor holds many, and the conductor adds its own count on top
   (the peer is already in the plane's count, so the budget errs low).
   A refusal throws the quota line, which the conductor's existing
   failure mapping already answers with 429;
3. **the guard plane** — a tool call about to start a vendor session (an
   agent running the CLI in its worktree). The guard vetoes the call
   when the kind is at its cap. This is the population the incident
   came from.

   The veto point differs per client: the clients that send a pre-tool
   event are vetoed there, and the devin client — whose plugin
   registers no pre-tool event — is vetoed at its PERMISSION request
   (the plugin's PermissionRequest hook). Without the second, the cap
   would guard every agent except the one the incident came from. The
   claim is keyed by the command, so a client that asks twice (a
   pre-tool AND a permission event for the same call) claims ONE slot,
   not two.

### One budget, not three counters

The count is taken before the session's own mark lands, so all three call
sites **reserve the slot** in the kind's reservation dir
(`reserveSessionSlot`, the same files the admission counts). A burst of
parallel starts therefore cannot slip through the window between "the
count says there is headroom" and "the session wrote its own mark".

The budget errs **low, never high**: a reservation holds its slot for
`SESSION_SLOT_TTL_MS` (120 s) even after the session landed, so the
effective cap can be one lower than the configured one for a couple of
minutes. That is the right direction for a shared account.

### Fail-closed where a quota is, fail-open where a hook is

- the admission and the ACP surface **fail closed**: a cap that cannot be
  established refuses (the house rule — a quota that cannot be verified
  must not be walked past), and a slot the ACP surface cannot claim
  refuses the request too — a session whose claim the budget never saw
  is exactly the unbudgeted session this change exists to stop;
- the guard plane **fails open**: a hook must never stall a client
  (REVIEW.md §"Hooks and launchers must fail open"). An unreadable count
  lets the call through; the admission and the ACP surface are the hard
  gates.

The wire contract of a refusal: a request that has not answered yet gets
**429** (the quota line matches the conductor's rate-limit mapping). A
**streamed** request has already sent its 200 and its preamble — the
stream IS the response — so the refusal arrives as the stream's error
event, the wire's own way of saying the same thing. The status line
cannot be rewritten after the body started; the spec says so instead of
pretending otherwise.

### The vendor's knowledge moves to its own package

All devin-specific logic lives in **`packages/devin`**
(`@broject/devin`): the session plane (lock dir, live/worker/batch
counts, the process probes), the CLI's session grammar, and the store
reader behind the lane telemetry. `packages/cli` keeps the wiring only
(registering the plane, the guard wiring, the status surface).

This is not a rename: `packages/devin` is the devin **facade** — the
thing that knows how devin marks a session, how its CLI spells a session
start, and how its store counts requests. The bro **devin plugin**
(`plugins/devin/bro`) is a different animal: the client adapter that
carries bro's skills and hooks into the devin CLI. It inherits the
facade; it does not contain it.

## Verify

- `packages/core/src/session-cap.test.ts` — the policy is
  vendor-blind and pure: a kind at its cap refuses, below it admits, a
  command starting *k* sessions is judged against `live + k`; a command
  no plane claims is silent; a kind with no cap armed contributes
  nothing; an unverifiable count throws and the caller decides (closed
  for a quota, open for a hook).
- `packages/devin/src/starts.test.ts` — the CLI's grammar:
  `devin`, `devin acp`, `devin -p`, `devin --cloud` open a session;
  `devin models`, `devin list`, `devin doctor`, `devin rm` do not; a
  mention of devin as an argument (`grep devin`) is not a start; a
  compound command counts every start; a quoted command string is one
  argument, not a start.
- `packages/devin/src/plane.test.ts` — the count: live sessions
  host-wide (lock dir, dead pids filtered), a RECYCLED pid is not a
  session, another CLI sharing the lock dir is not a session, an
  unreadable pid entry still counts (the count fails closed), and the
  board's rows agree with the count beside them.
- `packages/cli/src/commands/session-cap.test.ts` — the guard plane
  vetoes a start at the cap, stays silent below it, never touches a
  command no plane claims, fails open when the count cannot be
  established, and claims the slot on an allowed start so a burst shares
  one budget; the conductor's helper counts its retained conversations
  with the host's.
- Live: `bro agents status` shows the live count against the cap, and a
  breach is visible as a ratio (8/6), not only as a refusal in the log.
