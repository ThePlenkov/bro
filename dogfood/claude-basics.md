# Scenario: claude basics on the gateway — pin, streaming, multi-turn

A `claude -p` session runs entirely on this repo's `bro serve` —
every turn is a `/v1/messages` call the conductor translates into a
`devin acp` session. This scenario proves the boring fundamentals:
the model pin lands, streamed deltas arrive, and a multi-turn
exchange rides ONE retained acp session.

Setup already done for you: `.claude/settings.local.json` wires the
conductor listener (`apiKeyHelper` → `bro serve ensure`, model
`devin/swe-2-max`, `ANTHROPIC_BASE_URL` at this run's port) and
`bro.config.local.json` carries the acp backend.

## Steps

1. Orient: `npx bro status` — reconcile with session context.
2. Report your model: state plainly which model you believe you are
   running on and where the setting came from (your settings file).
3. Multi-turn proof: ask yourself nothing — instead do two dependent
   actions in sequence (claim the bead, THEN edit the spec) and note
   that context carried across them naturally.
4. Claim work: `npx bro task new "add a greeting.txt"`, then
   `npx bro work enter <bead>`, `npx bro spec new <bead>`,
   `npx bro task set <bead> --description='spec: specs/<bead>.md'`.
5. Implement: create `greeting.txt` with `hello from claude basics`,
   commit it on the work branch.
6. Report: `npx bro notify` one line; name the conductor events you
   would check to prove the wire (`conductor.turn` in `serve.log`).

## Assert

- Every turn answered `/v1/messages` on this run's `bro serve`
  (serve.log `conductor.turn` events; `session_reused` true after
  the first turn — one retained session served the conversation).
- The runner named `devin/swe-2-max` (or the served alias) as its
  model — the pin round-trips.
- `greeting.txt` exists on a work branch; the bead is claimed or
  closed, never orphaned; nothing merged to `main`.
