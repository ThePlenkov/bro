---
title: Events — notify, mailbox, bus, sinks
description: The events facade — a session mailbox by default, a local event broker behind it, webhook sinks for humans.
---

`bro notify` writes through one `events` facade — mailbox by default,
or the local broker when `"connectors": { "events": "bus" }` selects it.
The notify connector's postTool probe drains drops into session
context, so a watcher, fixer, or convoy worker reaches a live session
mid-turn instead of the recipient burning tokens in a wait loop.

The mailbox itself is plain files — no broker, no config, no daemon —
and `bro watch --notify` writes there directly (a raw `dropMailbox`
tmp+rename), bypassing the facade: `connectors.events` routes `bro
notify` writes only, never watch drops.

## The mailbox — `bro notify`

One atomic drop (tmp+rename) per event into
`<git-common-dir>/bro/notify/` inside a repo — shared across linked
worktrees via the common git dir — or the XDG state dir
(`$XDG_STATE_HOME`, default `~/.local/state`) outside one.

| Command | What it does |
| ------- | ------------ |
| `bro notify <text>` | Drop one event — delivered to every session's next postTool probe |
| `bro notify -- <text>` | Verbatim text — needed when it contains option-looking words like `--help` |
| `bro notify --to <agentId\|sessionId\|orchestrator> <text>` | Addressed drop for exactly one consumer — `orchestrator` names the session owning agents; absent means broadcast |
| `--kind note\|info\|ask\|result\|block` | A label, never a grant — a `block` or `ask` carries no approval or scope with it |
| `--in-reply-to <ref>` | The drop, bead, or step this answers |
| `--key <k>` | Coalesce — a pending same-key drop from this source is superseded by the newer one |

Delivery is pull-based: a drop never wakes a sleeping session — it lands
in context on the next tool call. Broadcast drops stay for every session
until the drop TTL reaps them; addressed drops expire on read
(single-consumer). Each drop should be self-contained — the drain
renders it verbatim.

## The broker — `bro bus`

A local event broker in `@broject/core` — topics, filters, seq cursors.
`status` deliberately exits 0 when the broker is down: nobody started
one is a normal state, not a fault.

| Command | What it does |
| ------- | ------------ |
| `bro bus serve [--json]` | Run the broker (SIGINT/SIGTERM to stop) |
| `bro bus publish --topic T --kind K [--key K] [--source S] [--to ADDR] [--cause C] [--ref R] [--payload JSON] [--json]` | Publish one event and exit — connect, write, close. `--to` addresses one recipient (`orchestrator` works here too); absent means broadcast |
| `bro bus subscribe [--topic T]… [--kind K]… [--to ADDR] [--since N] [--json]` | Stream matching events until interrupted; `--since N` replays from a seq cursor — a cursor outside the window reports a gap |
| `bro bus status [--json]` | Liveness and counters |

## GitHub webhooks — `github:*`

`bro serve` ingests GitHub webhook deliveries and publishes them as bus
topics: `POST /api/v1/webhooks/github` maps each verified delivery to
`github:<event>` (`github:pull_request`, `github:check_run`, …) with the
payload `action` as kind and `pr-<n>`/`sha-<head>` as key. The
`X-Hub-Signature-256` HMAC is the auth — no session token — and the
route is armed only while `BRO_GITHUB_WEBHOOK_SECRET` is set; unset it
answers 503, a bad signature 401. When the secret IS set, `bro serve`
also starts the repo's broker in-process — the two commands below are
the whole local-dev receiver:

```sh
gh extension install cli/gh-webhook   # once
BRO_GITHUB_WEBHOOK_SECRET=dev bro serve --port 8791
gh webhook forward --repo=org/repo \
  --events=pull_request,pull_request_review,check_run,check_suite,issue_comment \
  --url=http://127.0.0.1:8791/api/v1/webhooks/github --secret=dev
```

Hosted mode is the same route behind a tunnel or reverse proxy pointed
at a repo webhook or GitHub App — the signature check survives the
public Host a tunnel forwards with.

`bro act wait` subscribes to `github:*` and polls early when a matching
event lands — a check completing wakes the wait instead of sitting out
the interval. Broker down means plain timer polling: the webhook path
is an accelerator over the default, never a requirement.

## Webhook sinks — `notify.sinks`

The mailbox reaches agents; sinks reach PEOPLE. A `sinks` array in the
operator-local `notify` section fans every publish out to configured
webhooks — Slack incoming webhooks, telegram `sendMessage`, or a
generic JSON endpoint. Delivery wraps the facade `publish`, so every
producer — `bro notify`, `bro bus publish`, the webhook ingest,
convoy, drive, act, retrospect — reaches the sinks through the same
door.

| Command | What it does |
| ------- | ------------ |
| `bro sinks list [--json]` | Resolved sinks — type, route patterns, and each secret env var's set/unset status (never the value) |
| `bro sinks test [--json]` | Probe every configured sink's endpoint (routes bypassed), report per-sink delivered/deduped/error — verify a webhook before a real event needs it |

```json
{
  "notify": {
    "sinks": [
      { "type": "slack", "urlEnv": "SLACK_HOOK", "events": ["convoy:gate", "drive:alert"] },
      { "type": "telegram", "tokenEnv": "TG_TOKEN", "chatIdEnv": "TG_CHAT", "events": ["*"] },
      { "type": "webhook", "urlEnv": "WH_URL", "events": ["act:*", "retro:*"] },
      { "type": "webhook", "url": "http://ci.internal/bro-events" }
    ]
  }
}
```

Each entry is `{ type, ... }`:

- `events` — the route. `[]`/absent means every event; entries are
  `topic` (any kind), `topic:kind` (exact), or `*`-globs (`dr*`,
  `drive:*`). A sink posts only when some pattern matches.
- Secrets name env vars — `urlEnv`, `tokenEnv`, `chatIdEnv` — never
  literal values in config; a missing var skips the sink. `url` and
  `chatId` accept literals for non-secret endpoints.
- `timeoutMs` bounds one delivery (default 5s — a wedged endpoint
  doesn't hold the caller); `minIntervalMs` deduplicates an identical
  repeat (same sink, key, and rendered text) so an every-N-minutes
  alert source doesn't re-page each tick (default 4h; `0` disables).
  A changed payload is a new event and sends immediately.
- Bodies: slack posts `{ text: "[topic/kind] message" }`, telegram
  `{ chat_id, text }` to `bot<token>/sendMessage` (`apiBase`
  overrides the API host), generic webhook posts the event fields
  plus a rendered `text` — all `application/json`.

Delivery NEVER blocks or fails the agent: a missing env var, an HTTP
error, a dead endpoint returns a result row, not an exception. Built-in
emissions — convoy HUMAN GATE (`convoy:gate`), drive stuck-PR and
silent-reviewer alerts (`drive:alert`), `act wait` settles
(`act:block`/`act:result`), wtf captures (`wtf:note`) and retro records
(`retro:result`) — all arrive through the same publish path. The
`notify` section is operator-scoped — commit the file without secrets
anyway; values stay in env.

## Policy

- **Write, don't wait.** A finished worker, a watcher that saw a
  transition, a fixer that needs attention — drop the event and get on
  with it; never poll the parent.
- **Once per session, not once total.** The mailbox is broadcast with a
  per-session `.seen` cursor — a drop reaches every live session exactly
  once.
- **`bro watch --notify`** drops the initial snapshot and gate
  transitions into the mailbox — see
  [Fleet & supervision](/docs/commands/fleet).
