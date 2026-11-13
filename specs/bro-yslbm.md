# bro-yslbm — a 'claude' provider preset: claude-brain workers go first-class

## Problem

The claude CLI is installed on operator hosts, but nothing in bro makes
it a provider: `bro providers add` (PR #803) ships only `acp` presets,
and the one naming claude — `claude-code` → `claude --acp` — targets a
flag current claude builds don't advertise (`claude --help` shows no
`--acp`/`acp`). The verified-working shape is a `cli` entry that feeds
the prompt file to `claude -p` on stdin — hand-added to
`bro.config.local.json`, this line passes `bro agents up --provider
claude`:

    claude -p --dangerously-skip-permissions --output-format stream-json --verbose < {promptFile}

Without it the fleet cannot spawn claude-brain workers even though the
binary sits on PATH — `devin-acp` is the only claude-capable provider
and rides the `agents.devin.maxSessions` account wall.

## Design

### 1. Presets carry their kind

`cmdAdd` hardwires `type: 'acp'` — the table gains a `type` per preset
(the existing seven stay `acp`). Two presets land:

- **`claude`** → `{ type: 'cli', command: 'claude -p
  --dangerously-skip-permissions --output-format stream-json --verbose
  < {promptFile}' }` — the verified line, verbatim. `{promptFile}`
  expands to `"$BRO_PROMPT_FILE"`, so `< {promptFile}` is a stdin
  redirect under the usual `sh -c` spawn. `--dangerously-skip-
  permissions` is the worker contract: a fleet spawn has no human to
  answer a permission prompt. The entry pins no `model` — claude runs
  its configured default; an operator wanting a pin adds
  `model`/`{model}` themselves (the cli kind's existing fields).
- **`claude-acp`** → `{ type: 'acp', command: 'claude-code-acp' }` —
  the Zed adapter binary on PATH. A preset is a command *string*, not a
  dependency: shipping it adds no package. A host without the adapter
  learns that at spawn/`bro providers test` time, same as any preset
  naming a missing binary. It is also the only honest ACP spelling
  where `claude --acp` doesn't exist; where it does, `claude-code`
  remains the in-CLI route and both presets are valid.

### 2. Doctor nudges the install that exists

A `providers` row fires when `claude` resolves on PATH but no
configured provider's `command` runs it — status `ok` with a hint
("`bro providers add claude [--global]`"), not a warn: not wanting
claude workers is a choice, never a defect (same posture as the
plugins row's `bro plugins install` nudge). PATH is the contract —
`probeBin('claude')`, the same lookup every bro shell-out uses. Claude
stays special-cased deliberately: it is the preset with verified
demand (the bead's hand-rolled config); a generic "every preset binary
unconfigured" sweep would probe seven binaries and nudge for tools the
operator never asked about.

## Tests

- `bro providers add claude` writes `{ type: 'cli', command: 'claude -p
  … < {promptFile}' }` to `bro.config.json`; `--name`/`--global`/
  `--force` semantics unchanged.
- `bro providers add claude-acp` writes the `acp` entry.
- The written entries pass `parseProviderEntry` (the add path already
  validates — the tests exercise it end to end).
- Doctor: claude on PATH + no claude provider → the nudge row; a
  provider whose command names claude → no row; claude absent → no
  row. (The test harness shims `claude` into `bin/`.)

## Non-goals

- Auto-injecting `providers.claude` into project config — a preset is
  opt-in (`bro providers add`), never silent config (the operator/
  global layer stays the operator's choice).
- Fixing or removing the `claude-code` (`claude --acp`) preset — if the
  flag truly is gone from claude that's a separate bead; this spec only
  ships the verified-working routes.
- A `models` catalog template for the cli entry — claude has no stable
  machine-readable model listing; the pinned-model surface is enough.
