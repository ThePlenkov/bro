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

### Verified ACP agent entrypoints (to record)

We must verify current ACP entrypoints/adapter names and record versions in
the spec; drop any that don't exist. Based on codebase conventions and common
ACP entrypoints to support as presets (conservative set):

| preset        | agent             | typical ACP command (example)                                               | notes                                                                  |
| ------------- | ----------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `claude-code` | Claude Code       | `claude --acp` or via `@zed-industries/claude-code-acp` / `claude-code-acp` | May need specific package/flags; verify existence in environment/docs. |
| `codex`       | OpenAI Codex CLI  | `codex --acp` or `codex-acp`                                                | Verify current binary name.                                            |
| `gemini-cli`  | Google Gemini CLI | `gemini --experimental-acp` or `gemini --acp`                               | Verify.                                                                |
| `goose`       | Block Goose       | `goose acp` or `goose --acp`                                                | Verify.                                                                |
| `opencode`    | OpenCode          | `opencode acp` or `opencode --acp`                                          | Verify.                                                                |
| `kilo`        | Kilo Code CLI     | `kilo --acp`                                                                | Already seen in codebase/tests.                                        |
| `devin`       | Devin CLI         | `devin --acp` or `devin acp`                                                | Seen as `devin -p --acp` in some contexts.                             |

The implementation must only ship presets for agents whose entrypoints exist
and are verifiable at the time of implementation; unverified presets are not
shipped. The spec records verification results and chosen command strings.

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
