---
scope:
  - packages/core/src/session-planes.ts
  - packages/cli/src/session-planes/devin.ts
  - packages/cli/src/commands/agents.ts
  - skills/agents/SKILL.md
---

# bro-7dila — agents run: dedup guard for ad-hoc spawns

## Problem

`bro agents run --prompt X` mints a phantom `adhoc-<hex>` step: no bead,
no claim, no dedup. A second spawn of the same goal — from another
session, another terminal, another repo checkout — starts a parallel
worker on identical work (observed 2026-10-18: ~5 near-identical
user-spawned devin sessions raced on "visible Claude background tasks
via Devin ACP" title variants; PRs #572/#573 deduped only at review).
Bead-keyed spawns never race — `up <step>`'s claim guard refuses them —
but ad-hoc spawns bypass that plane entirely.

## Design

Two complementary guards on `bro agents run` — option (c) from the
bead: a strong claim-bound path plus an advisory similarity floor.

### `run --for <bead>` — the strong path

`--for <id>` makes the bead the molStep instead of minting `adhoc-`.
Every existing guard then applies unchanged:

- a live agent on the bead → `already has a live agent` (conflict);
- the bead `in_progress` with no registry entry → `claimed outside the
  agent registry` (a human or foreign backend owns it);
- a dead registry entry → ordinary respawn semantics (the worker's own
  claim rebinds; the stored prompt is reused when no prompt is given);
- an open bead → `claimStep` pins the claim before the spawn lands;
- a nonexistent bead → the claim write fails the spawn — `--for`
  refuses phantom fallback by construction.

Prompt channels stay as today (`<prompt>…` / `--prompt` /
`--prompt-file`); with none given and `--for` set, `resolvePrompt`'s
ordinary chain (stored prompt → bead title/description) supplies the
text — so `run --for <bead>` is a strict superset of `up <bead>` that
also accepts a literal prompt.

### Similarity warn — the soft floor

Before the spawn, `run` compares the resolved prompt against work
already live in this repo and emits `warning: possible duplicate — …`
on stderr. Advisory only — it never refuses; the spawn proceeds.

Candidates:

- **registry agents** — entries in this repo's `bro/agents.json` that
  are not verifiably terminal (live pid, or no pid to check) contribute
  their stored prompt text (`<agentId>.prompt.md`);
- **foreign sessions** — `DiscoveredSession` rows whose `cwd` resolves
  to the same `git --git-common-dir` as ours contribute their session
  `name` (the devin lock name is the session title slug). Rows with no
  readable cwd, a non-repo cwd, or a cwd in another repo contribute
  nothing; a plane whose scan fails degrades silently — an advisory
  check never stalls a spawn.

Similarity: lowercase alphanumeric token sets, overlap coefficient
`|A∩B| / min(|A|,|B|)` — a match needs `≥ 0.6` AND `≥ 3` shared tokens
(the floor keeps one-word prompts from warning on everything).

### Plane support — `DiscoveredSession.cwd`

`packages/core/src/session-planes.ts` adds optional `cwd?: string` to
`DiscoveredSession` (vendor-neutral: the session's working directory
when the plane can read it). The devin plane fills it from
`devinPidCwd(pid, procDir)` in `listDevinSessions`.

## Out of scope

- Refusing on similarity — advisory only; `--for` is the refuse path.
- `up <step>` / convoy / loop spawns — already claim-deduped.
- Comparing session transcript content — the title slug is the signal
  the observed duplicates shared.
- Excluding the caller's own session — a same-titled live session is
  legitimately "work already covering this prompt", ours included.

## Tests

- `run --for <bead>` on an open bead spawns: claim lands in the store,
  registry row keyed by the bead, literal prompt stored.
- `run --for <bead>` twice → second refuses `already has a live agent`.
- `run --for <bead>` on a bead claimed outside the registry refuses.
- `run --for <bead>` with no prompt uses the bead's title/description.
- `run --for <missing-bead>` fails — no phantom fallback.
- a live session in the same repo with a near-identical name → stderr
  warning; the spawn still lands.
- a session in a DIFFERENT repo with a near-identical name → no warning.
- a live registry agent's stored prompt overlapping the run prompt →
  warning naming the agent.
- dissimilar prompts → no warning, spawn lands.
- `run` without `--for` still mints `adhoc-` and claims nothing.
