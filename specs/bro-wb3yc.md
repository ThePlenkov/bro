---
scope:
  - specs/bro-wb3yc.md
  - skills/watch/SKILL.md
  - skills/pulse/SKILL.md
  - skills/drive/SKILL.md
  - skills/daemon/SKILL.md
  - skills/rig/SKILL.md
  - skills/act/SKILL.md
  - skills/resume/SKILL.md
  - skills/loop/SKILL.md
  - skills/watchdog/SKILL.md
---

# bro-wb3yc — supervision: collapse the heartbeat family to daemon (owner) + pulse (wake) + rig next (re-entry)

## Problem

Seven liveness mechanisms overlap. An agent that wants "keep an eye on
this" picks among `bro review watch --every`, `bro review watch install`,
`bro pulse`, `bro review drive --every` / `bro review drive install`,
`bro fleet daemon`, `bro fleet rig watch` / `bro fleet rig install`, and
`bro review act wait --detach` / `bro review act rearm` — and that is
before the fourth spelling of every want-marker (`pulse.json`,
`rig-pulse.json`, `drive.json`, `loop.json`), each with its own lock,
spawn record, and hook checkpoint. 45 non-test source files mention
`heartbeat` (23 when the architecture review counted); the word covers
three different things (a lock's liveness hold, the durable
`heartbeat.json` snapshot, a supervisor's per-PR watch marker).

The seams are where the supervision bugs live:

- **bro-dkw3e** — `bro watch` in a worktree tripped drive's `/proc`
  occupancy scan, so the PR read `occupied` and the fixer never spawned:
  an *observer* was counted as an *owner*.
- **bro-ihnlv** — `green-occupied` had no TTL: a green PR waited forever
  on a dead/silent owner because every liveness proof (marker, registry
  entry, `/proc` hit) fed the same occupied verdict.

Agents pick wrong mechanisms because the surface has no roles — every
command presents itself as a peer. Source: architecture review
2026-10-16 (the bead's parent, bro-killn, already retired the OS-timer
shape; this is the command-surface half of the same collapse).

## Inventory

Roles: **owner** = a long-lived process that owns work lifecycle;
**wake** = delivers an event to a session mid-turn; **re-entry** =
recomputes what to do from durable state after a death; **observer** =
a bounded read-only watch; **pass** = the work itself, one run.

| Mechanism | Surface | Role today | State files under `<git-common>/bro/` | Users | Overlaps |
| --- | --- | --- | --- | --- | --- |
| watch snapshot | `bro review watch [--once]` | observer | `heartbeat.json` per tick | sessions, watchdogs, `pulse`'s tick, serve `/ticks` | — |
| watch window | `bro review watch --every N --for S [--notify]` | observer + wake fallback | `pulse.lock`, `heartbeat.json`, mailbox drops | checkpoint-respawned unattended leg; sessions before `bro pulse` existed | `bro pulse` — same lock, same tick, same marker; `rig watch` — same loop shape |
| watch install | `bro review watch install\|uninstall` | arm/disarm the wake want | `pulse.json` want-marker | operators; `--print` plans | `bro pulse` start also arms `pulse.json`; `rig install`/`drive install`/`loop install` — same verb ×4 |
| pulse | `bro pulse [S] [-- <cmd>…]` | **wake** | `pulse.lock` (mailer role only), `pulse.json`, mailbox drops | orchestrator sessions | `watch --every --for` — the same cadence's unattended leg |
| drive pass | `bro review drive [--once]` | pass | — (per-PR `watches/<pr>-drive-<pid>.json` heartbeat markers while running) | sessions, pulse-tick policy, `daemon run` | — |
| drive loop | `bro review drive --every N` | **owner** | `drive.lock` heartbeated hold | `daemon run` (it IS the owner loop); hand-rolled supervisors | `daemon` — `daemon run` invokes this loop in-process; a raw `--every` is an unrecorded owner |
| drive install | `bro review drive install\|uninstall` | arm the owner want | `drive.json` want-marker → `daemon run` | operators | `daemon up` + marker = the same outcome; `loop install`, `rig install`, `watch install` — same verb shape |
| daemon | `bro fleet daemon up\|status\|down\|run` | **owner** | `drive.lock`/`loop.lock`, `daemon.json`/`daemon-loop.json` armer record, `daemon.up.lock`, `daemon.log` | operators, `drive install`, `loop install`, connectors, `fleet resume` | `drive --every`/`loop --every` raw spellings; `rig watch` — a third always-on cadence outside it |
| rig sync/status | `bro fleet rig sync`, `bro fleet rig status` | pass + read | `post-merge.done` freshness record | operators, `rig watch` ticks | — |
| rig next | `bro fleet rig next [<item>]` | **re-entry** | reads beads/claims/registry/worktrees/forge — writes nothing | sessions re-entering work; drive's fixer-spawn ladder | `bro flow next` — same verb name, different plane (backlog claim); `act rearm`/`fleet resume`/checkpoints — bespoke re-entry paths |
| rig watch | `bro fleet rig watch --every N [--for S]` | **owner** (freshness cadence) | `rig-pulse.lock` heartbeated hold | operators; checkpoint-respawned windows | a whole second pulse stack — `rig-pulse.json` + `.lock` + `.spawn.json` + `rigConnector` duplicate the watch-pulse machinery; `daemon` — an always-on cadence not owned by it |
| rig install | `bro fleet rig install\|uninstall` | arm the rig-pulse want | `rig-pulse.json` want-marker | operators | `watch install` — same verb on a second marker stack |
| loop cadence | `bro flow loop --every S` | **owner** (work loop) | `loop.lock` heartbeated hold | `daemon run --loop`; hand-rolled supervisors | `daemon` — same story as `drive --every` |
| loop install | `bro flow loop install\|uninstall` | arm the owner want | `loop.json` want-marker → `daemon run --loop` | operators | `drive install` — identical shape on a second plane |
| act wait | `bro review act wait [PR] [--detach] [--merge] [--cleanup] [--bead]` | observer (bounded, per-PR — but `--merge`/`--cleanup`/`--bead` act on settle) | `watches/<pr>-<pid>-<nonce>.json` markers, `act-wait-<pr>.log` | sessions, convoy/loop arming, `fleet resume` re-entry | `watch --every` — bounded-observer family; `--detach` is a self-detach the daemon could own |
| act rearm | `bro review act rearm` | **re-entry** executor | resurrects dead `watches/` markers | session-start nudge, `fleet resume` | `rig next` — its verdict ladder does not cover dead wait markers today, so this re-entry path is bespoke |
| fleet resume | `bro fleet resume` | re-entry runbook | reads every marker/record, respawns dead waits + daemon | operators post-restart | `act rearm` (its watch leg), the connectors' checkpoints, `rig next` |
| dep wait | `bro wait external:<rig>:<id>` | observer (bounded, dep plane) | — | sessions between turns | `act wait` — same bounded-watcher contract on a different plane |

Shared primitives (stay — they are mechanics, not mechanisms):
`want-marker.ts` (`pulse.json`/`rig-pulse.json`/`drive.json`/`loop.json`),
`watch-pulse.ts` + `rig-pulse.ts` + `drive-pulse.ts` + `loop-pulse.ts`
(marker → lock → spawn-record → connector checkpoint, the same shape
four times), `pending-watch.ts` (`watches/` markers +
`watchHeartbeat`), `watch-heartbeat.ts` (`heartbeat.json` + readers in
`status`, `serve`, `hooks`, `webui`), `filelock.ts` heartbeated holds,
`janitor.ts` reap per watch tick.

## Target architecture

Three liveness mechanisms, one role each; everything else is a pass, a
read, an observer, or a policy alias over these:

```text
owner      bro fleet daemon up|status|down|run     the ONLY long-lived
                                                 process owner — every
                                                 cadence is a daemon leg
wake       bro pulse [S]                           the ONLY session wake —
                                                 the mailbox beat
re-entry   bro fleet rig next [<item>]             the ONLY re-entry
                                                 verdict — durable state
                                                 → step|gate|wait|done|blocked
```

The bounded observers stay observers — no ownership of work, never a
cadence:

- `bro review watch [--once]` — the snapshot; `--every N --for S` is the
  same observer on a bounded window, and doubles as the checkpoint's
  spawned fallback leg when no session's pulse holds `pulse.lock`. Its
  tick is not side-effect-free: it rewrites `heartbeat.json` and runs
  the janitor (reaps dead residue — retention, not workflow).
- `bro review act wait [PR]` — the bounded observer over one PR's gate;
  armed with `--merge`/`--cleanup`/`--bead` it also acts on settle
  (merges, retires the worktree, closes the bead) — an observer whose
  bounded verdict is the merge mechanism, still never a cadence owner.
- `bro wait external:<rig>:<id>` — the bounded observer over a dep edge.

Passes stay passes: `bro review drive --once`, `bro fleet rig sync`,
`bro flow loop` (one iteration), `bro fleet rig status`, `bro status`.

Everything a cadence owns is a **daemon leg**: `daemon run` already IS
`drive --every` in-process and `daemon run --loop` IS `loop --every`; the
rig freshness cadence migrates to the same shape (follow-up bead). A raw
`--every` typed by hand is an unrecorded owner — the daemon's
`supervisionProcs` sweep already hunts the drive/loop spellings for
`down` (the rig-pulse stack keeps its own `rig-pulse.lock` and is
outside that sweep until its migration bead); the surface stops
advertising them.

Intent survives as **want-markers the daemon plane reads** —
`drive.json`/`loop.json` today, `pulse.json` for the wake. One marker
shape (`want-marker.ts`), one rearm contract (armed marker + dead owner
→ checkpoint spawns the leg). The rig pulse's second marker stack
(`rig-pulse.*`) folds into this — either as a daemon leg marker or by
`rig next` driving freshness as a verdict, decided by its migration
bead.

Re-entry is **one verb**: `rig next`. `act rearm`, `fleet resume`, and
the four connector checkpoints are all re-entry paths today; the
migration plan makes the dead-wait-marker plane a `rig next` verdict
input so `act rearm`/`fleet resume` become executors the verdict names,
not parallel ladders.

## Per-command fate

| Surface | Fate | Detail |
| --- | --- | --- |
| `bro review watch [--once]` | keep — canonical | the bounded observer's single tick |
| `bro review watch --every N --for S [--notify]` | keep — observer + pulse fallback | document as the spawned fallback leg of `bro pulse`, never a session-facing arming verb; skills stop presenting it as the way to watch |
| `bro review watch install\|uninstall` | keep — policy alias | arms `pulse.json` = the wake's want; document as "arm/disarm the wake". A later spelling may move under `pulse`; no `deprecated:` yet — the arm verb is still live |
| `bro pulse [S]` | keep — canonical | the only session wake |
| `bro review drive [--once]` | keep — canonical | the pass |
| `bro review drive --every N` | deprecate → `bro fleet daemon up` | identical loop, unrecorded owner — `daemon up` is the operator spelling (`daemon run` is the internal leg `up` spawns, not for direct use). Deprecation is flag-level (`deprecatedFlag`/`deprecatedSub`), NOT plugin-level: `daemon run` calls `runDriveCommand(['--every'])` in-process, so the warning must be gated on entry argv (or daemon passes a hidden spawn marker). Follow-up bead owns the seam |
| `bro review drive install\|uninstall` | keep — policy alias of daemon install | "install the merge path" = arm `drive.json` + `daemon up`; docs name the owner, not a separate mechanism |
| `bro fleet daemon up\|status\|down\|run` | keep — canonical | the only owner |
| `bro fleet rig sync\|status` | keep — canonical | pass + read |
| `bro fleet rig next` | keep — canonical | the only re-entry verdict; `bro flow next` stays the backlog-claim verb — the spec only rules on `rig next` being THE re-entry |
| `bro fleet rig watch` | deprecate → daemon leg | migration bead picks `daemon run --rig` vs a `rig next`-driven freshness verdict; the `rig-pulse.*` marker stack retires with it |
| `bro fleet rig install\|uninstall` | deprecate → owner policy | freshness intent becomes a daemon/config policy row, not a second pulse stack |
| `bro flow loop --every S` | deprecate → `bro fleet daemon up --loop` | same `daemon run` aliasing question as `drive --every` — one migration bead covers both raw `--every` spellings; `daemon up --loop` spawns `daemon run --loop`, the owned shape |
| `bro flow loop install\|uninstall` | keep — policy alias of daemon install | same as `drive install` |
| `bro review act wait [PR] --detach` | keep — canonical observer | the bounded per-PR watch; `--detach` is its documented survival form |
| `bro review act rearm` | keep — re-entry executor | stays the resurrection executor; `rig next` gains the dead-marker plane so rearm is what the verdict invokes, not a parallel re-entry ladder |
| `bro fleet resume` | keep — recovery runbook | documented as orchestrated re-entry (the operator-facing pass over `rig next` + rearm executors), not a fourth mechanism |
| `bro wait external:<rig>:<id>` | keep — canonical observer | bounded dep-plane watch |
| `bro fleet serve` | out of scope | the UI surface — a long-lived process but not supervision |
| `bro flow watchdog` | out of scope | prints the launch brief; the loop is model work (the skill's chained subagent ticks) |

## Deprecation plan

`deprecated:`/`flatDeprecated:` (the `BroPlugin` registry fields,
spec bro-vlmrb.3 / `packages/command/src/plugin.ts`) act on **whole
plugin spellings** — `bro oldcmd`, not `bro drive --every`. Every
deprecation this spec orders is **sub-command level** (a flag or a
verb inside a live plugin), so plugin-level `deprecated:` applies to
none of them. The mechanics that DO apply:

- `deprecatedFlag(argv, name, advice)` (`@broject/core` cli-args) — the
  existing one-shot stderr warn for a retiring flag. Fits `--every` on
  `drive`/`loop` once the `daemon run` in-process call is excluded
  (entry-argv gate or a hidden `--spawned` marker — the migration
  bead's seam).
- Verb-level (`rig watch`, `rig install`) has no helper yet — the
  migration bead adds either `deprecatedSub(argv, verb, advice)` beside
  `deprecatedFlag`, or a plain `console.error` warning inside
  `cmdWatch`/`cmdInstall`. Both are inside the command, never the
  registry.
- Whole-spelling retirement stays available for later: if a command
  like `rig watch` ever becomes its own plugin alias it can ride
  `deprecated:`/`aliasOf` then.

Order (each is a follow-up bead — this PR ships the spec + skills only):

1. **Raw `--every` spellings** (`bro review drive --every`,
   `bro flow loop --every`) → warn toward `bro fleet daemon run|up`;
   `daemon run`'s in-process calls exempted. Docs/skills first, flag
   warn behind it.
2. **Rig pulse stack** (`bro fleet rig watch`, `bro fleet rig
   install|uninstall`, `rig-pulse.json|.lock|.spawn.json`,
   `rigConnector`) → daemon leg or `rig next` verdict; marker migration
   reads an existing `rig-pulse.json` once, then removes the stack.
3. **Re-entry convergence** (`act rearm`, `fleet resume`, the four
   connector checkpoints) → `rig next` verdict inputs: dead `watches/`
   markers and armed want-markers become verdict legs; executors stay.
4. **Arm-verb convergence** (`watch install` vs `pulse`'s implicit arm
   vs `drive install` vs `loop install`) → one documented arm contract:
   `install` = arm the want + bring the owner up now; each plane keeps
   its verb as a policy alias.

## Follow-up beads

Filed as children of this bead (see the bead tree):

- `bro-wb3yc.1` — deprecate raw `drive --every`/`loop --every` toward
  `daemon run` (in-process exemption seam).
- `bro-wb3yc.2` — migrate the rig freshness cadence (`rig watch`,
  `rig install`, `rig-pulse.*`) to a daemon leg or `rig next` verdict.
- `bro-wb3yc.3` — `rig next` gains the dead-`watches/` + armed-marker
  planes; `act rearm`/`fleet resume`/connectors become its executors.
- `bro-wb3yc.4` — converge the four `install` arm verbs on one contract;
  document `install` = arm want-marker + `daemon up`.
- `bro-wb3yc.5` — heartbeat terminology cleanup: the word means lock
  liveness / `heartbeat.json` / watch markers today; name them in code
  comments + docs (no renames required, one vocabulary).

## Verify

- This file lands with the mapping table and per-command fate; the
  follow-up beads exist as children.
- `npm run check:docs`, `npm run check:command-docs`, `npm run
  check:plugins` pass — skills and help text name ≤3 liveness
  mechanisms (daemon, pulse, rig next) wherever they discuss
  supervision; `watch`/`act wait`/`wait` are named observers.
- No mechanism is removed or gated in this slice: inventory, mapping,
  plan, beads, skill wording only.
