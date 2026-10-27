---
parent: bro-l8c4f
scope:
  - packages/cli/src/host-matrix.ts
  - packages/cli/src/host-matrix.test.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/commands/hooks.e2e.test.ts
  - packages/cli/src/adapter/pi-conformance.test.ts
  - packages/cli/package.json
  - plugins/claude/bro/hooks/hooks.json
  - site/content/docs/integrations.md
  - site/content/docs/index.mdx
---

# bro-l8c4f.8 — hooks/hosts: versioned capability matrix + native payload conformance

Parent: `bro-l8c4f` (principal audit — client conformance). Two findings
landed as one contract: a versioned per-host capability matrix, and
normalization of native hook payloads into bro's single internal event.

## Problem

**Capability surface is tribal knowledge.** Eight hosts wire `bro hooks`
through four different mechanics (shell manifests, generated manifests,
in-process extensions, in-process plugins), and what each can actually
*do* with a hook verdict — block, re-prompt, journal, rewrite, approve —
lives in scattered comments. Docs describe a "uniform hook contract"
without saying which cells are real and which degrade. Two boundaries
are conflated in prose: bro's stop gate (advisory session hygiene) vs.
the host's permission plane (the actual security surface a user opted
into), and opt-in `bro`/`bd` auto-approval vs. general host permissions.

**Native payloads don't fit the shared envelope.** `bro hooks post-tool`
arms the session only when `tool_response.success === true`, but:

- Claude's `PostToolUse` IS the success signal — it fires only after a
  call succeeds (`PostToolUseFailure` is the failure event, carrying
  top-level `error`/`is_interrupt`, no `tool_response`). Neither payload
  has a `success` boolean, so a valid Claude success event journals but
  never arms — the stop gate never learns the session pushed.
- Codex's `PostToolUse` fires after **any** Bash outcome, including
  non-zero exits, and Codex has no failure event — the event name alone
  proves nothing there.
- Devin sends `tool_response.success` verbatim; Cursor splits success/
  failure by event name (already translated in `cursor-hook.ts`);
  pi/OMP/OpenCode adapters synthesize `{success: isError !== true}`.
- Claude's manifest wires `PostToolUse` for `Bash` only and has no
  `PostToolUseFailure` entry at all — failure payloads can't arrive.

So outcome semantics are host-dependent and the CLI treats one field
name as universal. Normalization has to be host-aware: the same
`PostToolUse` name means "success" on Claude and "call produced output"
on Codex.

## Design

### One internal event, two normalization levels

The internal contract stays `HookInput` in `commands/hooks.ts` — the
payload `bro hooks` already consumes. What changes is *how the success
field gets populated*:

- **In-process adapters** (pi, OMP, OpenCode, Kilo) keep translating at
  their edge — `tool_result` already emits `tool_response.success` from
  `isError`. No change.
- **Cursor** keeps its dedicated translator — `cursorToHookInput` maps
  `postToolUse`/`afterShellExecution` → success, `postToolUseFailure` →
  failure, `loop_count > 0` → `stop_hook_active`.
- **Shell-manifest hosts** (Claude, Codex, Devin) can't transform JSON —
  `run.sh` pipes the native payload verbatim. The CLI edge now derives
  the outcome per host instead of reading one field name.

**Host identity is fingerprinted from the payload, not the wiring.**
`run.sh` is a shared verbatim launcher, so no manifest change is needed
and stale installs get the fix for free. The fingerprints already exist:
`isCursorHookPayload` diverts Cursor, `turn_id` is Codex's documented
extension field (the same check `codexClient` already runs for
`permission`), and everything else gets the shared Claude-vocabulary
reading — which is safe because Claude's `PostToolUse` is documented
success-only and Devin's explicit `success` field wins before any
derivation runs.

### Outcome derivation

`host-matrix.ts` holds `deriveToolSuccess(raw)` — data-driven from the
matrix's `outcome` cells:

| host | `PostToolUse` | `PostToolUseFailure` / `*Failure` |
| ---- | ------------- | --------------------------------- |
| claude (+unpinned) | `true` — documented success-only | `false` |
| codex (`turn_id`) | `undefined` — fires on non-zero exits too | `false` if one ever arrives |
| devin | explicit `tool_response.success` wins first anyway | — |
| cursor | via `cursorToHookInput` (unchanged) | via `cursorToHookInput` |

An explicit boolean `tool_response.success` always wins over
derivation; any `*Failure`/`*Error` event name is failure on every
host; anything unproven stays `undefined`.

**Consumers read the normalized field, and arming is deliberately
weaker than the journal.** `emitPostTool` arms on
`success !== false` — arming is a hint telling the stop gate "probe
live state once", not a verdict; a false arm costs one probe that finds
nothing (Codex's unobservable failures over-approximate this way —
documented in the matrix, never claimed as detection). The trace
journal's `ok` field stays honest: written only from an explicit
boolean or a host where the event is documented success/failure — so
Codex `PostToolUse` journals with `ok` absent (outcome unobservable),
Claude's pair records true/false, Devin records its boolean.

### Wiring additions

- Claude gains `PostToolUseFailure` → `post-tool` (matcher `Bash`,
  same as its `PostToolUse` entry): failure events reach the journal
  and the mailbox drain without arming. `PostCompact` and
  `PermissionRequest` exist upstream but stay declared gaps.
- No matcher widening to `Edit`/`Write`: the declared journal/guard
  contract covers shell commands plus *whatever a host already sends*;
  Edit payloads that do arrive are journaled as `paths`, never as
  shell commands. pi/OMP/OpenCode forward all tools already.
- OMP's `session_stop` is the only host besides the manifest hosts
  with a native stop refusal; pi uses `agent_before_settle` + a
  synthesized continuation (re-prompt, not a block); OpenCode
  re-prompts; Kilo logs only.

### The versioned capability matrix

`host-matrix.ts` exports `HOOK_MATRIX`:

```ts
{
  version: 1,
  boundaries: { ... },                 // advisory ≠ enforcement, opt-in
                                       // approval ≠ host permissions,
                                       // policy lives in core
  hosts: {
    claude: {
      surface: 'manifest',             // hooks.json + run.sh
      plugin: 'plugins/claude/bro',
      events: {
        'session-start':  { native: 'SessionStart', effects: ['context'] },
        'post-tool':      { native: 'PostToolUse', match: 'Bash',
                            effects: ['context','observe'],
                            outcome: 'success-only' },
        ...
        'pre-compact':    { native: 'PreCompact', ... },
        // absent keys = declared-unsupported on this host
      },
      stopRefusal: 'block',            // decision:block enforced once
      background: 'sync',
      upstream: { doc: 'code.claude.com/docs/en/hooks',
                  checked: '2026-10-24' },
    },
    codex: { ..., postTool outcome: 'unobservable' }, ...
  }
}
```

`outcome` vocab: `'split-events'` (Claude — success/failure are distinct
events), `'field'` (Devin — `tool_response.success`), `'unobservable'`
(Codex), `'synthesized'` (pi/OMP/OpenCode/Kilo — adapter computes it),
`'mapped'` (Cursor — edge translator already maps it).

`stopRefusal` vocab: `'block'` (host can refuse the stop — manifests,
OMP), `'reprompt'` (pi continuation, OpenCode re-prompt), `'none'`
(Kilo). This is the column docs quote when they say the gate is
advisory: a `reprompt`/`none` host turns bro's block into UX text.

`effects` vocab: `context` (advisory nudge into the model's context),
`observe` (journal/trace), `block` (host-enforced refusal),
`reprompt` (synthesized follow-up), `rewrite` (`updatedInput`),
`approve` (permission verdicts — the `bro`/`bd` self-tool opt-in),
`notify` (UI surface only).

`boundaries` is a typed docstring object — the three separations the
audit demands, machine-readable so docs and tests cite one source:
`advisory` (nudges/context/re-prompt are UX, not enforcement),
`policyVsPermissions` (bro's merge/stop policy is authoritative over
repo state; host permissions are the user's own security surface),
`optInApproval` (the `bro`/`bd` self-approval is opt-in and scoped to
self-tools — it is not the host's permission system).

`host-matrix.test.ts` is the conformance gate: parse each shipped
`hooks.json` and assert every declared `native` event is wired to
`run.sh <bro-event>` with the declared matcher — and nothing undeclared
is wired. Drive the pi/OMP adapter modules with stub APIs and assert
the registered event names equal the declared set. Load the OpenCode/
Kilo plugin modules and assert the declared hook keys exist.
Unsupported cells get asserted too — e.g. claude has no
`PostCompact`/`PermissionRequest` wiring today (declared gap), kilo has
no stop refusal.

### Native conformance fixtures

`commands/hooks.e2e.test.ts` feeds
**officially-shaped native payloads** — no synthetic `success` where
the host doesn't send one:

- Claude `PostToolUse`/Bash, `git push` → arms `act` marker, journals
  `ok: true`.
- Claude `PostToolUseFailure` → journals `ok: false`, mailbox drains,
  no marker.
- Codex `PostToolUse`/Bash (no success anywhere) → arms, journal `ok`
  absent.
- Devin `PostToolUse`/`exec` with `success:false` → journal `ok:false`,
  no arm.
- Claude `PostToolUse`/`Edit` (`file_path`, `old_string`…) → journal
  carries `paths`, no `command`, no arm, not misread as a shell call.
- Claude `Stop` with `stop_hook_active: true` → fail-open allow; first
  `Stop` in an armed session → block once. Same shape for `SubagentStop`
  payloads routed through `stop` — tolerated, not conflated.
- Unknown host / missing pin → conservative table, no throw.

The fixtures ride the real `runHooksCommand` stdin path (the existing
e2e harness), not a stubbed policy — the claim is about wire fidelity.

### pi type conformance (dev-time only)

`@earendil-works/pi-coding-agent@1.4.0` is a **devDependency** of
`@broject/bro` — the shipped bundle (`plugins/pi/bro/bro.ts` via
tsdown) never imports it; `adapter/pi.ts` keeps its structural local
types. A conformance test file asserts, at typecheck time, that every
event name `pi.ts` registers exists in the real `ExtensionAPI.on`
overload set, that `ToolResultEvent` carries `isError`/`toolName`/
`input`, `AgentBeforeSettleEvent` exposes `outcome`, and our
`BoundaryResult` shape is assignable to the real return type; at
runtime it asserts the installed version equals the pinned one so the
fixture can't drift from the release it claims to check.

### Freshness

`gen-plugins --check` already covers generated artifacts; the Claude/
Codex manifests are hand-authored (`null` entries in the manifest map),
so the matrix test is what keeps *them* honest. Versioned-pin rewrite
(`VERSIONED_SOURCES`) stays untouched.

## Plan

- [x] Spec (this file).
- [x] `host-matrix.ts` — versioned matrix + boundaries + outcome derivation.
- [x] `deriveToolSuccess(raw)` in host-matrix.ts — host-fingerprinted
      outcome derivation (explicit field > failure event name >
      documented success event); `runHooksCommand` writes it into
      `tool_response.success`, `emitPostTool` arms on `!== false`,
      the journal records only the proven `ok`.
- [x] Manifest: claude gains the `PostToolUseFailure` entry.
- [ ] `host-matrix.test.ts` — wiring conformance per host, incl.
      unsupported cells.
- [ ] `commands/hooks.e2e.test.ts` — native fixtures → arm/journal/
      mailbox/stop semantics.
- [ ] pi devDep + type-conformance test; assert pin == installed.
- [ ] Docs: `integrations.md` gains the matrix table + boundary
      wording; `index.mdx` stops implying uniformity.
- [ ] `bro spec check`, `npm run check:plugins`, build, typecheck,
      `npm test`; commit, push, PR.
