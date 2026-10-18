# bro-bvipw.2 — codex provider: spawn template + config.toml + env_key token path

Epic: `bro-bvipw`. Depends on: `bro-zkpju` (the `/v1/responses` dialect
the config points codex at).

## Pieces

### 1. `providers.codex` — the spawn template

```json
"codex": { "type": "cli", "command": "codex exec --sandbox danger-full-access - < {promptFile}" }
```

- `codex exec` is the headless surface; `-` is the documented
  forced-stdin prompt (never argv — ps leaks).
- `danger-full-access` because a worker must write files, run git and
  `bd`/`npx bro` commands; the default exec sandbox is read-only.
- The committed entry carries no gateway wiring — at repo level the
  user's own `~/.codex` config decides the model plane, mirroring
  `providers.claude`.

### 2. Dogfood provisioning (`dogfood/codex-plugin.files/`)

- `.codex/config.toml` — spawned with `CODEX_HOME=$PWD/.codex`, it
  loads as codex's trusted USER layer (a project `.codex/` would need
  a per-path `[projects.<dir>] trust_level` grant the scratch can't
  pre-seed). Pins `model_provider = "bro"`,
  `base_url = http://127.0.0.1:44930/v1`, `wire_api = "responses"`,
  `env_key = "BRO_SERVE_TOKEN"`, `model_reasoning_effort = "high"`
  (exercises the effort→composite-pin fold end-to-end).
- `bro.config.local.json` — `serve.backend = devin-acp-max` plus the
  codex spawn template exporting the token:
  `BRO_SERVE_TOKEN=$(npx --no-install bro serve ensure --port {{PORT}})`
  — `env_key` names an env var, so the export must happen in the
  spawn command itself. `{{PORT}}` resolves to the run's allocated
  port at provision (one run's serve never squats another's).

### 3. `dogfood/codex-plugin.md` — the scenario

Mirrors the claude runbook (status → task → worktree → spec →
hello.txt → gate observation → notify → honest stop) with the
assertion surface rewritten for the openai dialect: every turn must
be a `/v1/responses` call on this repo's `bro serve`, visible in
`serve.log` / `conductor.turn` (`dialect: 'responses'`).

## Test

Hermetic: `dogfood.test.ts` validates the committed payload — the
toml pins (provider/wire/env_key/base_url), the bro-side provider
types, the spawn-template token export, and that the toml port equals
the ensure port.

Live: `bro self dogfood run codex-plugin --provider codex` once a
codex binary exists on the machine (tracked as an environment gap —
codex is not installed on this host).
