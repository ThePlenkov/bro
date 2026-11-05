---
parent: bro-6ptci
scope:
  - packages/core/src/exits.ts
  - packages/core/src/index.ts
  - packages/cli/src/index.ts
  - packages/cli/src/commands/args.ts
  - packages/cli/src/commands/*.ts
  - site/content/docs/exit-codes.md
  - site/content/docs/meta.json
---

# bro-1znlu — help to stdout, usage errors to stderr, the exit-code taxonomy

Parent: `bro-6ptci` (epic — the CLI is the agent contract). Unblocks
`bro-fl5o5` (typed CommandError + one process.exit at the dispatcher).
Feeds `bro-k9ces` (`bro contract dump --json`) — the taxonomy table is
the data the dump serializes.

## Problem

`bro --help | wc -l` prints `0`: every usage path — including explicit
`--help` — writes to **stderr**. Piping, `| grep`, `| less`, and agents
that read stdout all see nothing. `bro <group> --help` is worse: the
member lookup fails, the group table prints to stderr, and the exit
code is **1** — asking for help reads as an error.

Exit codes grew per command with no shared table:

| surface | shipped codes today |
| ------- | ------------------- |
| `bro act wait` | `0` gate settled OK · `1` blocked / timed out / not armed · `2` usage |
| `bro convoy wait` | `0` all complete · `2` stuck / unknown mol · `3` human gate ready · `4` timeout |
| `bro wait external:` | `0` free · `1` unreadable · `2` unresolved · `3` actionable · `4` timeout |
| `args.ts` helpers | `2` on every usage error (192 call sites) |
| dispatcher (`index.ts`) | `1` unknown command / bare `bro` · `0` `--help` (to stderr) |

An agent cannot predict a code without reading source, and `--help`
behavior differs per command (some exit `0`, most exit `1`, some treat
it as an unknown flag).

## Design

### The stream contract

One rule, mechanical: **the exit code picks the stream.**

- exit `0` → usage/help text on **stdout**
- exit non-zero → usage/error text on **stderr**

Explicit help exits `0`, so `--help` lands on stdout everywhere it is
honored:

- `bro --help` / `-h` / `help` — the dispatcher's command table
- `bro <group>` and `bro <group> --help` — the group's member table
- `bro <cmd> --help` / `-h` (and `bro <group> <member> --help`) — the
  member's own usage

Usage errors keep their streams (stderr) and their **existing codes** —
no shipped code changes meaning. A command whose parser doesn't define
`--help` still answers it honestly: strict arg parsing already rejects
unknown flags with `2` on stderr.

### Shared plumbing

`packages/core/src/exits.ts` exports the contract in both forms:

- `EXIT` — the taxonomy constants (`ok=0`, `error=1`, `usage=2`,
  `actionable=3`, `timeout=4`)
- `EXIT_CODES` — the documented table (`{code, name, meaning}`) — the
  registry `bro contract dump` (bro-k9ces) serializes
- `printUsage(text, code)` — the stream rule as a function: `code === 0`
  writes stdout, anything else stderr, then `process.exit(code)`

`commands/args.ts` re-exports nothing new — commands import
`printUsage`/`EXIT` from `@broject/core` alongside `warnDeprecated`.

### The taxonomy

| code | name | generic meaning | shipped verdict meanings (frozen) |
| ---- | ---- | --------------- | --------------------------------- |
| `0` | `ok` | success — including explicit `--help` | `act wait` gate OK · `convoy wait` complete · `wait` free |
| `1` | `error` | failure / negative verdict | `act wait` blocked/timeout · `wait` unreadable |
| `2` | `usage` | usage error (bad flag, missing arg, unknown command) | `convoy wait` stuck / unknown mol · `wait` unresolved (bad ref) |
| `3` | `actionable` | the wait settled on work only a caller can do | `convoy wait` human gate ready · `wait` actionable (reject/closed-unshipped) |
| `4` | `timeout` | bounded wait hit its deadline | `convoy wait` · `wait` — same meaning |

`3` and `4` are **watcher-verdict codes** — a command only uses them
when its exit is a poll verdict (`convoy wait`, `bro wait`). New code
uses `EXIT.*` names; the shipped numbers are frozen — a "change" that
renumbers a shipped meaning is a contract break.

Exceptions documented, not renumbered:

- `bro wait` overloads `1`/`2` with verdict meanings (unreadable,
  unresolved) — frozen.
- `bro convoy wait` overloads `2` (stuck, unknown mol) — frozen.
- `bro act wait` reports blocked and timeout as `1` — frozen; `4` is
  reserved for the deadline verdict everywhere else.
- dispatcher: bare `bro` stays `1` (no input is a generic error, not a
  help request); unknown command moves `1 → 2` — it IS the canonical
  usage error, same as `bro <group> <unknown-member>` (the old `1`s
  were undocumented).

### Sweep

Every `usage()`/`USAGE` print site routes through `printUsage`:

- `index.ts` — `usage(exitCode)` → `printUsage`; `dispatchGroup` gains
  the `-h|--help` member check; `help` becomes a top-level alias for
  `--help`.
- command files — `--help`/`-h` sites pass `0`; functions gain an
  `exitCode` param where they lacked one. Files with usage but no
  `--help` handling (`work`, `stack`, `spec`, `mesh`, `request`, `rig`)
  get the standard `-h|--help → usage(0)` line.
- bare-command usage (`bro act` with no subcommand) keeps its existing
  non-zero code → stays on stderr.

### Docs

`site/content/docs/exit-codes.md` — the taxonomy table, the stream
rule, and the per-command verdict exceptions — linked from `meta.json`
under Reference.

## Verify

- `bro --help | grep review` non-empty; `bro --help | wc -l` > 0.
- `bro review --help`, `bro fleet --help` → stdout, exit 0.
- `bro help` → stdout, exit 0.
- `bro act --help`, `bro review act --help`, `bro drill -h` → stdout, 0.
- `bro bogus`, `bro review bogus`, `bro act bogus` → stderr, non-zero.
- `npm test` — a new e2e spec asserts the stream+code matrix; existing
  e2e (deprecation, act-wait, convoy) stays green — shipped codes
  unchanged.
- `npm run build && npm run typecheck` clean.
