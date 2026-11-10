# bro-7ira8 — the durable provider must not hold an idle Devin session

## Problem

On 2026-11-09 the host listener `bro provider serve --port 4545` ran for
57 minutes with **one request** in flight. During that time it kept a
`devin acp` child alive, and the child did the account's accounting
against the operator's own session:

- the Devin CLI rescanned the user's skills tree from `$HOME` every
  ~10–30 s — **1162 discovery cycles** in 57 minutes, `errors=272` per
  cycle;
- the same child opened **216 ACP `session/new`** and **54
  `session/prompt`** events across six conversations (the operator's own
  Claude Code sessions, routed through this listener, plus the probes);
- the Devin free-model limit is **per-account concurrent sessions**, not
  per request (lesson `learn-devin-free-model-limit-is-per-account-co`),
  and a retained serve backend is named there as one of the saturation
  sources.

The operator's own session hit an explicit wall; the account was locked
for five hours. A listener that serves nothing must not hold a
concurrent Devin lane — the cost is the operator's, not the listener's.

The listener's promise is *"survives the session"*. It must not also
promise *"holds a model account hostage while idle"*.

## Design

### The pooled peer is released when the pool goes idle

`acpLinkPool` already owns the lifecycle of the pooled ACP child:
spawn-once, respawn-on-death, `dispose()` on shutdown. What it lacks is
the other direction — a release when **no request** is pending.

The pool learns the idle window and arms a timer:

- a turn that settles re-arms the timer, and a peer with a turn in flight
  is never released — "idle" means "not answering", not "not asked";
- when the timer expires, the pool closes the peer (the child dies with
  it), drops it from `pooledPeers`, clears the pool state and fires the
  death hooks, so the conductor drops the retained sessions that died
  with the link — one death path for the transport's abort, the idle
  release and the dispose;
- the next `link()` spawns a fresh peer — the pool's existing
  respawn-on-death path, unchanged.

The timer is `unref`'d: it never keeps the process alive.

### The window is configured, and it has a default

`serve.idleReleaseMs` — milliseconds; default **300000** (five minutes);
`0` disables the release. The env pin `BRO_PROVIDER_IDLE_RELEASE_MS`
overrides it, next to `BRO_PROVIDER_TIMEOUT_MS`.

The default is deliberate: five minutes is long enough that a busy
listener never respawns its peer, and short enough that an idle
listener is not a permanent concurrent Devin lane.

### Only the request-scoped plane releases

The conductor's `/v1/*` pool is request-scoped: each call is a complete
turn, and the peer exists only to serve them. It releases.

The `/api/v1/acp` transport pool is **conversation-scoped**: the client
asked for a long-lived ACP link, and killing it mid-conversation breaks
the contract the client holds. It keeps its peer (the window is `0`
there).

### The kill must kill

The release closes the peer; the peer's own close must take the child
process group with it — the churn lives inside the child, so a dropped
handle without a dead process buys nothing.

## Contract

| plane | idle window | behaviour |
| --- | --- | --- |
| `bro provider serve` / `bro serve` `/v1/*` | `serve.idleReleaseMs` (default 5 min) | the pooled `devin acp` child is killed after the window; the next request respawns it |
| `bro serve --acp` `/api/v1/acp` | disabled | the conversation-scoped peer stays — the client owns its lifetime |

## Tests

- The pool releases the peer after the idle window: the peer is closed,
  the pool's `live()` reads empty, and the next `link()` spawns a new
  peer.
- A request inside the window keeps the peer: no release while the
  window is re-armed.
- `serve.idleReleaseMs` in the config: read by the loader, a garbage
  value dropped, `0` disabling the release.
- The env pin wins over the config, like `BRO_PROVIDER_TIMEOUT_MS`.

## Out of scope

- **The skills-discovery churn itself** — that is the Devin CLI's own
  loop inside the child. Killing the child ends it; teaching Devin to
  scan less is the vendor's business.
- **The retained ACP sessions** inside the conductor. They die with the
  released peer — the conductor drops them through the existing death
  hooks.
- **The per-account quota itself.** This change stops bro from being a
  standing consumer; it cannot change what the operator's own session
  spends.
