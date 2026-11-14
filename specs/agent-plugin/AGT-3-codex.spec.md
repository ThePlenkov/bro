---
template: brotocol/spec@2
id: AGT-3
title: Codex — manifest surface, all eight events, INSTRUCTIONS.md ownership map
status: draft
area: agents
parent: AGT-1
owns:
  - plugins/codex/
aliases:
  - codex
---

# AGT-3 — Codex: manifest surface, all eight events, INSTRUCTIONS.md ownership map

## Problem

Codex is the only manifest host wiring **all eight** bro events —
`PostCompact` and `PermissionRequest` included, surfaces Claude
declares as gaps. Its post-tool outcome is the weakest (`PostToolUse`
fires on non-zero exits — genuinely unobservable). It also ships
`INSTRUCTIONS.md`, the only host with a written native↔bro ownership
table — the correlation contract made explicit. The spec pins the
mapping, the degradation rule, and the ownership doc as contract.

## Design

### Surface: `manifest`, sync, marketplace plugin

`plugins/codex/bro/` = `hooks/hooks.json` + `hooks/run.sh` +
`INSTRUCTIONS.md` (hand-maintained — Codex's schema is stable).
Marketplace: `.agents/plugins/marketplace.json`.

### Event mapping (HOOK_MATRIX `codex` row)

| bro event | Codex native | effects |
| --------- | ------------ | ------- |
| session-start | `SessionStart` (`startup\|resume\|clear\|compact`) | context |
| pre-compact | `PreCompact` | context |
| post-compaction | `PostCompact` | context |
| prompt-submit | `UserPromptSubmit` | context |
| pre-tool | `PreToolUse` (`Bash`) | block, rewrite |
| post-tool | `PostToolUse` (`Bash`) | context, observe — `unobservable` |
| permission | `PermissionRequest` (`Bash`) | approve |
| stop | `Stop` | block, context |

### What the plugin adds — the honest inventory

| asset | Codex gets | mechanism |
| ----- | ----------- | --------- |
| `/bro` command | **none** | n/a |
| `bro_*` tools | **none** | n/a |
| skills | all 49 | repo-root plugin (`plugin.json` + `skills/`) via Codex plugin system |
| UX | hook context lines + `INSTRUCTIONS.md` routing | rehydration/nudges; the ownership table tells the model when Codex commands vs bro apply |
| permission | `PermissionRequest` approve | `bro`/`bd`/`npx @broject/bro` self-tools |

### Native correlation — `INSTRUCTIONS.md` is the contract

| When | Codex owns | Bro owns |
| ---- | ---------- | -------- |
| target surviving turns | `/goal` | repo seed, hosts without `/goal` |
| design before code | `/plan` | — |
| parallel work in-chat | subagent → `/agent` | beads workers that outlive the chat: `bro agents` |
| background shell | `/ps`, `/stop` | — |
| another approach | `/fork`, `/side` | git worktree |
| the open PR | — | `bro act` (`/review` is the working tree) |

The rule generalized: **session-scoped UX stays native; durable
plane (beads, specs, PR gates, fleet) is bro's.** Codex is the
reference implementation of the correlation table every child spec
must fill.

### Unobservable outcome — the honesty reference

`PostToolUse` fires on non-zero exits too → `outcome:
'unobservable'`: post-tool arms on the hint, the journal records no
`ok`, nothing synthesizes success the host didn't report.

## Requirements

- **R1** — All eight cells stay wired — Codex is the coverage
  reference; dropping `PostCompact`/`PermissionRequest` is a
  contract regression.
- **R2** — `unobservable` semantics preserved: arm on hint, no `ok`
  in journal, never fake success.
- **R3** — `INSTRUCTIONS.md` stays the ownership map — native
  commands (`/goal`, `/plan`, `/agent`, `/fork`) never re-implemented.
- **R4** — SessionStart matcher keeps `resume|clear|compact` —
  post-compaction sessions rehydrate.
- **R5** — Stop block one-shot per armed aspect.
- **R6** — No `/bro`/tools claimed — assets stay context+skills+
  permission.

## Verify

- `host-matrix.test.ts` codex row — eight cells, zero gaps.
- `hooks.e2e.test.ts` Codex payloads incl. `turn_id` fingerprint
  (`shellHostOf` must not read Codex as Claude).
- Live: rehydration on start/resume, self-tool approve, single
  stop-gate block; `/goal`-style native flows untouched.

- **Scenario map** (AGT-1 §Test scenarios): applicable — S1
  session-start ctx, S2 pre-tool guard, S3 stop gate, S5
  compaction, S6 multi-turn (all eight events observed), S7
  fail-open, S8 dep-degraded, S9 skills, S10 native correlation
  (`INSTRUCTIONS.md` ownership table). Not applicable — S4 `/bro`
  (no command surface). Codex uniquely exercises the permission
  approve cell — its scenario asserts the approve reaches the
  host's permission prompt. Hook dispatch verified e2e —
  `manifest.e2e.test.ts` fires every hooks.json-declared event
  (incl. permission + both compaction cells) through the shipped
  run.sh; bare `PLUGIN_ROOT` host detection confirmed (a stray
  `DEVIN_PROJECT_DIR` mislabels the session `devin` — caught by
  the matrix).

## Changelog

- 2026-11-12 — v1 draft.
- 2026-11-12 — v2 rewrite: assets inventory, INSTRUCTIONS.md
  ownership table promoted to contract, unobservable-outcome rule.
- 2026-11-12 — v3: Verify gains the AGT-1 scenario map (S1–S10 applicability); permission-approve cell gets its own scenario assertion.
- 2026-11-14 — v4: hook dispatch verified e2e — `manifest.e2e.test.ts`
  fires every hooks.json-declared event (incl. permission + both
  compaction cells) through the shipped run.sh; bare `PLUGIN_ROOT`
  host detection confirmed — `DEVIN_PROJECT_DIR` in env mislabels the
  session `devin` (mode-file miss → observe fast-path), caught by the
  matrix.
