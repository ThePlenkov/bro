---

parent: bro-36sx7
scope:
- packages/cli/src/commands/hooks.ts
- packages/cli/src/commands/hooks.test.ts

---

# bro-36sx7.9 — hooks: skip exit-hook journalCommand for `hooks`

Bead: `bro-36sx7.9` (task) — parent epic `bro-36sx7`. Review #11 of the
static hooks-perf review (`specs/sessions/bro-36sx7.md`, branch
`devin/1792972173-hooks-perf-spec`).

## Problem

`index.ts` registers `process.on('exit') → journalCommand` for every
non-meta command. For `bro hooks <event>` — a fresh process inside the
host agent's ~10s hook budget — the exit handler still runs
`journalCommand`: `hooksStateDir()` (a git spawn) plus
`appendJournal` (lock attempt + sync write + possible trim rewrite)
against `perf/commands.jsonl`. The hook already journals its own perf
row through `flushPerf`, so the cmd row is a second journal write paid
inside the exit path of a latency-critical process — pure stall, and
duplicate telemetry (review #11, A9).

## Design

`journalCommand` returns early for `cmd === 'hooks'`, ahead of the
`hooksStateDir` git spawn — the exit path then costs nothing. The skip
lives inside `journalCommand` rather than at the `index.ts` call site:

- the "what gets journaled" contract stays in one place next to the
  `BRO_TELEMETRY` gate the function already owns;
- `index.ts` stays untouched — the slim `dist/hooks.js` entry
  (bro-36sx7.7, PR #986) is already written expecting this carve-out
  ("bro-36sx7.9 removes the duplicate for the `bro hooks` spelling
  too"), and keeping the guard here means whichever entry calls
  `journalCommand` gets the same answer;
- the guard is unit-testable in `hooks.test.ts` — `index.ts` is the
  process entry and has no in-process test surface.

Coverage is the flat `hooks` spelling: the pre-gate/operator
subcommands (`perf`, `status`, `install`, git-hook events like
`post-merge`) and the bare capability probe skip too. None of them
run `flushPerf`, so they lose their `commands.jsonl` row — accepted:
they are operator/git-hook invocations off the agent's hook budget,
the review says "skip it for `hooks`", and `bro telemetry` (the
user-facing alias for `hooks perf`) still journals under its own cmd
name. Every stdin hook event keeps its latency visible: `flushPerf`
writes the per-session perf row (event total + per-probe rows), which
is the row the cmd entry duplicated.

## Plan

- [ ] `journalCommand` — early return on `cmd === 'hooks'` before the
  telemetry/dir work; doc comment names `flushPerf` as the hooks
  journal and the exit-path stall as the reason
- [ ] `hooks.test.ts` — `journalCommand('hooks', …)` writes no
  `commands.jsonl` row; a sibling cmd still does
- [ ] `npm run build`, `npm run typecheck`, `npm test`
