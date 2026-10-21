# bro-e2ec0 — worker stderr splits into `<agentId>.stderr`; `.log` stays the event stream

## Problem

Every local backend wires the worker's stdout **and** stderr into the
same `<agentId>.log`:

- native: `stdio: ['ignore', logFd, logFd]`
- tmux: `{ run; s=$?; …; } 2>&1 | tee -a log`
- docker: `{ run; s=$?; …; } >> log 2>&1`

The acp driver mirrors the agent child's stderr onto its own stderr
(spec bro-5hx1.1 §6 — provider walls must reach the classifier input),
so a chatty agent (`devin acp`'s `chisel_agent`/`session_db_call` INFO
lines, demo 2026-10-16) lands interleaved between `tool_call` and
`agent_message_chunk` lines. `.log` is the consumer-facing stream —
`bro agents log`, the serve SSE replay, the drive tail quotes — and it
stops being agent updates only.

## Design

The split happens at the fd layer, so it covers every worker kind
(template and argv alike), not just acp:

- `commitSpawn` mints `<agentId>.stderr` beside `<agentId>.log` and
  records `stderrLog` + `stderrFrom` on the registry entry — the same
  append-across-respawns offset semantics `log`/`logFrom` already carry.
- native: `stdio: ['ignore', logFd, errFd]` — `errFd` appends to the
  `.stderr` file.
- tmux: the brace group's `2>&1 | tee` becomes `2>> stderr | tee -a log`
  — stderr to the capture, stdout alone through the pipe.
- docker: `>> log 2>&1` becomes `>> log 2>> stderr` — the same mounted
  `home`, so the file lands where the host reads it.
- Remote backends (gascity, copilot, devin) run no local worker — nothing
  to split; copilot's entry clears the fields the way it clears `log`.

`ensureExitCause` classifies on **`.log` tail + `.stderr` tail** —
provider walls (rate-limit/quota text) still classify, they just arrive
via the capture instead of the stream. This narrows bro-5hx1.1 §6's
"must reach the `.log`" to "must reach the classifier input"; the
observability plane is `.log`, the diagnosis plane is both tails.

Retention: the janitor's live-agent cap covers `.stderr` with the same
whole-line tail-keep it applies to `.log`; orphan reaping already
unlinks `<agentId>.*` as one home set.

`bro agents status <id>` surfaces `stderr:` when the entry carries a
capture — a capture nobody can find is not a capture.

## Non-goals

- Worker-side changes: the acp driver still mirrors child stderr to its
  own stderr fd verbatim — raw text is what the classifier greps. A
  direct `bro acp-worker …` run keeps diagnostics on fd 2; the caller's
  own `2> file` is the capture.
- `bro agents log --stderr` — `status` naming the path is enough.
- Line-prefixing or filtering child stderr content.

## Plan

- [x] this spec
- [x] `commitSpawn`/`prepareSpawn` mint + return `stderrLog`; registry
      stamps `stderrLog`/`stderrFrom`
- [x] native/tmux/docker spawn wiring
- [x] `ensureExitCause` classifier input += .stderr tail
- [x] janitor cap covers `.stderr`
- [x] `AgentInfo.stderrLog` + `bro agents status` row
- [x] tests: stderr lands in `.stderr` not `.log` (native argv spawn),
      classifier reads the `.stderr` tail, janitor cap
- [x] `npm test`
