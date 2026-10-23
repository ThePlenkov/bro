---
parent: bro-5tpx0
---

# bro-arm83 — hooks: shell fast-path for no-op post-tool/prompt-submit

## Problem

`post-tool` fires on every `exec` tool call and `prompt-submit` on
every user prompt. Most of those calls do nothing — no bro command
ran, no mailbox drop waits, no guard targets the event — yet
`hooks/run.sh` resolves a binary and starts Node every time. On this
host that is ~170–300 ms of CLI startup + plugin registration +
connector sweeps per event, paid forever, per tool call.

The sibling bead bro-qbnre measured the lanes and budgeted the
no-op lane; this bead makes the live lane cheap for the common case:
**a hook event with nothing to say exits 0 without starting Node.**

## Design

`hooks/run.sh` gains an event-scoped fast path for `post-tool` and
`prompt-submit` only. When every cheap check says "nothing armed",
the launcher exits 0. Otherwise it falls through to the existing
resolution order (dist → PATH `bro` → pinned `npx`), unchanged.

Correctness rule: the fast path may only *over*-trigger Node, never
under-trigger. Any check that cannot prove quiescence defers to Node.
A false positive costs one spawn; a false negative loses hook
behavior — the asymmetry is deliberate.

### Repo opt-in gate

The hook emit paths only run in repos bro recognizes —
`repoOptedIn` requires a `bro.config.{ts,json}`,
`bro.config.local.{ts,json}`, or `.beads/` reachable by walking up
from the base dir. The shell mirrors that walk first: no marker
found → exit 0 immediately, before any state check. Non-bro git
repos (the overwhelming majority of hook invocations on a host)
therefore never pay even the check cost beyond the walk itself.

### stdin is captured, then re-fed

The launcher reads the host's JSON on stdin. The fast path needs to
inspect it (payload greps, session-id extraction), so for the two
fast-path events `run.sh` reads stdin into `PAYLOAD` once. On fall-
through the captured payload is piped into whichever binary runs —
`printf %s "$PAYLOAD" | node …` — so the hook input contract is
unchanged. All other events leave stdin attached as today.

### What each event's emit path actually reads

`emitPostTool` (hooks.ts): journals the event to the session trace,
fires the throttled OTLP flush, then — on `tool_response.success` —
classifies `tool_input.command` (arming, skill cite, PR nudges), runs
connector `postTool` probes and the guard sweep.

`emitPromptContext`: hydrate leg for Cursor payloads only
(first-prompt session context), connector `promptSubmit` probes
(act's PR-ref line, drill's open-frame line, learn's lesson
injection, sdd's claimed-beads-missing-spec nudge), and the guard
sweep.

The shell check mirrors exactly that state inventory:

#### shared checks (both events)

1. **Foreign-schema payload** → Node. Payloads carrying
   `hook_event_name` / `turn_id` / `workspace_roots` /
   `cursor_version` are Cursor or Codex shaped: they need schema
   translation, the hydrate leg, and `CURSOR_PROJECT_DIR`/
   `workspace_roots` resolution — all logic the shell must not
   reimplement. This runs **before** the opt-in walk: a cursor
   payload names its project in payload fields, so gating on the
   cwd's opt-in would drop real hook work. Devin/Claude payloads
   carry none of these keys and take the fast path.

2. **Mailbox pending** → Node. Both drained dirs are checked:
   `<git-common>/bro/notify` and `$XDG_STATE_HOME/bro/notify`
   (`~/.local/state` fallback — the user mailbox is git-independent
   and still drains even when `git rev-parse` fails). A `*.txt` drop
   counts as pending when it is a regular file, not in the session's
   `.seen-<sid>` cursor, and addressed to us: drops whose content is
   not `{`-JSON, or JSON without `"to"`, deliver broadcast; `to` must
   match a candidate session id, `$BRO_AGENT_ID`, or `orchestrator`
   (when `BRO_AGENT_ID` is unset — the same identity rule
   `mailboxIdentity`/`addressedTo` implement). Expired drops
   (name-embedded epoch-ms > 1 h) are residue — the drain would reap
   them, not deliver them, so they do not force a spawn.

3. **Lessons possibly live** → Node. Learn's probes inject only when
   the store has lessons, and the probe itself is the expensive part
   (`bd kv list` spawn). The cheap proxy uses the cache learn already
   maintains: `<git-common>/bro/hooks/cache/lessons.json`, whose
   `"stamp"` field carries `beadsStoreStamp()`
   (`<beads>|<root>/<db>:<mtimeMs>:<size>|…`). The shell re-verifies
   that stamp against live `stat` — store path ∈ the discovered
   `.beads` set, size exact, mtime within 1 s — so a snapshot from
   another `BEADS_DIR` or an older manifest set can't pass for fresh.
   A non-empty `"lessons"` array → Node; a missing stamp field, a
   stat miss, or a store with no manifest → Node. Beads dirs
   checked: `$BEADS_DIR` (agent spawns pin it), `dirname(<git-common>)/.beads`
   (what `beadsDir()` resolves), and every `.beads` found walking up
   from the base dir (what `bd`'s own discovery would find for
   `listLessons`). A config opt-out (`learn` section with
   `enabled:false`) skips the store scan — `grep` can prove the
   disable, it cannot prove enablement, so anything ambiguous defers.

4. **Guard defs for this event** → Node. Node writes the authoritative
   *coverage* record — config greps cannot see connector-contributed
   `guards()` nor defs a `bro.config.ts` computes. `runGuards` returns
   `coverage: { events, complete }` alongside the verdicts; `complete`
   is false when any connector `guards()` probe or def parse failed.
   On every `guardLines()` call the hook records the collected event
   set into `<git-common>/bro/hooks/guards/` — but only when coverage
   is complete:

   - `<event>` exists ⇔ at least one collected def targets that event
     (files written first, then `.stamp`, deletes last — a partial
     read can only defer to Node, never skip),
   - `.stamp` is the freshness anchor; incomplete coverage writes
     nothing, so the next call sees no stamp and defers.

   Incomplete coverage removes `.stamp` — a stale record must never
   masquerade as current after a failed collection.

   `coverage.trace` marks any def declaring `when.match` — match
   clauses read the journaled trace tail, so while one exists
   post-tool must still reach Node to keep the journal complete.
   Recorded as `guards/.trace`.

   Shell rule: `.stamp` absent → Node (never computed, or last
   collection was partial); any config file newer than `.stamp` →
   Node (defs may have changed); `guards/<event>` present → Node;
   `guards/.trace` + post-tool → Node. A `guard.enabled:false`
   config yields an empty event set — the stamp still lands, so
   guard-off repos keep the fast path; flipping it back makes
   config newer than the stamp and Node recomputes.

   Config files considered (mirroring `loadConfigLayers`): the base
   dir and `dirname(<git-common>)` (the main worktree root a linked
   worktree shares) for `bro.config.{ts,json}` and
   `bro.config.local.{ts,json}`, plus `$XDG_CONFIG_HOME/bro/config.{ts,json}`
   (`~/.config` fallback) — the layers whose `guard.defs` the engine
   merges.

5. **Telemetry configured** (post-tool only) → Node.
   `maybeSpawnTraceFlush` can spawn an OTLP export when
   `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
   is set, `BRO_TELEMETRY` is not `0`, or a `telemetry`/`otlp` token
   appears in config. (`prompt-submit` never calls the flush.)

#### post-tool-only checks

6. **Mutating command in payload** → Node. One `grep -E` superset of
   `classifyArmCommands` ∪ `classifySkillMutation` ∪
   `classifyExecCommand`: `bro`/`npx … bro` near any mutating
   subcommand (`act|drill|wtf|work|retrospect|debt|convoy|spec|next|loop|sync|unwind`),
   `gh` near `pr`, `git` near `push|worktree`, `bd` near
   `--claim|worktree`. No quote-stripping or command-position proof —
   a string that merely *contains* the tokens goes to Node, where the
   real classifiers decide. False positives are the safe direction.

7. **Orchestrator want-markers** → Node, only when `BRO_AGENT_ID` is
   unset (the same `isOrchestratorSession` guard the connectors use):
   `<git-common>/bro/pulse.json`, `rig-pulse.json`, or `drive.json`
   mean a checkpoint probe could rearm a dead pulse/supervisor — that
   spawn must not be skipped.

#### prompt-submit-only checks

8. **PR reference in the prompt** → Node: `pull/[0-9]` or
   `merge_requests/[0-9]` — the superset of both review hosts'
   `parsePrRef`.

9. **Open drill frame** → Node: the drill connector's own
   `drills.json` snapshot in `<git-common>/bro/hooks/cache/` is the
   proxy — `"frame":null` is the only "no frame" proof; a missing or
   store-stale snapshot defers. Snapshot-keyed coverage (unlike
   `.drill` markers) also sees frames opened outside hooked sessions.

10. **SDD claims** → Node: `sdd` token in any config file AND either
    a `<sid>.task` marker for any extracted session id, a `.task`
    marker owned by this session's agent-root pid (mirroring
    `procAgentRoot`/`markerOwner` — a same-tree worker's claim folds
    to the session even when the marker carries a stale sid), or
    `BRO_BEAD_ID`/`BRO_BEAD_IDS` in the env — the nudge only applies
    to sessions holding a claim. `sdd` absent from config means the
    mode is `off` and the nudge cannot fire. An agent-shaped process
    whose root pid cannot be proven defers on any `.task` marker.

### What is deliberately not checked

- **Session aspect markers on post-tool.** `emitPostTool` never calls
  `readArmed`/`sessionTaskClaims` — markers feed stop/session-start/
  sdd/learn only, and each of those is either not fast-pathed or has
  its own trigger above. A blanket "any marker → Node" would pin the
  slow path on every session that ever armed an aspect (7-day TTL),
  defeating the bead's purpose. The arming *moment* is caught by the
  payload grep — that is the only post-tool interaction with markers.
- **Trace/perf journaling** is skipped on the fast path: the journals
  are best-effort evidence for engaged sessions; a no-op event has
  nothing to evidence, and an unbounded append the shell cannot trim
  (256 KB cap lives in Node) would trade latency for silent growth.
- **`git rev-parse` failure** skips only the git-state checks — the
  user mailbox and payload greps still run. Marker/mailbox/lesson
  state cannot exist where git cannot resolve a common dir, and
  Node's own `hooksDir`/`mailboxDir`/`beadsDir` return null in the
  same situation — identical blind spots.
- **`pre-tool`, `stop`, `session-start`, `permission`,
  `post-compaction`, git-hook events**: untouched. `permission`
  especially must never short-circuit — its stdout *is* the answer.

### Base dir

Non-Cursor hosts use `hookProjectDir` = `$DEVIN_PROJECT_DIR` or cwd —
the fast path uses the same base (`${DEVIN_PROJECT_DIR:-$PWD}`) for
the git/common-dir lookup and the config scan.

### Fail-open invariants

Every check is wrapped in "unreadable ⇒ the conservative answer":
missing dirs, malformed payloads, missing `git`, permission errors —
all resolve toward spawning Node or, where Node is provably also
blind (no common dir ⇒ no git-dir state), skipping the check.
`run.sh` still always exits 0, and `BRO_HOOKS=0` still exits first —
permission excepted, exactly as before.

## Verify

- **Unit** (`hooks.test.ts`): `recordGuardEvents` writes a file per
  covered event plus `.stamp` when coverage is complete, prunes stale
  event files, and writes nothing when coverage is incomplete.
- **e2e** (`hooks.e2e.test.ts`): a fake `node` earlier on PATH writes
  a canary — run.sh resolves it first (`command -v node` +
  `$DIR/packages/cli/dist/index.js` both exist in this checkout):
  - no-op `post-tool` and `prompt-submit` payloads → canary absent,
    exit 0, empty stdout;
  - a mutating payload (`bro work enter fx-9`), a pending mailbox
    drop, a `guards/post-tool` file, a missing `.stamp`, a non-null
    `drills.json` frame + `sdd` config + `.task` marker on
    `prompt-submit` → canary present (Node reached);
  - `permission` → always reaches Node;
  - a non-git dir and garbage stdin → exit 0 (fail-open);
  - armed-marker coverage: `.task` marker for the payload's session +
    `sdd` in config → prompt-submit reaches Node.
- **Bench**: `time`-loop over `sh hooks/run.sh post-tool` in a
  **primed** quiet fixture — a real `post-tool` run first (writes
  `guards/.stamp`), then 60 iterations of a session-bearing payload
  (`{"session_id":"s1","tool_input":{"command":"ls"},…}`) with node
  absent from PATH. `</dev/null` alone doesn't exercise the lane —
  a sid-less payload defers by design. No-op p50 < 50 ms (E1); this
  PR measures p50 ≈ 10 ms / p95 ≈ 30 ms.
- `sh -n hooks/run.sh`, `npm test` (the repo's real CI command).

## Known gaps (accepted, documented)

- A drill frame opened **outside any hooked session** is covered by
  the `drills.json` snapshot the connector refreshes — but only once
  any hooked event has run since the store changed; before that, a
  stale-or-missing snapshot defers to Node anyway, so the miss window
  is the store stamp check itself, not the marker TTL.
- `learn.enabled:false` is recognized only as an opt-out grep; any
  other `learn` config presence defers to Node.
- An `sdd` token in config over-triggers prompt-submit for sessions
  without claims — bounded (prompts are per-user-turn, not per-tool).
- `BRO_AGENT_ID`-addressed drops whose JSON `"to"` is string-shaped
  unusually (nested quoting) resolve toward Node — always the safe
  side.
