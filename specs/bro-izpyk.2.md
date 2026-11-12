# bro-izpyk.2 — fleet F2: session modes, `bro mode`, connector `activeIn`, Tier-1 snapshots

Child of bro-izpyk (epic contract `specs/sessions/bro-izpyk.md` on branch
`devin/1792972271-fleet-spec`, PR <https://github.com/ThePlenkov/bro/pull/700>).
F1 landed the ledger, spool, `bro sessions`/`bro fleet hosts` and doctor rows
(PRs <https://github.com/ThePlenkov/bro/pull/1006>,
<https://github.com/ThePlenkov/bro/pull/1017>,
<https://github.com/ThePlenkov/bro/pull/1019>). This bead adds the mode plane:
`observe` is the default, `plan|code|review|orchestrate` opt a session into
bro's active behavior, and every hook pays the cheap path unless a mode says
otherwise.

## Vocabulary (from the epic spec)

- `observe` — passive. Ledger/spool keep recording (F1 visibility), inbox
  delivery stays on, `preTool` safety vetoes and guards the user explicitly
  declared still apply where cheap; no rehydration, no parallel-work nudges,
  no goal/heartbeat context, no armed-work stop gates, no connector probes
  that are not `activeIn`-declared for `observe`.
- `plan` — rehydration + ready tasks + specs/plan context; planning surface.
- `code` — today's full interactive behavior (arming, gates, nudges, beads,
  worktree, sdd, pulses' supervisor rearm).
- `review` — act gate, threads and PR context (act, debt).
- `orchestrate` — supervisor duties on top of `code` (drive/resume/convoy
  dispatch; pulses).

One mode per session. `observe` is implicit: a missing or unreadable mode
file resolves to `observe`, and `observe` itself never creates a file unless
the operator or `modes.default` wrote one.

## Mode files — the hook-time truth

`$XDG_STATE_HOME/bro/sessions/<host>-<sid>.mode` (fallback
`~/.local/state/bro/sessions/`). Line 1 is the mode; `bro mode` also writes
line 2 as the project id for humans/debugging (readers ignore it).

- `<host>` is the agent product (`claude|codex|cursor|devin|unknown`),
  `<sid>` the host-native session id with `[A-Za-z0-9_.-]` kept and every
  other byte folded to `_` — same safe-name rule the spool uses, so a hostile
  id cannot escape the directory.
- Missing file → `observe`. Malformed/invalid content → `observe`
  (fail-open: a corrupt mode file must never break a host hook).
- `bro mode off` is the explicit spelling of `observe` — it writes an
  `observe` file so the session stays passive even when `modes.default`
  names an active mode. `bro mode clear` removes the file entirely, so the
  session falls back to `modes.default`/`observe`.
- Files are written atomically (tmp + rename) by every writer.

## `bro mode`

```text
bro mode [--session <sid>] [--host <h>] [--json]        # effective mode + source
bro mode <observe|plan|code|review|orchestrate|off> [--session <sid>] [--host <h>]
bro mode list [--json]
bro mode clear [--session <sid>] [--host <h>]
bro mode render [--mode <m>]
```

- Session resolution: `--session`/`--host` flags win; otherwise the session
  env ids (`BRO_SESSION_ID`, `DEVIN_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION_ID`) and host
  detection from the plugin-root/project-dir env the run.sh spool uses.
  No resolvable session → usage error naming the flags.
- `bro mode <name>` run inside an agent shell may not see session env; the
  post-tool hook binds `bro mode <name>` commands to the calling session
  (see hooks.ts). The CLI prints the binding path when env resolution fails
  and exits 0 — the hook does the write on that same tool call's post-tool.
- Every set/clear writes the mode file AND `LedgerFacade.setMode` (the F1
  ledger column stays a faithful projection; `bro sessions` overlays live
  mode files so display is always honest).
- `bro mode list` unions mode files on disk with ledger session rows
  (file mode wins, ledger-only rows show their stored mode + `ledger`
  source). `--json` emits the same rows.
- `bro mode render` renders Tier-1 snapshots for the current project (all
  active modes, or `--mode`).

## `modes.default` — project policy

New config section `modes` (`policy` layer): `{ default?: Mode }`. Effective
mode resolution is **mode file > `modes.default` > `observe`**. The section
is absent-by-default (`DEFAULT_CONFIG.modes = {}`), so a project that never
opts in pays zero config cost. `bro.config.json` example:

```json
{ "modes": { "default": "code" } }
```

When a hook resolves a session with no mode file and `modes.default` is
set, hooks.js materializes the mode file (sync write; the ledger row is a
best-effort `setMode`) so the cheap Tier-0 check keeps working without a
config probe on every event. With no `modes.default`, nothing is written —
`observe` stays implicit.

## Connector `activeIn`

`Connector` gains `activeIn?: Partial<Record<keyof ConnectorHooks, readonly
Mode[]>>` — the modes in which each probe kind may run. `ConnectorCtx` gains
`mode?: Mode` (undefined = unrestricted, preserving library callers like the
acp proxy). Every collector (`sessionStartProbe`, `parallelWorkProbe`,
`promptContextLines`, `postToolLines`, `preToolVerdicts`,
`stopGateContributions`, `taskFinishProbes`) filters `hooks()` results
through `connectorHookActive(connector, kind, ctx.mode)` before running the
probe — fail-open per connector and per probe as today.

Assignments (the spec's mode table):

| connector | probes gated | modes |
| --- | --- | --- |
| beads | sessionStart (ready), parallelWork, stopGate | plan,code,review,orchestrate / code,orchestrate / code,orchestrate |
| act | sessionStart, promptSubmit, stopGate | code,review,orchestrate |
| debt | sessionStart | code,review,orchestrate |
| drill | sessionStart, promptSubmit, stopGate | code,orchestrate |
| learn | sessionStart, promptSubmit | plan,code,review,orchestrate (postTool stays all-modes: trace journal + lesson match are passive learning) |
| notify | — | all (inbox delivery is spec-explicit in every mode) |
| work | sessionStart, parallelWork, stopGate | code,orchestrate |
| sdd | sessionStart, promptSubmit, stopGate | plan,code |
| session-cap | — | all (safety veto) |
| herdr | — | all |
| pulses (watch/drive/loop/rig) | sessionStart, postTool | code,orchestrate (supervisor rearm stays with the code+ planes so `modes.default: code` restores today's behavior) |

`observe` sessions therefore run only notify drains, session-cap vetoes,
learn post-tool, and herdr task-finish — everything else is filtered before
its probe executes.

## Hook pipeline gating (hooks.ts)

`runHooksCommand` resolves the session mode once per invocation
(`resolveSessionMode`: file > `modes.default` > `observe`, plus
materialization) and stashes it in `hookMode`; `hookCtx` passes it to every
collector. Per event:

- `session-start`/`post-compaction`/`pre-compact`: `observe` → no
  rehydration except `sessionStartProbe`'s `activeIn`-filtered lines (notify
  drains still deliver inbox). Non-observe → Tier-1 snapshot short-circuit
  (below) then live probes.
- `prompt-submit`/`post-tool`: `observe` → only `activeIn`-filtered probes
  - trace journal/flush + `bro mode` command binding; no arming, nudges,
  skill-mutation classify, or guard sweep. Non-observe → full pipeline.
- `pre-tool`: verdicts filtered by `activeIn`; `observe` adds nothing —
  `session-cap` stays live in every mode.
- `stop`: `observe` → no goal, no stop gates, no guards (flush still
  fires). Non-observe → full gate stack.
- `permission`: unchanged in Node; `observe` is answered in run.sh Tier-0
  (below).
- Guards (`guardLines`) return `[]` in `observe` — user-declared guards are
  active behavior; `observe` is fully passive. (`preTool`/`permission` have
  no guard events anyway.)

`bro mode <name>` typed into an agent session binds via the post-tool hook:
`bindModeCommand` parses the tool command conservatively (single `bro mode`
invocation, no `--session`/`--host` — explicit flags mean the CLI already
bound it), writes the mode file and `setMode`s the ledger.

## Tier-0 (`hooks/run.sh`)

After `hook_spool_start`, for session events with a resolved
`HOOK_SPOOL_HOST`/`HOOK_SPOOL_SID`, run.sh computes
`$XDG_STATE_HOME/bro/sessions/<host>-<sid>.mode` (sid sanitized like the
spool's) and reads line 1:

- file says `observe` (or is invalid) → **observe path**:
  - `post-tool`/`prompt-submit`: today's could-emit fast path, plus a
    `bro mode` invocation in `tool_input.command` and a non-empty
    `inbox/<host>-<sid>` file both force Node.
  - `session-start`/`post-compaction`/`pre-compact`/`stop`:
    `hook_spool_end 0 fastpath; cursor_permission_ask; exit 0` — no Node at
    all (a non-empty `inbox/<host>-<sid>` or a pending user-level notify
    mailbox also falls through to Node).
  - `pre-tool`: NOT early-exited — it reaches Node in every resolved
    mode so `activeIn`-filtered safety vetoes (session-cap) stay live,
    per the hook-pipeline section below.
  - `permission`: `permission_shell_answer` — extracts the command from the
    payload, applies the same conservative self-tool test the Node path
    uses (`bro`/`bd`/`npx bro…`, no shell metacharacters, no `-p`/
    `--package` override), emits the per-host approve shape
    (`{"permission":"allow"}` cursor, `{"decision":"approve"}`
    claude-vocab, codex
    `hookSpecificOutput…decision.behavior:"allow"`); anything else gets
    `cursor_permission_ask` for cursor and silence elsewhere — identical
    to today's non-match outcome. Trade-off: the session-cap refusal the
    Node permission path carries for pre-tool-less hosts (devin) does
    not run for observe sessions — observe is passive by definition and
    pre-tool-capable hosts still enforce the cap on their pre-tool event.
- file says an active mode → **active path**: all session events dispatch
  to Node (the fast-path `could-emit` checks are skipped — `NEED_NODE=1`).
- no file → cheap `modes` probe: the four `bro.config.*`/`bro.config.local.*`
  names in the session dir plus the linked-worktree main root (`.git` file
  parse, no git call) plus the two global config files; any containing the
  word `modes` → Node (hooks.js resolves + materializes). Otherwise observe.
- sid-less or host-unresolvable events keep today's behavior (unrestricted).

## Tier-1 snapshots

`snapshots/<projectId>/<mode>/<event>.txt` under the same state dir, where
`projectId` is `projectId(dir)` from core (remote-hash or git-common
realpath — worktrees fold), `mode` the resolved mode, and `event` one of
`session-start`, `post-compaction`, `pre-compact`. Content is the
`additionalContext` text (the `sessionStartProbe` line set, `\n`-joined);
hooks.js wraps it in the same `bro state — resume from here:` envelope the
live path uses. A sibling `.stamp` file's mtime is the freshness anchor
(TTL 5 min); an existing-but-empty snapshot is a valid "nothing to say"
answer, not a miss.

- Rendered by `renderModeSnapshots(dir, mode)` — runs `sessionStartProbe`
  once with `sessionId: ''` (session-scoped probes self-disable) and
  `ctx.mode` set, so `activeIn` filters identically to a live session.
  Writes all three event files + stamp. Side-effecting probes (pulse
  checkpoints) run only for modes that declare them.
- Consumed inside `rehydrateLines`: on a fresh snapshot hit the
  `sessionStartProbe` leg is replaced by the snapshot text; the
  session-scoped remainder (parallel-work nudge, goal, heartbeat) still
  runs live. On miss/stale, live probes run and a throttled detached
  `node <hooks.js> snapshot-render --dir … --mode …` re-renders for next
  time (60 s spawn throttle via a cursor file).
- `bro mode <name>` renders snapshots for the session's project+mode
  inline (best-effort); `bro mode render` does it on demand.

## What this bead does NOT do (scope split)

- F3 (bro-izpyk.3): claims migration, `orchestrate` exclusivity enforcement,
  heartbeat claims, `isOrchestratorSession` removal.
- F4 (bro-izpyk.4): inbox rendering/delivery beyond the Tier-0 `[ -s ]`
  wake, `bro msg`, `bro sessions resume`, tasks.
- No `bro fleet worker` daemon: F1's drain-on-read plus hook-path
  materialization and on-demand snapshot render cover F2. The spec's
  resident worker arrives with F3/F4 when claims/inbox need a writer.
- Snapshot consumption is Node-side only; emitting snapshot text straight
  from run.sh would need per-host JSON envelopes — a follow-up
  optimization, not required for correctness.
- No mode-file GC yet (files accumulate per session; `bro mode list`
  shows them; pruning is a later bead).
