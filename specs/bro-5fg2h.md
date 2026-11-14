# bro-5fg2h — cli: goal drops verbatim condition text after -- separator

## Problem

Deferred from a PR #613 review thread. `bro goal -- --help` printed the
status instead of setting the goal: `parseGoalArgs` scanned the whole
argv for flags and stripped flag-prefixed tokens from positional args —
including text after the `--` separator. The standard argv contract
(every sibling command — `pulse`, `drill`, `acp`, `exec` — splits on the
first `--` and treats the tail as opaque payload) did not hold for
`goal`, so a condition literally starting with `-` was unwritable.

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
| `goal -- a -- b` | sets condition `a -- b` (first `--` separates, later ones are text) |
| `goal -- k=v "quoted"` | sets condition `k=v quoted`-style text verbatim |
| `goal foo -- bar` | sets condition `foo bar` (head positional + verbatim tail) |

The implementation landed in
[#877](https://github.com/ThePlenkov/bro/pull/877) (`verbatim` flag in
`parseGoalArgs` + `!verbatim` guards on verb dispatch); this bead adds
the spec and the regression tests that pin the contract.

## Verify

- `goal.test.ts` `runGoalCommand` cases: `-- --help` and
  `-- -x flag-ish text` write the literal condition to the goal record;
  `goal --` prints status; `--` twice keeps the second `--` in the
  condition; `=`/quote-bearing text round-trips; `goal -- clear` sets
  rather than clears.
