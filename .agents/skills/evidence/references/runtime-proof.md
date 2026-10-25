# Runtime Proof

Goal: prove the true objective with runtime-level evidence. Merged from
the old `runtime-proof` skill.

This file is the conceptual checklist for runtime-level proof. Three
files together cover the runtime-proof contract — reach for each
based on the question you have:

- **WHAT to run** (which environment class fits the claim): THIS
  file. Pick the `target_environment` token; do not invent a new
  one.
- **HOW to run it** (the exact shell commands and the
  per-environment minimum viable run, including `network.har` /
  `screenshot.png` / `console.log` capture):
  [`per-environment-runs.md`](per-environment-runs.md).
- **What the claim document MUST contain** (the `validate.py`
  schema for the evidence file — required fields, `artifacts[].kind`
  values, `claim.json` / `target_environment`):
  [`evidence-schema.md`](evidence-schema.md) (and the JSON
  Schema in `claim.json`).

## Choose Target Environment

The `target_environment` field on the claim is one of the canonical
tokens below. Pick the one that matches the proof target; the label
in the body text is a hint, not a substitute for the token.

| `target_environment` token | When to use |
| --- | --- |
| `backend` | HTTP service, RPC, queue consumer (the service runs and serves) |
| `cli` | Local binary, script, one-off command |
| `frontend` | Client-side runtime that does not require a browser (e.g. SSR page, Node-based renderer) |
| `browser` | Anything that needs a real browser engine: SPA, hydration, WebSocket, page behaviour |
| `integration` | Two or more services talking to each other |
| `static-analysis` | Typecheck, lint, format, or any non-executing analysis |
| `test-suite` | A pre-existing test suite run end-to-end |
| `db-migration` | Schema change with up + down assertions |
| `docs` | Build-and-diff the docs; not the rendered HTML/MD itself |
| `other` | None of the above — explain in `preconditions` |

This file covers the runtime-proof subset (`backend`, `cli`,
`frontend`, `browser`, `integration`); for the full per-environment
recipe set — including `static-analysis`, `db-migration`, and
`docs` — see
[`per-environment-runs.md`](per-environment-runs.md).

## Backend/API Proof

A 200 response is not enough if the objective involves correctness, auth,
persistence, side effects, or data shape.

Show:

- command executed
- response or test output
- assertion that matches the true objective

The full per-environment recipe (seed / hit / side-effect check,
required `ON_ERROR_STOP`, exact-line vs substring matching) is in
[`per-environment-runs.md`](per-environment-runs.md) under
"Backend / API".

## Frontend/Browser Proof

For frontend, HTML, UI, client-side JavaScript, browser routing,
hydration, or page behavior, curl is forbidden as final proof.

Use an existing browser test if it proves the objective. If no browser
test exists, create a temporary verification script when allowed. The
script MUST:

- navigate to the real local URL
- capture console errors (save to `console.log`; an empty file is
  the proof of zero errors)
- capture uncaught page errors
- wait for app initialization
- assert the relevant UI behavior
- exit non-zero on failure

The claim will fail `validate.py` without the mandatory artifacts:

- `screenshot.png` (or full-page trace) under
  `artifacts[].kind = "screenshot"` (or `"trace"`)
- `console.log` (zero errors) under
  `artifacts[].kind = "log"`
- `network.har` (or explicit connection log) under
  `artifacts[].kind = "network"` for every
  `browser-automation` claim — not only WebSocket / SSE / long-poll
  cases

The canonical recipe (Playwright spec + captured artifacts) is in
[`per-environment-runs.md`](per-environment-runs.md) under "Web".

## Required Output

```
Target environment: ...
Verification method: ...
Command executed: ...
Important output: ...
What the output proves: ...
Remaining gaps: ...
```
