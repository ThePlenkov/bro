---
parent: bro-6vcll
scope:
  - packages/cli/src/commands/goal.ts
  - packages/cli/src/commands/goal.test.ts
  - specs/goal/bro-6vcll.md
  - specs/bro-5fg2h.md
---

# bro-5fg2h — cli: goal drops verbatim condition text after -- separator

Child of bro-6vcll (specs/goal/bro-6vcll.md) — the owning spec for
`bro goal`; its CLI section names the `--` form and points here for the
verbatim contract.

## Problem

Deferred from a PR #613 review thread. `bro goal -- --help` printed the
status instead of setting the goal: `parseGoalArgs` scanned the whole
argv for flags and stripped flag-prefixed tokens from positional args —
including text after the `--` separator. The standard argv contract
(the sibling commands that take an opaque payload — `pulse`, `drill`,
`acp` — split on the first `--` and treat the tail as opaque) did not
hold for `goal`, so a condition literally starting with `-` was
unwritable.

## Design

`parseGoalArgs` splits argv at the **first** `--`:

- **head** (before `--`): option parsing only — `--session <id>`,
  `--turns <n>`, `--json` are consumed here; remaining non-`--` tokens
  stay positional. `hasHelpFlag` (core `exits.ts`) already applies the
  same head-only rule to `--help`/`-h`.
- **tail** (after `--`): verbatim condition text — appended to the
  positional list untouched. No flag parsing, no truncation, no verb
  dispatch: a tail exists ⇒ `verbatim` is set, which suppresses
  `clear`/`pause`/`resume`/`status` dispatch so `bro goal -- clear`
  sets a goal whose condition is `clear` rather than clearing.

Consequences, by edge case:

| argv | result |
| --- | --- |
| `goal -- --help` | sets condition `--help` (not usage, not status) |
| `goal -- -x flag-ish text` | sets condition `-x flag-ish text` |
| `goal --` (empty tail) | status — no condition text was given |
| `goal -- ""` / `goal ""` | status — an empty or whitespace-only joined condition is no condition; writing it would record a goal `readGoal` rejects |
| `goal -- a -- b` | sets condition `a -- b` (first `--` separates, later ones are text) |
| `goal -- k=v "quoted"` | sets condition `k=v quoted`-style text verbatim |
| `goal foo -- bar` | sets condition `foo bar` (head positional + verbatim tail) |

The implementation landed in
[#877](https://github.com/ThePlenkov/bro/pull/877) (`verbatim` flag in
`parseGoalArgs` + `!verbatim` guards on verb dispatch); this bead adds
the spec, the regression tests that pin the contract, and the
empty-condition guard in `runGoalCommand` (a whitespace-only joined
condition takes the status path instead of writing an unreadable
record).

## Verify

- `goal.test.ts` `runGoalCommand` cases: `-- --help` and
  `-- -x flag-ish text` write the literal condition to the goal record;
  `goal --`, `goal -- ""`, and `goal ""` print status without writing;
  `--` twice keeps the second `--` in the condition; `=`/quote-bearing
  text round-trips; `goal -- clear` sets rather than clears.
