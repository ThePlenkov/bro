# bro-19g — SDD enforcement: spec-first policy via connector hooks

## Problem

Agents (and humans) jump from a claimed bead straight to code. The
reasoning that should survive — what and why before how — ends up in a
chat transcript or nowhere. bro already owns the channel that reaches
every agent session: connector hook probes inject `additionalContext`
at session start / prompt submit and gate Stop. SDD ("spec-driven
development": every claimed bead has a written spec before code) is
exactly the kind of policy that channel exists to carry — but nothing
emits it today, so the rule lives or dies by whoever wrote the prompt.

## Design

Spec = an artifact that survives code review, not a bead field:

- `specs/<bead-id>.md` in the repo (non-empty), or
- a `spec:` link in the bead description (external doc).

Exempt by nature: beads typed `chore` or labeled `trivial` (no design
mass) or `debt` (a harvested finding carries its own evidence) — the
gate measures design, not bookkeeping.

Policy surface — a new `sdd` capability, plugin-shaped:

- `bro.config.json` section `sdd`: `{ "mode": "off"|"remind"|"gate",
  "dir": "specs" }`. `off` is the default — opt-in per repo. The config
  is committed, so the policy applies to every agent in the repo, not
  just whoever enabled it locally.
- `sddConnector` (cli package, `workConnector` pattern — the command
  owns its connector). Probes self-gate on `loadBroConfig().sdd.mode`,
  so registration is unconditional and cost is zero where disabled.
  - `sessionStart` — the policy line, plus each of *this session's*
    claimed beads missing a spec (via `sessionTaskClaims` — foreign
    claims are never my business, same rule as `parallelWork`).
  - `promptSubmit` — the missing-spec nudge while any own claim lacks
    a spec; silent otherwise.
  - `stopGate` — mode `gate` contributes a block under aspect `task`
    (armed by `bd --claim` / `bro work enter`); mode `remind` emits the
    same state as passive context. One block, then Stop passes —
    gates, not loops.
- `bro spec check [id…]` — coverage report over `in_progress` beads
  (or the given ids): `spec|link|exempt|MISSING`. Exit 1 on any
  MISSING — CI-able.
- `bro spec new <id>` — scaffold `specs/<id>.md` from the bead title.
  Refuses to overwrite.

## Plan

- [ ] `sddSection` in core `config.ts` (`{mode, dir}`, default off/specs)
- [ ] export `sessionTaskClaims` from connectors.ts
- [ ] `commands/spec.ts`: spec detection, `check`/`new`, `sddConnector`
- [ ] register connector + `spec` plugin (`configKey: 'sdd'`)
- [ ] `skills/sdd/SKILL.md`; repo `bro.config.json` → `sdd.mode: "gate"`;
      this file is its own first spec
- [ ] tests: detection states, probe gating, check exit codes
