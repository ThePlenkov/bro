# bro-1r5cd — consumer AGENTS.md budget

## Problem

`AGENTS.md` is loaded by every agent consuming this plugin, but it is about
400 lines long.  It mixes rules that every agent needs while working in a
consumer repository with implementation and operations notes for contributors
to bro itself (including Beads parsing, retro references, and merge-cycle
machinery).  The mixed document spends the consumer's context budget on
details that are not part of the consumer contract.

## Design

Keep `AGENTS.md` at no more than 40 lines.  Its short form retains:

- what bro provides and the always-followed review, drill, and lesson gates;
- the consumer-facing engineering conventions (safe seams, green-on-first-
  write static-analysis shapes, generated-code doctrine, and no secrets);
- verify-like-CI, conflict resolution by hunk, config parsing, failure
  semantics, PR-link formatting, and worktree/executor safety; and
- the pointer to `CONTRIBUTING.md` for work on bro itself.

Move the complete detailed conventions, operations guidance, convoy fan-out,
and Cursor Cloud instructions to a clearly titled section at the end of
`CONTRIBUTING.md`.  Preserve that material rather than summarizing it, so
contributors lose no implementation or operational contract.  The existing
docs check continues to validate config claims in the shortened `AGENTS.md`;
no validator behavior or references need changing.

The 40-line budget is intentional: it bounds the mandatory prompt/context
cost paid by every consuming agent while leaving the full contributor manual
available on demand.

## Verify

- `wc -l AGENTS.md` is at most 40.
- The moved section in `CONTRIBUTING.md` contains the former detailed
  conventions, operations, convoy, and Cursor Cloud text.
- `grep` confirms scripts and CI references remain valid and are unchanged
  unless a check requires otherwise.
- `npm run check:docs` passes (including config, Node-floor, and setup claims).
