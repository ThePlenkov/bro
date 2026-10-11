---
parent: bro-huy5o
scope:
  - packages/github/src/webhooks.ts
  - packages/github/src/webhooks.test.ts
  - packages/github/src/index.ts
  - packages/core/src/bus.ts
  - packages/core/src/bus.test.ts
  - packages/core/src/index.ts
  - packages/act/src/wait.ts
  - packages/act/src/wait.test.ts
  - packages/act/src/index.ts
  - packages/cli/src/commands/serve.ts
  - packages/cli/src/commands/serve.test.ts
  - packages/cli/src/commands/act.ts
  - skills/serve/SKILL.md
  - site/content/docs/commands/events.md
---

# bro-huy5o.7 — events: github webhook ingest into the bus

Parent: `bro-huy5o` (epic — adoption-first connector backlog).
Depends on: `bro-2hno` (bus broker, merged).

## Problem

`bro act wait`, `bro watch` and `bro drive` learn about PR state by
polling the API: every interval costs a `gh` call whether or not
anything moved, and a gate that turned green 5s after a poll sits
unnoticed until the next one. GitHub already knows when the gate inputs
change — it pushes `pull_request`, `pull_request_review`,
`check_run`/`check_suite` and `issue_comment` deliveries. Nobody hands
those deliveries to the bus, so the push signal is wasted.

The bus (bro-2hno) is the transport for exactly this: topics,
subscriber filters, seq cursors, and a publish path that is already
fail-open. What is missing is an ingest edge — a way for a GitHub
delivery to become a `github:*` event — and a consumer that wakes on it.

## Design

Two seams, one each side of the bus: a webhook **source** (HTTP →
`github:*` topic) and a **waker** (subscription → early poll). Polling
stays the default and the only required path — every webhook hop is
fail-open.

### `github:*` topics (packages/github/src/webhooks.ts)

Every verified delivery maps to one `EventInput`:

- `topic` = `github:<x-github-event>` — `github:pull_request`,
  `github:check_run`, … A `github:*` glob covers the whole source.
- `kind` = the payload `action` (`synchronize`, `submitted`,
  `completed`, `created`, …), or the event name when the payload has no
  action.
- `key` = `pr-<n>` when a PR/issue-on-PR is identified, `sha-<head>`
  for check events with only a commit, else absent.
- `ref` = the payload's `html_url`; `source` = `github`.
- `payload` = a small projection (`event`, `delivery`, `action`,
  `repo`, `sender`, `prs`, `sha`, `checkName`, `conclusion`), not the
  raw body — the ring is byte-bounded and GitHub deliveries are not.
  `prs` lists every PR number the payload links (check payloads carry
  `pull_requests[]`; `issue_comment` counts as a PR link only when
  `issue.pull_request` is present).

Signature check and body decode live here too —
`verifyGithubWebhook` (HMAC-SHA256 over the raw body,
`X-Hub-Signature-256`, timing-safe compare) and
`parseGithubWebhookBody` (`application/json`, plus
`application/x-www-form-urlencoded` because that is a repo webhook's
DEFAULT content type — ignoring it would make the zero-config webhook
silently 415).

### `POST /api/v1/webhooks/github` (packages/cli/src/commands/serve.ts)

`bro serve` gains the ingest route. It bypasses both the bearer-token
write guard and the loopback-Host guard: the HMAC signature IS the
authorization boundary (a caller without the secret can produce no
valid delivery, and the `{accepted}` response leaks nothing), and a
hosted deployment reaches the listener through a tunnel that does not
rewrite `Host` — guarding Host here would reject exactly the traffic
the route exists for.

- `BRO_GITHUB_WEBHOOK_SECRET` unset → 503 "not configured" — ingest is
  fail-closed: a browser page CAN send a simple form POST to
  127.0.0.1, so an unsigned path would let any local page inject
  forged bus events. No secret, no route.
- Missing/invalid `X-GitHub-Event` or unparseable body → 400; bad or
  missing signature → 401.
- Verified deliveries publish to the repo's bus socket and answer 202
  `{accepted, published, seq?, reason?}` — `published:false,
  reason:'broker down'` is a valid answer, not an error.

When the secret IS set, `bro serve` also starts the repo broker
in-process (an existing `bro bus serve` wins — same socket either
way). That is what makes the endpoint the hosted ingest the bead asks
for: `BRO_GITHUB_WEBHOOK_SECRET=… bro serve` is the whole receiver —
no second process, and `gh webhook forward` for local dev:

```sh
gh extension install cli/gh-webhook   # once
BRO_GITHUB_WEBHOOK_SECRET=dev bro serve --port 8791
gh webhook forward --repo=org/repo \
  --events=pull_request,pull_request_review,check_run,check_suite,issue_comment \
  --url=http://127.0.0.1:8791/api/v1/webhooks/github --secret=dev
```

Hosted mode is a repo webhook or GitHub App pointed at the same route
through a tunnel/reverse proxy; the secret is the app/hook secret.

### The waker (packages/core/src/bus.ts + act wait)

`busWake(socketPath, filter, match)` → `{next(), close()} | null` —
subscribe, and `next()` resolves on the next matching event (a `gap`
counts — lost events mean re-derive). Subscribe failure returns `null`:
broker down means pure timer polling, the fail-open contract.

`waitForGate` gains `wake?: () => Promise<GateWake|null>`; armed once,
each interval sleep becomes `Promise.race([sleep, waker.next()])`, and
`close()` runs in the existing `finally`. `cmdWait` arms
`githubPrWake(dir, pr)` (webhooks.ts): filter `topics: ['github:*']`,
match = event's `prs` includes the PR OR names no PR at all (a
check_suite on main carries no `pull_requests` link yet can still
change the gate — under-waking loses latency, over-waking costs one
poll).

`bro watch`/`bro drive --every` adopt the same `busWake` in a follow-up
— their cadence loops take the identical race; this PR proves the
consumer contract on the waiter that blocks turns.

## Plan

- [x] `specs/bro-huy5o.7.md` — this spec
- [x] `packages/github/src/webhooks.ts` — verify/parse/map/PR-match +
      `githubPrWake`; index exports
- [x] `packages/core/src/bus.ts` — `busWake`
- [x] `packages/act/src/wait.ts` — `wake` option
- [x] `serve.ts` — route, guard bypass, secret-gated auto-broker
- [x] `act.ts` — arm the waker in `cmdWait`
- [x] docs: events.md webhook section + serve SKILL.md route
- [x] tests: webhooks (sig/parse/map/match), busWake, wait wake, serve route
