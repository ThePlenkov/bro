# bro-izpyk.8 — fleet claims: conflict-policy consumers (observe inbox note + pre-tool guard warn/block)

Governing spec: `specs/sessions/bro-izpyk.md` (branch
`devin/1792972271-fleet-spec`), "Claims and conflicts" — the conflict-policy
sentence, verbatim:

> **Conflict policy by mode.** In observe, a conflict is shown as an inbox
> note. In code, guard warns on pre-tool, and blocks only when the project
> config opts in.

Impl spec `specs/bro-izpyk.3.md` §6 deferred the guard half ("Pre-tool guard
blocking stays opt-in and is not wired in F3 — no project config key exists
yet; documented as follow-up") and left "Observe-mode callers surface notes"
unimplemented. This bead is that follow-up (audit gap, 2026-11-13).

## What already exists (verified on main da3f9c55)

- `ClaimFacade` (`core/claims.ts`, provider `core/claims-store.ts`):
  `claim()` returns `{ok:false, conflict}` — never throws — with the
  standing holder row; `list()` sweeps dead leases and returns live ones.
- Claim consumers on main: `bro claim` CLI (prints refusals to stdout),
  the `claimWorktreeArm` fire-and-forget bridge in `hooks.ts` (~2069-2090 —
  **conflict results are dropped silently**), and the
  `orchestratorRoleAllows` rearm gate. No `preTool`/guard path consults
  claims (`guard-probes.ts`, core `guards.ts` have zero claim references).
- F4 messaging (`commands/session-msg.ts` + `core/session-inbox.ts`):
  `sendSessionMessage` resolves a `<host>:<sid>` target and appends the
  session inbox file (`appendSessionInbox`) for inbox-capable hosts,
  falling back to the mailbox `to:` address otherwise. The notify
  connector drains the inbox on `postTool`/`sessionStart` in **every**
  mode — including observe, where `run.sh`'s `[ -s $HOOK_INBOX ]` check
  wakes Node for exactly this.
- The guard plane: connector `preTool` verdicts (`PreToolVerdict` =
  `{block?, input?}`); `emitPreTool` vetoes on the first `block`, merges
  `input` overrides, stays silent otherwise. `run.sh` deliberately keeps
  pre-tool on the Node path in **every** mode ("the safety vetoes stay
  live"), so a connector `activeIn` declaration is the mode gate.
- `sessionMode()` resolves the caller's mode file > `modes.default` >
  `observe`; `sessionProject()` names the project id.

## Design

### 1. `claims.conflicts` — the project config key (policy layer)

```json
"claims": { "conflicts": "warn" | "block" | "off" }
```

- `warn` — **default**. The spec's "guard warns on pre-tool": the conflict
  is emitted as `additionalContext` on `PreToolUse` and the call proceeds.
- `block` — the opt-in the spec names ("blocks only when the project
  config opts in"): the verdict carries `block` and the first conflict
  vetoes the call like every guard-plane block.
- `off` — kill switch; no claims read on the pre-tool path. Not in the
  spec text, but every live policy knob in this repo carries an explicit
  opt-out (`guard.enabled`, `spawn.externalBlock`) and a project that
  finds the warns noisy needs a cleaner escape than deleting the mode.

New core section `claims` (`config.ts`): `claimsSection` normalizer +
`.jsonSchema`, `BroConfig.claims`, `DEFAULT_CONFIG.claims =
{conflicts:'warn'}`, `CORE_SECTIONS.claims`,
`CONFIG_SECTION_LAYERS.claims = 'policy'` (it is identical-for-everyone
project policy, same audience as `act`/`modes`/`guard`). Doctor's
unknown-key scan picks it up via `CORE_CONFIG_SECTIONS`; the emitted
schema is regenerated (`npm run gen:config-schema`).

### 2. `PreToolVerdict.warn` — the guard plane learns "advisory"

`PreToolVerdict` gains `warn?: string` — a reason line that never vetoes.
`emitPreTool` collects `warn`s across verdicts; when no `block` fired it
emits ONE `hookSpecificOutput` carrying `additionalContext` (warns joined)
plus the `tool_input` merge when input overrides exist. Codex keeps its
own shape: `permissionDecision:'allow'` + `permissionDecisionReason` (the
only string slot its schema carries) + `updatedInput`. Cursor translates
`additionalContext` → `additional_context` through the existing
`toCursorHookOutput` path — a host that never saw `tool_input` merges
actually *gains* the warn channel. No verdicts → silence → fail-open,
unchanged.

### 3. `commands/claim-conflicts.ts` — the claims conflict connector

`claimConflictConnector` (registered in `cli/connectors.ts`):

```ts
activeIn: { preTool: ['plan', 'code', 'review', 'orchestrate'] }
```

The spec names `code`; the probe is declared for every *active* mode —
plan/review/orchestrate sessions run tools in the same worktrees and the
arm bridge fires in all of them. Observe stays excluded: its channel is
the inbox note (§4), and a passive session never pays the claims read.

`claimConflictVerdicts(ctx, input, deps)` — fail-open like every hook:

1. policy `off`, empty `ctx.sessionId`, or an unresolvable host → `[]`.
2. `claims.list({})` (machine ledger, swept live) → candidate rows.
   Project filtering is per-resource, not per query: a row with
   `project: null` (claimant's session carried none) still counts — an
   unresolvable project must not hide a conflict.
3. Resources the call touches:
   - `worktree:<path>` — the claimed path is the session cwd or an
     ancestor of it (realpath-normalized), OR a tool-carried path
     (`file_path`/`path`/`files[]`) lands inside it. A worktree claim
     asserts the whole tree below it.
   - `path:<glob>` — the glob matches a tool-carried path, tested in raw,
     cwd-relative and dir-relative form (claimants write globs in either
     frame). Matching mirrors learn/act's glob convention (basename match
     for slash-less patterns, `*` in-segment, `**` cross-segment) — a
     local copy, not an import: core can't reach `@broject/learn` and
     the hook path doesn't need its weight.
   - `branch:<name>` — equals the current branch; resolved lazily (one
     `gitTry`) only when branch claims exist.
   - `task:*`, `pr:*`, `role:*` are not file/tool resources — skipped
     (documented: `task:` is the tasks store's, `pr:`/`role:` have no
     tool-input mapping).
4. Conflict rule = `blocksClaim` symmetric: a foreign live row conflicts
   iff `foreign.exclusive || ownExclusiveOnThatResource` — the tool call
   is the session's implicit claim carrying whatever exclusivity it
   already holds on the resource. Same-session rows never conflict.
5. Verdicts — one per conflicting resource: `warn` → `{warn}`, `block` →
   `{block}`, each naming the resource + holding `host-sid` (+ detail).
   `block` text carries the remedy (`bro claim release`).

### 4. Observe-mode refused claim → session inbox note

`bro claim` prints the refusal to stdout today — but the spec's channel is
the inbox: a claim typed in an observe session (or targeted at one via
`--session`) leaves a note the session's NEXT hook delivers into context.
`runClaimAcquire` on `!result.ok` resolves the caller's mode
(`sessionMode` — unresolvable resolves `observe`, the honest default) and,
when it is `observe`, calls `sendSessionMessage` with target
`<host>:<sid>`, `kind:'info'`, text
`claim refused — <resource> held by <host>-<sid>[ (<detail>)]`.

That IS the F4 path: inbox file for inbox-capable hosts, mailbox `to:`
for everything else, ledger record either way. Non-observe callers get no
note — their surfacing channel is the §3 pre-tool verdict (the standing
conflict re-derives on the next tool call). Facades resolve through
`facade('ledger'|'events')` with `connectors.*` pins honored, injectable
for tests; failures degrade to warnings, never a failed `bro claim`.

### 5. Arm-bridge conflicts — surfaced, in the inbox

`claimWorktreeArm` (hooks.ts) is fire-and-forget; its refusal was dropped.
Now its `.then` appends one inbox entry to the *arming* session
(`appendSessionInbox` directly — the host is already proven
inbox-capable, and the async resolution can never join the current
event's output anyway): `claim conflict — worktree:<dir> is held by
<host>-<sid>; work arm is not leased`. The note lands on the next
post-tool/sessionStart drain in ANY mode — the refusal *event* is told,
while §3's warn carries the standing *state* per tool call. A `.catch` is
kept: claims stay best-effort, arming never stalls.

The alternative (awaiting `claim()` before assembling post-tool lines)
was rejected: it pays sqlite latency on every work-arming hook event for
a verdict the standing state already re-derives.

## Files

- `packages/core/src/config.ts` — `claims` section + `ClaimConflictPolicy`.
- `packages/core/src/connectors.ts` — `PreToolVerdict.warn`.
- `packages/cli/src/commands/claim-conflicts.ts` — NEW: policy read,
  conflict matching, `claimConflictConnector`, `noteRefusedClaim`.
- `packages/cli/src/connectors.ts` — register the connector.
- `packages/cli/src/commands/claim.ts` — refused claim → observe note.
- `packages/cli/src/commands/hooks.ts` — `emitPreTool` warn emit;
  `claimWorktreeArm` refusal → inbox note.
- `packages/cli/schemas/bro.config.schema.json` — regenerated.
- `specs/bro-izpyk.8.md` — this file.
- Tests: `claim-conflicts.test.ts`; `claim.test.ts` additions
  (observe note fires/skips); `config.test.ts` (section parse);
  hooks pre-tool warn coverage.

## Deviations / decisions

- **Scope of `preTool` mode gate** — spec names `code`; applied to all
  active modes (§3). Observe keeps the inbox channel instead.
- **Devin has no pre-tool event** — its veto point is `permission`
  (`sessionCapRefusalForHook` precedent). The claims check is pre-tool
  only per spec; a permission-path twin is left as a documented gap
  (cheap to add later — same verdict function).
- **`branch:`/`path:`/`worktree:` only** — `task:`/`pr:`/`role:` skipped
  (no tool-call mapping; `task:` is the tasks store's truth).
- **The holder is not notified** when a foreign claim is refused — the
  refused party is the one in conflict; "someone tried" is not signal a
  holder can act on.
- **Arm bridge → inbox, not stdout** — the async result can't join its
  own event; the note lands on the next drain.

## Verification

- `npm run build`, `npm run typecheck`, `npm test`; `check:config-schema`
  after regenerating the schema doc.
- Targeted: `tsx --test` on claim-conflicts/claim/config/hooks tests.
- Live smoke: session A `bro claim worktree --exclusive`; session B
  (code mode) runs a tool in the worktree → warn line; `claims.conflicts:
  block` → veto; observe-mode session `bro claim` refused → note lands in
  `inbox/<host>-<sid>` and drains on the next hook.
