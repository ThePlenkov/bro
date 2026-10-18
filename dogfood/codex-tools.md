# Scenario: codex function_call loop on the gateway

A `codex exec` session on this repo's `bro serve` must finish a task
REQUIRING codex's built-in tools — file writes and shell commands
travel the wire as `function_call`/`function_call_output` items, so
a real tool loop exercises the dialect's item round-trip end to end.

Setup already done for you: `.codex/config.toml` wires
`model_provider = "bro"`, `wire_api = "responses"`,
`env_key = "BRO_SERVE_TOKEN"`; `bro.config.local.json` carries the
acp backend and the spawn template that exported your token.

## Steps

1. Orient: `npx bro status`.
2. Claim work: `npx bro task new "write an inventory file"`, then
   `npx bro work enter <bead>`.
3. Use your tools deliberately: list the worktree root with your
   shell/file tool, then create `inventory.md` containing that list.
4. Run `git status --short` and `git log -1 --oneline` with your
   shell tool, then commit `inventory.md` on the work branch.
5. Spec the bead: `npx bro spec new <bead>` +
   `npx bro task set <bead> --description='spec: specs/<bead>.md'`.
6. Report: `npx bro notify` — one line naming the tools your turns
   used (shell, apply_patch, …).

## Assert

- Every turn answered `/v1/responses` on this run's `bro serve`
  (`dialect: 'responses'` turn events).
- `inventory.md` exists on the work branch and truthfully lists the
  worktree root — written by a real tool call, not narrated.
- The wire carried `function_call` and `function_call_output` items —
  the Responses dialect's own item shapes, no Anthropic markup. The
  journal rows in `serve-turns.jsonl` show the turns answered.
- The bead is claimed or closed; nothing merged to `main`.
