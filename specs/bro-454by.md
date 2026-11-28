---

parent: bro-l67jh
scope:
- packages/core/src/providers.ts
- packages/cli/src/commands/providers.ts
- packages/cli/src/commands/providers.test.ts
- packages/core/src/providers.test.ts
- skills/providers/
- site/content/docs/commands/providers.md
- site/content/docs/reference/providers.md

---

# bro-454by — providers: `bro providers add` presets for ACP agents

## Problem

Users hand-write `providers.<name>` ACP entries today. For common ACP agents
(Claude Code, Codex, Gemini CLI, Goose, OpenCode, Kilo, Devin), the correct
command shape and common flags vary and are error-prone to remember. Fleet
activation becomes frictionful when each machine must manually author the
entry. Presets make fleet activation one command: `bro providers add <preset>`
writes a ready-to-use ACP provider entry into the operator config so users can
immediately reference it from `agents.*.provider` or fleet profiles.

The task is to add preset support to `bro providers add` and a smoke test
surface via `bro providers test <name>` (as hinted by design notes).

## Design

### Verified shipped agent presets (to record)

The registry in `packages/cli/src/commands/providers.ts` is the source of
truth for the presets shipped by `bro providers add`. The table below records
the exact command string from that registry and separates a local binary
version check from repository evidence. On 2026-11-28, none of the checked
agent binaries (`kilo`, `claude`, `codex`, `gemini`, `goose`, `opencode`, or
`devin`) was on this machine's `PATH`, so no agent version is claimed here.
`claude-code-acp` is also not installed locally.

| preset | type | agent | shipped command | local version check (2026-11-28) | repository evidence |
| ------ | ---- | ----- | --------------- | --------------------------------- | ------------------- |
| `kilo` | ACP | Kilo Code CLI | `kilo --acp` | not verifiable: `kilo` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the registry command; `packages/agent-e2e/src/bro-command.e2e.test.ts` exercises a real Kilo host when `kilo` is installed (test skips otherwise). |
| `claude-code` | ACP | Anthropic Claude Code | `claude --acp` | not verifiable: `claude` not on `PATH` | Registry and command-writing coverage in `packages/cli/src/commands/providers.test.ts`; no Claude ACP binary fixture or CI install was found. |
| `claude` | CLI | Anthropic Claude Code | `claude -p --dangerously-skip-permissions --output-format stream-json --verbose < {promptFile}` | not verifiable: `claude` not on `PATH` | The preset and exact command are asserted by `packages/cli/src/commands/providers.test.ts`; `packages/agent-e2e/src/manifest.e2e.test.ts` exercises Claude hook artifacts, not the `claude -p` runner. |
| `claude-acp` | ACP | Claude Code ACP adapter | `claude-code-acp` | not verifiable: `claude-code-acp` not on `PATH` | Preset and command-writing coverage in `packages/cli/src/commands/providers.test.ts`; no adapter binary fixture or CI install was found. |
| `codex` | ACP | OpenAI Codex CLI | `codex --acp` | not verifiable: `codex` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the shipped registry entry; `packages/agent-e2e/src/manifest.e2e.test.ts` exercises Codex hook artifacts, not the ACP command. |
| `gemini-cli` | ACP | Google Gemini CLI | `gemini --acp` | not verifiable: `gemini` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the shipped registry entry; no Gemini host fixture, CI install, or live command test was found. |
| `goose` | ACP | Block Goose | `goose acp` | not verifiable: `goose` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the shipped registry entry; no Goose host fixture, CI install, or live command test was found. |
| `opencode` | ACP | OpenCode | `opencode acp` | not verifiable: `opencode` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the shipped registry entry; `packages/agent-e2e/src/opencode.e2e.test.ts` and `packages/agent-e2e/src/hosts/opencode.ts` exercise a real OpenCode host when installed (tests skip otherwise). |
| `devin` | ACP | Devin CLI | `devin --acp` | not verifiable: `devin` not on `PATH` | `packages/cli/src/commands/providers.test.ts` asserts the shipped registry entry; `packages/agent-e2e/src/manifest.e2e.test.ts` exercises Devin hook artifacts, not the ACP command. |

The repository tests verify registry membership and command strings; they do
not establish a vendor binary version. Runtime host tests are explicitly
conditional on the host binary being installed. Presets without a binary
fixture or install evidence remain listed because they are shipped by the
registry, but are marked as repository-only evidence rather than described as
locally or live verified.

### Command surface

Extend `bro providers` with:

- `bro providers add <preset> [--name <name>] [--global] [--force]`
  - Adds a provider entry for the named preset.
  - By default writes to the project config (`bro.config.json`) in cwd (following
    existing patterns like `bro mesh peers add` writing to project config via
    helpers; or follow repo config write conventions). The `--global` flag
    writes to the global operator config under `$XDG_CONFIG_HOME/bro/`
    (`globalConfigDir()`).
  - The entry written is a provider entry of type `acp` with the preset's
    `command` (and possibly `model`/flags as appropriate). The provider name
    defaults to the preset name or can be overridden with `--name`.
  - Must not clobber existing entries without `--force`; error if name exists.
  - Respects config file type: if `bro.config.ts` shadows a JSON config we
    would write, refuse with guidance (mirror `withMeshConfig` behavior).
- `bro providers test <name>` (or equivalent)
  - Smokes the ACP connection via `acpInit` against the configured provider
    entry. Reports success/failure with actionable errors. Exits non-zero on
    failure.
- `bro providers models [name…]` remains unchanged.

### Config writing

Config writes follow project conventions:

- Project config: `bro.config.json` in cwd, atomic write (tmp + rename),
  file lock. Refuse if `bro.config.ts` exists (edit TS directly). Merge
  into existing file (preserve other keys/sections).
- Global config: use `globalConfigDir()` from `@broject/core`; write
  `config.json` there with same atomic write + lock discipline. Refuse if
  `config.ts` shadows.
- Entries go under `providers` map. Validate shape via `parseProviderEntry`
  logic where possible; write only valid `acp` entries.

### Presets registry

Define a presets map (in core or CLI) with metadata: preset id, display
name, default provider name, `acp` entry template (`command`, optional
`profile`, `model`, `autoApprove`, `sessionRm`), verification notes
(version checked). Only include verified presets.

### Integration points

- CLI: `packages/cli/src/commands/providers.ts` extended to handle `add`
  and `test` verbs. Update usage. Plugin contract if needed (group/contract
  in plugins.ts may need updating if subcommands change shape).
- Core: may add helpers for preset lookup/config writing if shared; avoid
  leaking SDK deps into core.
- Skills/docs: update `skills/providers/SKILL.md` and site docs to document
  `add` and `test` with preset list.

## Verify

- Unit tests: adding presets writes correct entries, refuses on conflicts
  without `--force`, respects `--name` and `--global`, refuses when
  `bro.config.ts` shadows, atomic write behavior.
- Integration: `bro providers add kilo --name kilo-cli` creates valid
  provider entry parseable by config loader; `bro providers models kilo-cli`
  works against entry shape.
- Smoke: `bro providers test <name>` attempts acpInit against configured
  entry (mocked in tests). Presets only shipped if verified; verification
  recorded in spec.
- Config validation: written entries pass `parseProviderEntry` and
  don't trigger validation errors in `loadConfig`.
- Lint/typecheck/tests pass as per repo conventions.
