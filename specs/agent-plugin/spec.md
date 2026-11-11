---
parent: project
---

# agent-plugin — the client-adapter contract

## Problem

bro ships one plugin per client — `plugins/<client>/bro` for claude,
codex, cursor, devin, kilo, omp, opencode, pi. Each grew ad hoc: whatever
that client's marketplace or loader could carry, wired by hand. Nothing
normative says what "the bro plugin is installed" must deliver, so
adapters drift: hook coverage differs silently, a client's vocabulary
leaks into shared code, and a new client means reverse-engineering the
last one. The README install table tells users where to click; nothing
tells maintainers what they must have built.

Second failure mode: agents run with and without bro, globally. A session
in a repo without bro must lose nothing but the nudges — a hook that
fails closed breaks foreign sessions. And the binary a hook resolves is
not always the binary the user is developing: global installs track a
stable line while the dev checkout moves daily. The contract must hold in
both worlds.

## Design

### One portable package

The product is an [Agent Plugin](https://agent-plugins.org/) whose skills
are [Agent Skills](https://agentskills.io/): root `plugin.json` plus
`skills/<name>/SKILL.md`. Those two specs are the contract for every
agent. Claude, Codex, Cursor, Devin, and the rest get only the extra
files that client needs on top — a hook event map, a client manifest, an
extension shim. They do not get a `skills/` tree, a symlink to one, or a
second portable manifest. A client that cannot see `skills/` until the
plugin root is the repo root is installed from the repo root.

### Shared core, client vocabulary

The emitted adapters are generated from `packages/agent-plugins/adapter-core/` —
the core holds bro's mechanics, each client holds only its host's
vocabulary (spec bro-omp-plugin). New clients fold into this direction;
a per-client copy of shared mechanics is a defect, not a shortcut.

### The hook chain — resolution and fail-open

`hooks/run.sh` resolves the bro binary: the checkout's built CLI (local
dist) → `bro` on PATH. No network fallback on the hook path. Always
fail-open: normal candidate failures fall through, deadline exhaustion
stops the chain, the script always exits 0 — nothing may stall or fail
the session.

- `BRO_HOOKS=0` marks a machine-backend tree (the acp provider pins it on
  spawned agents, spec bro-ddksm): session hooks rehydrate and gate for a
  human session that isn't there, so each event is pure deadline cost —
  exit before resolving any binary. Exception: `permission`, whose stdout
  IS the answer (a host denies a beforeShellExecution hook that prints
  nothing, even the self-tools it must allow).
- No-op fast path (spec bro-arm83): post-tool and prompt-submit answer
  "could this event emit or mutate?" from on-disk state and exit 0 when
  every answer is no. Doubt always defers to Node: a wasted spawn beats a
  skipped gate, never the other way round.

### Lifecycle events — the required map

Every adapter maps these events to the host's equivalents or records a
documented gap in its child spec:

| Event | Must do |
| --- | --- |
| session-start | rehydrate state; nudge when another live session armed work in this repo — detection only, never a block |
| pre/post-compact | rehydrate once after compaction |
| prompt-submit | sdd/learn/guard nudges for the session's own claims |
| post-tool | notify drain (mailbox → context); no-op fast path applies |
| stop | the review/work/task/drill gates — gates, not loops: block once, a repeated stop passes |
| permission | stdout is the answer — a denied tool call must never be a silent fail-open |

### Stop-gate connector model

Each contribution is a connector's `stopGate` probe — the hook owns the
arming policy (`bro review act`/`gh pr`/`git push` arm act;
`bro work drill`/`wtf` arm drill; worktree mutations arm work;
`bd --claim`/`bro work enter` arm task — per-session markers in the
common git dir). Connectors only report state; ambient repo state is
passive context for everyone else. Only the session's own armed aspects
block, and only once.

### Install surface — the global question

Two decoupled planes:

- **CLI binary**: `npm i -g @broject/bro` (published, stable, updated
  explicitly) or an npm link to a stable checkout/worktree (pre-release,
  promoted on demand with pull + build). The dev checkout must never be
  the global binary by accident — hooks in foreign repos resolve PATH,
  not the repo that happens to be open in an editor.
- **Plugin**: installed per client from the marketplace. A
  directory-source marketplace registration (pointing at a dev checkout)
  makes the plugin dev-reactive while hooks still resolve the stable PATH
  binary in foreign repos — a supported, documented split, not an
  accident.
- **Zero install**: `npx -y @broject/bro@0` — major-pinned; the hook
  chain never auto-upgrades the major.

### Client capability matrix

| Client | Plugin surface | Install | Child spec |
| --- | --- | --- | --- |
| Claude Code | `hooks.json` + shared `run.sh` | `/plugin marketplace add ThePlenkov/bro` → `/plugin install bro@bro` | [claude](claude.md) |
| Codex | `hooks.json` + `INSTRUCTIONS.md` + `run.sh` | `codex plugin marketplace add ThePlenkov/bro` → `codex plugin add bro@bro` | [codex](codex.md) |
| opencode | `index.ts` / `rpc.ts` / `tui.tsx` extension | `"plugin": ["@broject/bro"]` or `bro clients install opencode` | [opencode](opencode.md) |
| Cursor | hooks in Cursor's schema (`additional_context`, one `followup_message` on stop) | `/add-plugin https://github.com/ThePlenkov/bro`, or symlink `plugins/cursor/bro` to `~/.cursor/plugins/local/bro` | — |
| Devin | plugin via `devin plugins install ThePlenkov/bro` | marketplace | — |
| kilo / pi / omp | generated from the shared core | `bro clients install <client>` / `omp plugin install bro@bro` | — |

Matrix rows without child specs are tracked here until a client carries
capabilities or gaps worth design mass — a child spec exists when the
client's story no longer fits a table row.

### Child specs

- [claude](claude.md) — Claude Code: hook event map, marketplace sources
  (directory vs GitHub), version drift between plugin cache and CLI
- [codex](codex.md) — Codex: marketplace, INSTRUCTIONS.md injection,
  eight-event map including PermissionRequest
- [opencode](opencode.md) — opencode: V2 plugin bus, bro tool namespace,
  RPC push channel, skills via the agents-skills plane

## Verify

- An adapter ships the same skills and lifecycle hooks as every other;
  `bro clients list` reports install state per client and `bro doctor`'s
  plugins row agrees with it. Manifest clients (claude, codex, cursor)
  are probed read-only — marketplace registration plus a version-compared
  cache copy (`installed`/`stale`), no emitted adapter (spec bro-cl1).
- Fail-open holds: any hook invocation with bro absent or broken exits 0
  and the session proceeds — fixtures per event, per client.
- The no-op fast path exits 0 without a Node spawn when nothing can emit
  or mutate (bro-arm83 fixtures).
- Each client's event map covers the required lifecycle table or names
  the gap in its child spec; a gap silently missing from the child spec
  is a conformance defect.
- `check:docs` guards load-bearing quotes the way it guards the
  `act.ignoreChecks` wording — a rotting quote fails the check.
