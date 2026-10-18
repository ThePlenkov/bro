# bro-bvipw.3 — e2e test tree: hermetic dialect suites + dogfood scenarios

Epic: `bro-bvipw`. This bead delivers the tree's **agentic layer**
(the dogfood scenario set + matrix index). The hermetic layer lands
with the dialect PRs themselves:

| layer | artifact | where |
|---|---|---|
| hermetic anthropic | `serve-conductor.test.ts` (+ feature gaps) | main / `bro-bvipw.1` |
| hermetic openai | `serve-conductor-openai.test.ts` | `bro-zkpju` (#589) |
| agentic claude | `claude-{plugin,basics,tools,errors}` | this bead |
| agentic codex | `codex-{plugin,basics,tools,reasoning}` | this bead (+ #590 for codex-plugin) |
| index | `dogfood/matrix.md` | this bead |

## Scenarios

- `claude-basics` — pin, streaming, one retained session across turns.
- `claude-tools` — the client's own Write/Bash loop through the wire.
- `claude-errors` — kills its own listener mid-run; apiKeyHelper
  re-ensures; the run must COMPLETE (recovery, not wedging).
- `codex-basics` — provider block + env_key token path, one task.
- `codex-tools` — `function_call`/`function_call_output` items
  round-trip through a real codex tool loop.
- `codex-reasoning` — `model_reasoning_effort` → `reasoning.effort`
  → the composite pin the conductor logs.
- `matrix.md` — scenario ↔ feature-matrix ↔ hermetic-file index,
  with honest known-gap rows.

All `.files` use `{{PORT}}` (per-run allocation — one run's serve
never squats another's). Claude scenarios reuse the claude-plugin
wiring verbatim; codex scenarios reuse the codex-plugin wiring with
`model_reasoning_effort` restricted to the reasoning scenario (each
matrix row isolates its own feature).

## Environment gap

`codex` is not installed on this host — the codex scenarios are
complete provisioning+runbook artifacts that need the binary to
execute. Their hermetic assertions (payload validity, port
consistency) run in `dogfood.test.ts` today.
