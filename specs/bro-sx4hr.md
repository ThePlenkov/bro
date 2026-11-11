# bro-sx4hr — the host listener's ACP sessions anchor at $HOME — every skills discovery walks the whole home tree

## Problem

On 2026-11-09 `bro provider serve --port 4545` kept one `devin acp` child
alive for 57 minutes. The child's own log
(`~/.local/share/devin/cli/logs/devin_20261109-161524_139113.log`) shows the
cost was not the turns — it was the **skills discovery**:

- `session/new` pays `load_all_skills:load_workspace_skills` at session
  setup — 216 opens in the window;
- a periodic `chisel_agent::skills_loading` rescans the workspace every
  ~15 s for the life of the child — **1162 discovery cycles** in 57 min;
- every cycle scanned `cwd=/home/pepl` and reported **`errors=272`** —
  the agent walked the operator's entire home tree (every dotdir, every
  project, every cache) looking for skill providers.

The cwd is bro's choice: `cmdServe` anchors the conductor config at
`homedir()` (`packages/cli/src/commands/provider.ts`) — "sessions anchor
at the operator's home — the state dir is for files, and a deletable
checkout must never be an acp cwd". Home satisfied "not deletable" and
failed "cheap to scan".

The same log corpus proves the cwd is the whole cost: a repo-rooted
session (`cwd=/home/pepl/projects/bro`) reports `errors=0` per cycle —
same `loaded=124` skills, same `scanned_scopes=2`. The skills themselves
come from the global config dirs, not from walking cwd; cwd only sets
how much tree the workspace scan pays for. Home-dir anchoring also
**pollutes** the session: `by_provider=[claude=6, windsurf=6]` — skill
dirs belonging to other tools under `$HOME` load into a devin session
that never asked for them.

### The bead's three questions, answered

**(a) What triggers the rescan cadence?** Two vendor-internal triggers
inside the `devin acp` child, neither reachable from bro: the per-
`session/new` setup load, and the ~15 s periodic rescan that runs for
the child's whole life. bro's levers are the ones already shipped —
fewer `session/new` (dead-loop guard, spec `bro-b961a`), a child that
dies when the plane goes idle (spec `bro-7ira8`), and no opens while
the account is walled (spec `bro-i6811`) — plus the one this spec
adds: a cwd whose scan is cheap.

**(b) Is there a session/budget cap on the serve lane?** Yes, layered:
`CONV_CAP=32` retained conversations per lane with TTL eviction
(`serve-conductor.ts`), `SESS_CAP=32` on the brokered transport
(`serve-acp.ts`), the account-wide `agents.<kind>.maxSessions` cap every
open claims against (`assertSessionCap` → `reserveSessionStart`), the
dead-loop budgets (8 opens/scope, 32 abandoned/peer per 60 s), and the
lane cooldown. The 2026-11-07 probe-churn pattern (`session_reused:
false`, ~11k tokens/turn) is a different defect tracked as `bro-5xm9g`.

**(c) Cap concurrent sessions / pin cwd / dedupe discovery?** Concurrent
sessions are already bounded (above). Dedupe inside the child is the
vendor's business — bro cannot teach `devin acp` to scan less. The one
genuine gap is the cwd anchor on the **host listener**: `bro serve`
already pins the repo root; `bro provider serve` has no repo, and its
`homedir()` anchor is the most expensive scan root on the machine.

## Design

### The host listener anchors at a dedicated minimal workspace

`bro provider serve` is a machine-level gateway — it serves every repo,
so no checkout can be the workspace (a deletable tree must never pin a
session, the original constraint). The new anchor is a dedicated
directory bro owns:

```text
$XDG_DATA_HOME/bro/acp        (fallback ~/.local/share/bro/acp)
```

It is created on serve start (`mkdir -p`), is tiny by construction, sits
under the same XDG data home bro already uses for session slots and the
global beads dir, and is never a checkout. Skills discovery against it
walks a near-empty tree; the global skill set still loads (it does not
depend on cwd), and the foreign-tool skill dirs under `$HOME` stop
leaking into sessions.

`bro serve` is unchanged — a repo-scoped listener's workspace IS the
repo root, and that is already correct.

### `serve.acpCwd` — the operator's pin

The anchor is a default, not a straitjacket: `serve.acpCwd` (file) or
`BRO_PROVIDER_ACP_CWD` (env pin, wins) names the session workspace
explicitly — an operator who wants home-dir roaming, or a scratch dir,
says so. Resolved in `conductorConfig` onto `ConductorConfig.acpCwd`;
only the host listener consumes it — repo-scoped serve ignores the knob
because the repo root is not synthetic.

## Contract

| surface | session cwd | skills-discovery cost |
| --- | --- | --- |
| `bro serve` `/v1/*`, `/api/v1/acp` | the repo root (unchanged) | repo tree only |
| `bro provider serve` `/v1/*` | `serve.acpCwd` / `BRO_PROVIDER_ACP_CWD`, else `$XDG_DATA_HOME/bro/acp` | near-empty tree |
| brokered `session/new` | the client's own `cwd`, verbatim (unchanged — spec `bro-ymbq1`) | the client's workspace |

## Tests

- `acpWorkspaceDir()` honors `XDG_DATA_HOME` and falls back to
  `~/.local/share/bro/acp`.
- `serve.acpCwd` parses in `loadConfig` (non-empty string kept, garbage
  dropped); `conductorConfig` resolves it onto `cfg.acpCwd` with the env
  pin winning.
- The provider serve start creates the workspace dir.

## Out of scope

- **The vendor's rescan timer and per-session setup load** — inside the
  `devin acp` child; bro reduces how often it is paid (guards shipped in
  `bro-b961a`/`bro-i6811`/`bro-7ira8`), it cannot remove it.
- **Probe/live-check session reuse** (`session_reused:false`, ~11k
  tokens/turn) — sibling bead `bro-5xm9g`.
- **The brokered transport's peer lifetime** — conversation-scoped by
  contract (spec `bro-7ira8`); an idle-but-connected client owns its
  peer.
- **Per-request cwd on `/v1/*`** — the Messages API carries no cwd
  channel; the named-session (`x-bro-session`) and fingerprint keys
  already bound reuse.
