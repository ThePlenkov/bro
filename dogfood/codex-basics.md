# Scenario: codex basics on the gateway — one task through /v1/responses

A `codex exec` session runs entirely on this repo's `bro serve` —
every turn is a `/v1/responses` call the conductor translates into a
`devin acp` session. This scenario proves the boring fundamentals:
the provider block resolves, the model pin lands, and a basic task
completes on the OpenAI dialect.

Setup already done for you: `.codex/config.toml` (your trusted user
layer — `CODEX_HOME` points here) wires `model_provider = "bro"`,
`wire_api = "responses"`, `env_key = "BRO_SERVE_TOKEN"`, and
`bro.config.local.json` carries the acp backend plus the spawn
template that exported your token.

## Steps

1. Orient: `npx bro status` — reconcile with AGENTS.md context.
2. Report your model plane: state which provider/model you believe
   you run on (your config.toml) and which env var carried your key.
3. Claim work: `npx bro task new "add a greeting.txt"`, then
   `npx bro work enter <bead>`, `npx bro spec new <bead>`,
   `npx bro task set <bead> --description='spec: specs/<bead>.md'`.
4. Implement: create `greeting.txt` with `hello from codex basics`,
   commit it on the work branch.
5. Report: `npx bro notify` one line.

## Assert

- Every turn answered `/v1/responses` on this run's `bro serve`
  (`serve-turns.jsonl` `conductor.turn` rows carry
  `dialect: 'responses'`).
- `greeting.txt` exists on a work branch; the bead is claimed or
  closed, never orphaned; nothing merged to `main`.
- The runner correctly identified `bro`/`devin/swe-2-max` and
  `BRO_SERVE_TOKEN` as its model plane.
