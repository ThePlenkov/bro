---
title: Exit codes
description: The shared exit-code taxonomy every bro command follows — and the stream rule that pairs with it.
---

*Command examples track the upcoming **0.3.0** — grouped
`bro <group> <member>` spellings and `0.3.0` marks are not yet on npm
`latest` (**0.2.5**); use the flat names (`bro convoy run`,
`bro debt status`).*

## The stream rule

**The exit code picks the stream.**

- exit `0` → usage/help text on **stdout**
- exit non-zero → usage/error text on **stderr**

Explicit help exits `0`, so `bro --help | grep review` works at every
level: `bro --help`, `bro help`, `bro <group> --help`,
`bro <cmd> --help` (`bro <group> <member> --help` too). Usage errors
— bad flags, missing args, unknown commands — exit non-zero and write
their usage text to stderr.

## The taxonomy

| code | name | generic meaning | shipped verdict meanings (frozen) |
| ---: | ---- | --------------- | --------------------------------- |
| `0` | ok | success — including explicit `--help` | `act wait` gate OK · `convoy wait` complete · `wait` free |
| `1` | error | failure / negative verdict | `act wait` blocked / timed out · `wait` unreadable |
| `2` | usage | usage error — bad flag, missing arg, unknown command | `convoy wait` stuck / unknown mol · `wait` unresolved |
| `3` | actionable | the wait settled on work only the caller can do | `convoy wait` human gate ready · `wait` actionable (reject / closed-unshipped) |
| `4` | timeout | a bounded wait hit its deadline | `convoy wait` · `wait` — same meaning |

Codes `3` and `4` are **watcher-verdict codes** — a command only uses
them when its exit is a poll verdict (`bro wait` *(0.3.0)*, `bro convoy
wait` *(0.3.0)*,
`bro act wait`, `bro mesh wait`). New code never invents new generic
meanings for them, and shipped numbers are frozen: a "change" that
renumbers a shipped meaning is a contract break.

Documented overloads — preserved, not renumbered:

- `bro wait` *(0.3.0)* overloads `1` (unreadable) and `2` (unresolved — a bad
  ref is a usage-shaped failure).
- `bro convoy wait` *(0.3.0)* overloads `2` (stuck / unknown molecule).
- `bro act wait` reports both blocked and timeout as `1`; `4` stays
  reserved for the deadline verdict elsewhere.
- Bare `bro` exits `1` with usage on stderr — no input is a generic
  error, not a help request. An unknown command exits `2`.

Machine-readable: the table lives as `EXIT_CODES` in `@broject/core`
(`packages/core/src/exits.ts`); `bro contract dump --json` (planned —
bro-k9ces) will serialize it.
