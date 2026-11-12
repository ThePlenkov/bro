---
template: brotocol/spec@2
id: AGT-3
title: Codex — manifest surface, PostCompact, PermissionRequest, unobservable outcome
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/codex/
aliases:
  - codex
---

# AGT-3 — Codex: manifest surface, PostCompact, PermissionRequest, unobservable outcome

## Problem

Codex is the only manifest host that wires **all eight** bro events —
including `PostCompact` and `PermissionRequest`, two surfaces Claude
declares as gaps. It also has the weakest post-tool signal of any
host: `PostToolUse` fires on non-zero exits too, so the tool outcome
is genuinely unobservable and the arm is a re-verified hint. The
spec pins the mapping and the honest-degradation rule.

## Design

### Surface: `manifest`, sync, marketplace plugin

`plugins/codex/bro/` carries `hooks/hooks.json` + `hooks/run.sh` +
`INSTRUCTIONS.md`. The hooks map is hand-maintained (not generated —
Codex's schema is stable enough that gen-plugins does not own it);
`INSTRUCTIONS.md` is the host-specific policy doc: *"Codex commands
own the session. Bro owns the durable plane."* — the ownership table
(`/goal`, `/plan`, subagents vs `bro agents`, worktrees vs `/fork`)
is part of this spec's contract surface.

### Event mapping (HOOK_MATRIX `codex` row)

| bro event | Codex native | effects |
| --------- | ------------ | ------- |
| session-start | `SessionStart` (`startup\|resume\|clear\|compact`) | context |
| pre-compact | `PreCompact` | context |
| post-compaction | `PostCompact` | context |
| prompt-submit | `UserPromptSubmit` | context |
| pre-tool | `PreToolUse` (`Bash`) | block, rewrite |
| post-tool | `PostToolUse` (`Bash`) | context, observe — outcome `unobservable` |
| permission | `PermissionRequest` (`Bash`) | approve |
| stop | `Stop` | block, context — `stopRefusal: 'block'` |

### Native functions leveraged

- **`AGENTS.md`** — Codex's native instruction file *is* bro's
  policy-spec path; no shim needed.
- **SessionStart matcher** — `startup|resume|clear|compact` means
  rehydration fires on resume and post-compact automatically; the
  `PostCompact` cell exists because Codex tells us compaction
  happened rather than making us infer it.
- **`PermissionRequest`** — the self-tool approve (`bro`/`bd`/`npx
  @broject/bro`) lands on Codex's real permission plane; scoped
  opt-in per the boundaries.
- **Unobservable outcome** — the contract's honesty rule in action:
  `outcome: 'unobservable'` tells the journal to record no `ok`, and
  the arm predicate re-verifies instead of trusting the event.
  Codex is the reference case for "host fires the hook but cannot
  say how the tool ended."

### Install

`codex plugin marketplace add ThePlenkov/bro` → install `bro`.
Marketplace manifest: `.agents/plugins/marketplace.json` (repo
root, gen-plugins-validated).

## Requirements

- **R1** — All eight cells stay wired — Codex is the coverage
  reference host; losing `PostCompact` or `PermissionRequest` is a
  contract regression, not a simplification.
- **R2** — `outcome: 'unobservable'` semantics preserved: post-tool
  arms on the hint, the journal records no `ok`, never synthesize a
  success the host did not report.
- **R3** — `INSTRUCTIONS.md` stays the Codex↔bro ownership map —
  host-native commands (`/goal`, `/plan`, subagents) are never
  re-implemented by bro policy.
- **R4** — SessionStart matcher keeps covering `resume`/`clear`/
  `compact` — a session that survives compaction must rehydrate.
- **R5** — Stop `decision:block` one-shot per armed aspect.

## Verify

- `host-matrix.test.ts` codex row green — eight cells, no gaps.
- `hooks.e2e.test.ts` Codex payload shapes incl. `turn_id`
  fingerprinting (`shellHostOf` must keep reading Codex payloads as
  codex, not claude).
- Live: Codex session shows rehydration on start/resume, self-tool
  approve on `bro`/`bd` shell calls, single stop-gate block.

## Changelog

- 2026-11-12 — Initial draft under AGT-1: full eight-event coverage,
  unobservable post-tool outcome, INSTRUCTIONS.md ownership map.
