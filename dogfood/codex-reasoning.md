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
5. Prove YOUR OWN request carried the effort — this is the primary
   assertion. Codex records every request it sent in its session
   rollout under `.codex/sessions/` — grep the newest
   `rollout-*.jsonl` for `reasoning`/`effort` and for the response
   `model` the conductor answered with. A request that shows
   `effort` on the wire and a `-high`-suffixed composite pin in the
   response is proof `model_reasoning_effort` was honored end to end;
   if the rollout shows no effort on your own turns, the setting was
   dropped and this scenario FAILS — say so.
6. Cross-check the server side: read `.git/bro/serve.json` for `url`
   and `token`, then probe the conductor directly —

   `curl -s "$URL/v1/responses" -H "authorization: Bearer $TOKEN"
   -H 'content-type: application/json'
   -d '{"model":"devin/swe-2-max","reasoning":{"effort":"high"},
   "input":"ping"}'`

   The Response's `model` field should carry the same `-high`
   composite pin — a server-side confirmation, not the proof itself.
7. Report: `npx bro notify` — one line stating the effort on your own
   wire and the pin the conductor answered with.

## Assert

- Every turn answered `/v1/responses` on this run's `bro serve`.
- The codex session rollout shows `effort` on a request Codex itself
  sent, and the response `model` in that same rollout carries the
  effort-folded composite pin (`swe-2-max-high`-shaped).
- The direct probe is a secondary check only — it cannot substitute
  for the rollout evidence.
- `effort.txt` exists on the work branch; the bead is claimed or
  closed; nothing merged to `main`.
