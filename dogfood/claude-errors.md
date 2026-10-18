# Scenario: claude survives a killed listener

A `claude -p` session on this repo's `bro serve` deliberately kills
its own model plane mid-run and must recover. `bro serve ensure`
(in your settings' apiKeyHelper) re-spawns the listener on the next
request, so a killed serve is a retryable outage — not a dead
session. You are proving the recovery path actually works.

Setup already done for you: `.claude/settings.local.json` wires the
conductor listener and `bro.config.local.json` the acp backend.

## Steps

1. Orient: `npx bro status`.
2. Claim work: `npx bro task new "survive a serve restart"`, then
   `npx bro work enter <bead>`.
3. Locate the listener: read `.git/bro/serve.json` — note the `pid`
   and `port` fields.
4. Kill it: `kill <pid>` (the conductor process, this run's serve —
   killing it kills the retained acp sessions too; the wire is what
   must recover).
5. Continue anyway: create `survivor.txt` containing `claude errors
   dogfood` and commit it on the work branch. If the next model call
   fails — a 5xx, a timeout, or a refused connection are all legal
   shapes of a dead listener — re-ensure the plane yourself before
   retrying: `npx --no-install bro serve ensure --port <port>` (the
   port from serve.json; the apiKeyHelper's output can sit in claude's
   cache, so don't wait on it). Then retry the turn.
6. Verify recovery: read `.git/bro/serve.json` again — a NEW pid
   means the respawn happened. Note the generation change in your
   report.
7. Report: `npx bro notify` — one line on what failed and what
   recovered.

## Assert

- Any failure surfaced on `POST /v1/messages` through the conductor —
  a 5xx, timeout, or refused connection are all valid shapes (a fast
  enough re-ensure may show no error at all — recovery still counts).
- The run COMPLETED (a wedged session is a fail, not a retry story).
- `.git/bro/serve.json` post-run holds a different pid than the one
  the runner killed (or serve.log shows a new generation binding the
  same port).
- `survivor.txt` exists on the work branch; the bead is claimed or
  closed; nothing merged to `main`.
- The report honestly names the failure observed (timeout/5xx/retry)
  — a run that claims it never noticed the kill is suspect.
