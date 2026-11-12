---
scope:
  - specs/bro-xkv42.1.md
  - packages/loop/src/prompt.ts
  - packages/loop/src/index.ts
  - packages/loop/src/loop.test.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/delegate.ts
  - packages/cli/src/commands/delegate-prompt.ts
  - packages/cli/src/commands/delegate.test.ts
  - packages/cli/src/commands/convoy-run.ts
  - packages/cli/src/agent-connectors/core.ts
---

# bro-xkv42.1 — worker closeout contract: learn+retro step in every spawn lane's work order

## Problem

Epic bro-xkv42: every WORKER session must end with learn + retro. Today no
spawn lane's work order carries a closeout step — the worker's job ends at
an open PR / verdict with no learn/retro instruction, so exits are silent
(the enforcement half is sibling bead bro-xkv42.2).

## Design

### The shared wording — `packages/loop/src/prompt.ts`

One exported const, `LEARN_RETRO_CLOSEOUT`, appended verbatim to every
spawn-lane work order (re-exported via `packages/loop/src/index.ts`; `@broject/loop`
is already a runtime dep of the CLI — drive/loop/act import it today, and
loop itself only deps `@broject/core`, so no new package edge and no cycle):

- Flag learnings in the result: `--result` lines prefixed `learn:`/`learning:`
  are the mol-capture contract (`packages/learn/src/capture.ts` `LEARN_FLAG`,
  mol source) — named explicitly so workers use it.
- Durable rule → `bro self learn add --lesson "…" --on … --evidence …`;
  distilled answer → `bro learn probe "<q>" --lesson "…"`.
- Session-scale review → the retro checklist (`skills/retro/SKILL.md`):
  loose ends, hand-rolled mechanics → bd gap beads, call economy, debt sweep.
- `bro self learn capture --dry-run` previews artifact harvest — capture is
  cheap and deduped, safe to run at close.

~5 rendered lines, imperative, identical everywhere. The degrade clause —
"if `bro` is on PATH" — covers workers on foreign rigs that lack bro/bd.
Not a hard gate; enforcement is bro-xkv42.2.

### Lane coverage

| Lane | Site | Placement |
| ---- | ---- | --------- |
| loop work + batch | `buildWorkPrompt` / `buildBatchPrompt` | trailing block after the rules |
| loop fix + rebase respawns | `buildFixPrompt` / `buildRebasePrompt` | same — a respawned worker still ends with learn+retro (rebase added beyond the bead's list of three: it is the same worker-respawn class the epic covers) |
| fleet agents up / mol+convoy step beads | `resolvePrompt` bead-text fallback (`# title\n\ndescription`) | append after the composed bead text — this is the spawn-wrapper answer to the formula question: every mol step spawned through the fleet path gets the contract regardless of which formula poured it, so `formulas/*.formula.toml` step descriptions stay lean and cannot drift from the shared wording |
| drive fixers | `buildFixerPrompt`, `buildRebaseFixerPrompt`, `buildCiFixerPrompt`, `buildSastFixerPrompt` | trailing block in each work order's Rules section |
| delegate --detach | `delegateWorkPrompt` (new, `delegate-prompt.ts`) composed in `delegateDetach` | the caller's ask text + closeout block |
| convoy runner | `runnerPrompt` (`convoy-run.ts`) | trailing block — the runner's per-step learnings ride `bro convoy done --result "learn: …"`, exactly what `capture --mol` harvests |
| gascity workers | `GC_PROMPT_TEMPLATE` (`agent-connectors/core.ts`) | appended to the authored template — new cities get it; existing cities keep their customized template (documented limit) |

`resolvePrompt`'s `--prompt-file`, stored-prompt (respawn), and literal
`req.prompt` paths stay verbatim — those are the caller's own work-order
text, not bro-composed orders (agents.test.ts pins stored/file content
equality). `bro agents run "<literal>"` adhoc spawns likewise stay literal.

### Delegate scope decision

`--detach` is the registry spawn — a real worker session with exit records,
so it gets the contract. `--wait` is a pooled ACP turn: no registry entry,
no exit cause, no `--result` channel — nothing a learn/retro artifact could
attach to (the sibling exit-check gates on registry exits anyway). The
retro skill itself exempts one-shot Q&A. `delegateWorkPrompt` resolves the
ask via the existing `delegatePrompt` channel (prompt XOR promptFile, 1MB
cap, non-empty) then appends the block; `delegateDetach` passes the
composed text as `prompt`. This tightens `--detach --prompt-file` to the
same regular-file/size gates `--wait` already had — previously it read
unbounded through `resolvePrompt`.

## Non-goals

- No enforcement — exit-time artifact flagging is bro-xkv42.2.
- No formula template edits — the spawn wrapper covers mol steps for any
  formula, shipped or user-authored.
- No changes to operator-supplied prompt channels (`--prompt-file`,
  `--prompt`, stored prompts, serve API `prompt`, planes exec).
- `bro next`'s pick summary is not a spawn work order — untouched.
- Interactive `bro convoy next` skill-loop sessions — covered by the
  retro-on-stop guard, not spawn prompts.

## Acceptance

- Every prompt builder listed above emits `LEARN_RETRO_CLOSEOUT` verbatim;
  a single const is the only source of the wording (grep: one definition,
  N imports).
- `buildWorkPrompt`/`buildBatchPrompt`/`buildFixPrompt`/`buildRebasePrompt`,
  all four drive fixer builders, `runnerPrompt`, `GC_PROMPT_TEMPLATE`,
  `resolvePrompt`'s bead-text fallback, and delegate `--detach` prompts
  each contain the learn:/learning: flag instruction, the
  `bro self learn add`/`probe` commands, the retro-checklist pointer, and
  the `capture --dry-run` note.
- `npm run build`, `npm run typecheck`, and the touched packages' tests
  pass (`@broject/loop`, `@broject/bro` cli suite or targeted files).
