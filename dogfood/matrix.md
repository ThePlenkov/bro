# Dogfood matrix — the epic's proof tree (spec bro-bvipw)

One row per scenario ↔ the gateway/client features it exercises.
Every scenario provisions its client wiring via `<name>.files/`
(`{{PORT}}` resolves to the run's allocation) and lands evidence in
the bro store: serve.log `conductor.turn` events, the runner's bead
claim, the analyst's verdict.

| scenario | client | wire | exercises | hermetic home |
| --- | --- | --- | --- | --- |
| `claude-plugin` | claude -p | `/v1/messages` | plugin surface: native commands, hooks, stop-gate, settings.local.json + apiKeyHelper | `serve-conductor.test.ts` |
| `claude-basics` | claude -p | `/v1/messages` | model pin, streamed deltas, multi-turn retained session | `serve-conductor.test.ts` (retained sessions) |
| `claude-tools` | claude -p | `/v1/messages` | real client tool loop (Write/Bash) through the wire | `serve-conductor.test.ts` |
| `claude-errors` | claude -p | `/v1/messages` | killed listener → apiKeyHelper re-ensure → recovery | `serve.ts` ensure path; `bro-ofbw4` lifecycle |
| `codex-plugin` | codex exec | `/v1/responses` | provider block, env_key token path, AGENTS.md/native surface | `serve-conductor-openai.test.ts` |
| `codex-basics` | codex exec | `/v1/responses` | provider resolution, model pin, basic task | `serve-conductor-openai.test.ts` |
| `codex-tools` | codex exec | `/v1/responses` | `function_call`/`function_call_output` item round-trip | `serve-conductor-openai.test.ts` (function_call round-trip) |
| `codex-reasoning` | codex exec | `/v1/responses` | `model_reasoning_effort` → `reasoning.effort` → composite pin | `serve-conductor-openai.test.ts` (effort fold) |

## Coverage notes

- **Hermetic suites** (fake acp peer, `tsx --test`):
  `serve-conductor.test.ts` — anthropic plane + retention;
  `serve-conductor-openai.test.ts` — both OpenAI dialects
  (responses + chat/completions); anthropic feature-gap cases
  (tool_choice, stop_sequences, keepalive, error taxonomy) land in
  the same suites as they merge via `bro-bvipw.1`/`bro-zkpju`.
- **Client settings surfaces** covered: claude `model` +
  `apiKeyHelper` + `ANTHROPIC_BASE_URL` + `enabledPlugins`; codex
  `model`/`model_provider`/`base_url`/`env_key`/`wire_api`/
  `model_reasoning_effort` + `CODEX_HOME` user-layer trick.
- **Known gaps** (tracked, not hidden): `ANTHROPIC_SMALL_FAST_MODEL`
  mapping (`bro-bvipw.1`), host-scope single listener (`bro-dluwn`),
  dead-listener windows under a live client (`bro-ofbw4`), a real
  codex binary on this host (environment gap — the codex rows
  provision but need `codex` installed to run).
