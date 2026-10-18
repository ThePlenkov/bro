# Scenario: codex reasoning_effort reaches the backend pin

A `codex exec` session on this repo's `bro serve` runs with
`model_reasoning_effort = "high"` in its config — on the wire that
field becomes `reasoning.effort`, and the conductor folds it into a
composite model pin (`<base>-<effort>` → model + thought_level on
the acp session). You are proving the fold actually happened, not
that the config merely parsed.

Setup already done for you: `.codex/config.toml` carries
`model_reasoning_effort = "high"` next to `model_provider = "bro"`
and `wire_api = "responses"`; `bro.config.local.json` carries the
acp backend and the token-exporting spawn template.

## Steps

1. Orient: `npx bro status`.
2. Read your own `.codex/config.toml` — state the value of
   `model_reasoning_effort` it carries.
3. Claim work: `npx bro task new "prove effort lands"`, then
   `npx bro work enter <bead>`.
4. Create `effort.txt` containing `high effort landed`, commit it on
   the work branch.
5. Inspect the wire yourself: read `.git/bro/serve.json` for `url`
   and `token`, then probe the conductor directly —

   `curl -s "$URL/v1/responses" -H "authorization: Bearer $TOKEN"
   -H 'content-type: application/json'
   -d '{"model":"devin/swe-2-max","reasoning":{"effort":"high"},
   "input":"ping"}'`

   The Response's `model` field is what the conductor served — the
   effort-derived composite pin (`…-high`), not the bare base.
6. Report: `npx bro notify` — one line stating the effort you sent
   and the pin the conductor answered with.

## Assert

- Every turn answered `/v1/responses` on this run's `bro serve`.
- The probe's Response `model` carries the effort-folded pin
  (`swe-2-max-high`-shaped — the composite suffix), proving
  `reasoning.effort` reached the acp pin rather than being dropped.
- `effort.txt` exists on the work branch; the bead is claimed or
  closed; nothing merged to `main`.
