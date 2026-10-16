# bro-nt503 — agents log renders devin session transcripts

## Problem

`bro agents log devin:<name>` resolves `devinPidLog` — the acp-bridge
plumbing trace (`session_db_call`, `time.busy=` spans). It proves the
process is alive but never answers the operator's actual question:
*what is the agent doing right now?*

The readable plane already exists on disk:
`~/.local/share/devin/cli/transcripts/<lock-name>.json` — ATIF
(`schema_version: ATIF-v1.7`) documents whose `steps[]` carry
`source` (`agent`/`user`/`system`), `message`, and `tool_calls[]`
(`function_name`, `arguments`). Verified live: a running session's
transcript updates mid-flight; flush cadence varies per session and a
resumed session keeps its name.

## Design

- `devinTranscriptsDir(bag, env)` — sibling `transcripts/` of
  `session_locks`, same derivation contract as `devinLogsDir`
  (`transcriptsDir` bag override wins; a custom `lockDir` nests the
  default inside the override so it never escapes the chosen root).
- `devinSessionTranscript(name, dir)` — `transcripts/<name>.json` when
  the file exists.
- `renderDevinTranscript(json)` — `steps[]` → lines:
  - `tool_calls` → `→ <function_name>(<brief args>)` — `command` args
    print the command; objects truncated at ~160 chars
  - non-empty `message` on `agent`/`user`/`system`-visible sources →
    `<source>: <message>`
  - `source === 'system'` steps are skipped — user_action/metadata
    blobs are plumbing noise, one summary count is emitted instead
  - each line prefixed `[HH:MM:SS]` from the step timestamp
  - a mid-rewrite (torn JSON) parse failure reports `undefined`, never
    throws — the caller retries next tick
- `cmdLog` (`bro agents log`): when the resolved agent's backend is
  `devin`, the id is `devin:`-prefixed, and a transcript exists →
  print the rendered tail (`--lines`) and `--follow` polls the file,
  re-parses, and emits steps with `step_id` past the watermark.
  Otherwise → existing byte-tail on `a.log` (bridge log fallback;
  sessions without a transcript keep today's behavior).

## Out of scope

- serve's `/api/v1/agents/<ref>/log?follow` keeps serving raw bytes —
  the renderer is reusable later, not wired now.
- Interactive-session stdin/approval surfaces.

## Acceptance

`bro agents log devin:<live-session>` prints the agent's recent
tool calls and messages as text; `-f` appends new steps as the
transcript flushes; `bro agents log devin:<no-transcript>` behaves
exactly as today.
