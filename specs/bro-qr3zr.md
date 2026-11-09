# bro-qr3zr — the published-surface parser must read the grouped top-level help

## Problem

`check:onboarding` is the docs↔release gate: it installs the published
`@broject/bro` into a scratch prefix, reads its `--help`, and asserts that
every copy/paste `bro <word>` line in the onboarding pages dispatches on the
published surface (spec bro-l8c4f.17).

The gate's reader is `scripts/published-surface.ts`. It parses the top-level
help by looking for a `Commands:` block:

```ts
if (/^\s*Commands:\s*$/.test(line)) { inCmds = true; continue; }
```

The CLI's top-level help has been **grouped** since bro-b5v2t (#396): it
prints a `Groups:` block (group name + its members) and a `Top-level:` block
(the flat commands), and a group prints `Members:` where a plain command
prints `Commands:`.

The parser was written against the flat 0.2.5-era help and was never moved
to the grouped shape. Against npm latest 0.3.0 (grouped) it finds **zero**
commands, and the gate dies before it checks a single doc line:

```text
@broject/bro@latest: no Commands: block parsed from `bro --help`
```

That failure is repo-wide: it hits every branch, `main` included, from the
moment 0.3.0 reached npm. It blocks every PR whose `build-test` runs the
gate — the gate cannot see the published surface at all, so every
documented `bro <word>` line would be judged against an empty surface.

Two parsers are stale in the same way:

- `parseTopLevelHelp` — the top-level help (`Commands:` → `Groups:` +
  `Top-level:`).
- `HelpDoc.collectBlock` — a command/group's own help (`Commands:` →
  `Members:` for a group).

## Design

### The reader knows both shapes

The published surface is a moving target: it changes with every release, and
the reader is what decides whether the gate can see it at all. The parser
therefore reads **every** block shape the CLI has shipped, not just the one
that happened to be current when it was written:

- top-level help: `Commands:` (flat, ≤0.2.5) **or** `Groups:` +
  `Top-level:` (grouped, ≥0.3.0);
- a command/group's own help: `Commands:` **or** `Members:`.

The block header is a set of names, not one name. A block still ends at the
first blank line, so `Options:` and `Examples:` are never read as commands.

### A row is a name and a summary

The grouped top-level help pads the name into a column, and a name that
fills the column exactly (`pipeline`) is followed by a **single** space:

```text
  review   PR review loop — gates, threads, debt
  pipeline pipeline customer surface — accept verdicts, intake answers
```

The row regex therefore separates name and summary on **one or more**
spaces, not two. A group's member list is indented deeper than the name
column and never reads as a row.

### Nothing else moves

The gate's semantics are unchanged: the same doc lines are checked, the
same live names, the same subcommand assertions. Only the reader's
vocabulary grows — a fix to the reader, not to the gate.

## Contract

| published help | block headers read | before | after |
| --- | --- | --- | --- |
| flat (≤0.2.5) | `Commands:` | parsed | parsed (unchanged) |
| grouped (≥0.3.0) | `Groups:`, `Top-level:` | **zero commands → gate dies** | parsed |
| group help | `Members:` | no subcommands | members parsed as subcommands |

## Tests

- `npm run check:onboarding` against npm latest → passes (today: dies with
  "no Commands: block parsed").
- The gate still fails on a doc line that names an unpublished command —
  the reader's fix must not turn the gate into a no-op.
- `npm run gen:published -- --check` still reports the manifest drift
  honestly (the snapshot is a release chore, not this fix).

## Out of scope

- **Refreshing `contract/published.json` to 0.3.0.** The manifest is a
  release chore (`npm run gen:published`); a stale manifest already
  downgrades the subcommand assertions to warnings, exactly as documented.
  This fix makes the gate *see* the surface again — it does not decide when
  the snapshot is refreshed.
- **A test project for `scripts/`.** The scripts directory is outside the
  nx project graph, so it has no unit-test target today. The gate itself is
  the regression test: it runs against the live published package on every
  PR, which is exactly the surface whose format broke.
