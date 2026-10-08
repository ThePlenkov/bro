---
parent: bro-6vcll
scope:
  - packages/cli/src/commands/goal.ts
  - packages/cli/src/commands/goal-config.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/plugins.ts
  - skills/goal/SKILL.md
  - specs/goal/bro-6vcll.md
---

# bro-6vcll — session-scoped completion goals (`bro goal`, `/goal` for hosts without one)

References: OpenAI Codex goals cookbook (persistent thread objective with
budget + evidence-checked completion), Claude Code `/goal` (session-scoped
prompt Stop-hook with a model evaluator: met / not yet met / impossible),
ChatGPT CLI `/goal` developer command.

## Problem

Bro sessions — interactive devin sessions and spawned workers alike —
stop at the end of a turn and wait. Long-horizon work ("empty the ready
queue", "make the gate green") today needs either a `bro loop` (whole
machine, one backend) or a human nudging every turn. Codex and Claude
solve this with a **goal**: a durable completion condition the session
works against until a verdict — met, impossible, or budget — resolves it.

Devin has no native `/goal`. Bro already owns the pieces the feature is
made of: a session-keyed state dir under the common git dir, a Stop hook
that injects context, a trace journal per session, and a typed judge
facade (`decide()` over choice/score/noul). What is missing is the
feature itself.

## Terms

- **goal** — a session-scoped completion condition: `{condition, status,
  createdAt, evals, maxTurns, lastVerdict, lastReason}`. Persisted under
  `<git-common-dir>/bro/hooks/goal/<session>.json` — a `goal/` SUBDIR of
  the hooks state dir, never flat (readArmed scans `<session>.*` files as
  gate aspects).
- **repo seed** — `goal/_default.json`: the record `bro goal` writes when
  no session is resolvable (a human at a bare shell). A hook that finds
  no session goal but a seed materializes it as that session's goal —
  "operator sets the objective, next session picks it up".
- **verdict** — the judge's per-stop evaluation: `met` | `not_met` |
  `impossible`, plus a one-line reason synthesized from the answer.
  Advisory only — like every judge consumer in v1, the verdict is
  context, never `decision: block` (shadow contract; gates not loops).
- **turn budget** — `maxTurns` evaluations before the goal self-pauses
  (`status: budget`). `bro goal resume` resets the counter. 0 = no cap.

## Design

### `bro goal` — the CLI

```
bro goal <condition…>     set/replace the session goal   [--session <id>] [--turns N]
bro goal                  status — condition, status, age, evals/maxTurns, last verdict
bro goal clear            resolve the goal (aliases: stop, off, reset, none, cancel)
bro goal pause|resume     suspend / reactivate (resume resets evals)
                          [--json] on every form
```

Session resolution: `--session` > env
(`BRO_SESSION_ID`, `DEVIN_SESSION_ID`, `CLAUDE_SESSION_ID`,
`CODEX_SESSION_ID`, `OPENCODE_SESSION_ID`) > repo seed (`_default`).
The seed path is how `bro goal "empty bd ready"` on a bare shell becomes
the next session's objective — Codex's "persisted thread state" without
the thread existing yet.

### Hook integration

- **session-start / post-compaction** (`emitSessionContext`): when the
  session has a goal (or a seed exists), inject its status line —
  Claude's resume-restores-goal semantics, from a file so resume works
  across compaction too.
- **stop** (`emitStopGate`): goal evaluation runs BEFORE the
  `stop_hook_active` early return — the reminder must fire on every
  stop, not once. With judge resolvable (`goal.judge !== false` and
  `judgeFacade` configured): one `decide()` — a `choice` question
  {met, not_met, impossible} over `{condition, trace tail}`.
  - `met` → `status: achieved`, context "goal met" — clears itself.
  - `impossible` → `status: impossible`, context — clears itself.
  - `not_met` → `evals++`; over `maxTurns` → `status: budget`; else
    context "goal turn N/M — not yet met: <condition> — keep going".
  - judge throw / low confidence → plain reminder (fail-open, like
    every hook probe — a wedged judge must never stall a session).
  - no judge → plain reminder "goal: <condition> — verify before
    reporting done".

### `/goal` — the agent surface

`skills/goal/SKILL.md` ships with every plugin adapter (devin's `skills/`
symlink covers it; `bro setup --skills` embeds it). For hosts without a
native goal command it IS `/goal`: the skill maps `/goal <condition>` →
`bro goal`, `/goal pause|resume|clear` → the same verbs. Hosts with a
native command (Claude Code) keep theirs — `bro goal` remains the
scriptable, cross-host, worker-spawnable surface.

### `goal` config section

```json
"goal": { "maxTurns": 25, "judge": true }
```

`maxTurns` — default turn budget for goals set without `--turns`.
`judge` — false pins reminders-only even when the judge facade resolves.

## Non-goals

- No `decision: block` from a goal — the keep-going mechanism is context
  injection; the model reads the verdict and continues. Forced blocking
  is a future `goal.enforce` decision, not v1.
- No `--goal` on `bro agents up` — pinning a goal onto a spawned worker's
  BRO_SESSION_ID is the obvious next mile, cut to keep this slice thin.
- No token-spend tracking in status (Claude shows it; bro's hook has no
  spend plane — verdict cost lands in the judge journal instead).

## Test plan

- goal.ts unit: set/status/clear/pause/resume round-trip on a temp
  git-common dir; session resolution order; seed→session materialization.
- hooks: stop emits the reminder without a judge; verdict paths (mocked
  facade) write achieved/impossible/budget and clear; `stop_hook_active`
  still gets the goal line; no goal → no line.
- `bro goal` on an empty session → status "no goal".
