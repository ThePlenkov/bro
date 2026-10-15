---
parent: bro-huy5o
scope:
  - packages/core/src/sinks.ts
  - packages/core/src/sinks.test.ts
  - packages/core/src/config.ts
  - packages/core/src/events-connectors.ts
  - packages/core/src/index.ts
  - packages/cli/src/commands/sinks.ts
  - packages/cli/src/commands/sinks.test.ts
  - packages/cli/src/commands/act.ts
  - packages/cli/src/commands/convoy.ts
  - packages/cli/src/commands/convoy-run.ts
  - packages/cli/src/commands/drive.ts
  - packages/cli/src/commands/retrospect.ts
  - packages/cli/src/plugins.ts
  - skills/notify/SKILL.md
  - site/content/docs/commands/events.md
---

# bro-huy5o.8 — notify sinks: slack, telegram, generic webhook

Parent: `bro-huy5o` (epic — adoption-first connector backlog).

## Problem

The event plane delivers to agents — mailbox drops drained by postTool
probes, the bus for subscribers. Humans are not subscribers: a convoy
that reaches a HUMAN GATE at 3am, a drive pass whose reviewer went
silent, a detached `act wait` that finally settles, a wtf that just got
captured — all of these land in files nobody reads until the next
session starts. The mailbox is pull-based and agent-shaped; nothing
pushes the moment to the person it exists for.

## Design

A `notify.sinks` config section routes matching events to outbound
webhooks, delivered at the publish edge — the same `facade('events').publish`
every emitter already calls. Sinks are operator-class config (endpoints
and chat ids are per-machine, never committed project policy); secrets
always come from env (`urlEnv`, `tokenEnv`, `chatIdEnv` name the
variable — the value never enters config, argv, or logs).

### Config (`~/.config/bro/config.*` or `bro.config.local.*`)

```json
"notify": {
  "sinks": [
    { "type": "slack",    "urlEnv": "BRO_SLACK_WEBHOOK",
      "events": ["convoy:gate", "drive:alert", "act:block", "act:result", "wtf", "retro"] },
    { "type": "telegram", "tokenEnv": "BRO_TG_TOKEN", "chatIdEnv": "BRO_TG_CHAT",
      "events": ["*"] },
    { "type": "webhook",  "url": "https://example.test/hook",
      "events": ["act:*"], "timeoutMs": 4000, "minIntervalMs": 0 }
  ]
}
```

- `type`: `slack` | `telegram` | `webhook` (required).
- Endpoint: `urlEnv` names the env var holding the URL (slack/webhook —
  the URL IS the secret); literal `url` allowed for non-secret hooks.
  Telegram uses `tokenEnv` + `chatId`/`chatIdEnv`; `apiBase` overrides
  the bot-API host (tests, self-hosted).
- `events`: routing patterns — `topic` or `topic:kind`, `*` and
  trailing-`*` globs per `eventTopicMatches`. Omitted/empty = every
  event (same "no narrowing" semantics as `EventFilter`).
- `timeoutMs` per request (default 5000), `minIntervalMs` per-sink
  resend floor for an identical event (default 4h, `0` = always send).

### `sinks.ts` (core)

- `deliverSinks(dir, event, opts?: { fetch?, now? })` — resolves config,
  matches, dedups, POSTs, returns `SinkDelivery[]` results; never throws.
  Each delivery is bounded by `AbortSignal.timeout`; a failure is a
  result row, not an exception — the publish path must never become a
  session problem (the events facade's own contract).
- Message text: `[topic/kind] payload` one-liner (+ `ref` when the
  payload is not already a string). Slack posts `{ text }`; telegram
  `sendMessage` `{ chat_id, text, disable_web_page_preview }`; webhook
  posts the event JSON (`{ …event, ts }`).
- Dedup state: `<notifyDir>/sink-state.json` — `{ hash → lastSentTs }`
  where hash covers sink identity + topic/kind/key/rendered payload.
  Identical re-emits inside `minIntervalMs` are suppressed — a `drive
  --every` pass against a stuck PR re-alerts on the interval, not every
  tick. A new drop text (different blockers, different gate) is a
  different event and always sends.

### Publish edge (`events-connectors.ts`)

`withSinks(dir, facade)` wraps `publish`: when `isEventInput(event)`
holds, `deliverSinks` runs regardless of the transport result — a
broker-down `act` event still reached the human even though no agent
did. Both `mailboxConnector` and `busConnector` wrap; external events
connectors can opt in by composing the same helper (exported).

### Emit sites — `facade('events').publish`, sinks ride along

| Moment | Event |
| --- | --- |
| convoy HUMAN GATE reached (`convoy wait` gated exit, `convoy run` gated verdict) | `topic: 'convoy', kind: 'gate'`, `key: convoy-gate-<mol>` |
| drive alert — `gate.alerts` non-empty (silent reviewer) or an unmovable verdict (`blocked`, `spawn-refused`, `spawn-failed`, `merge-refused`, `merge-unverified`, `probe-failed`, `no-worktree`, `error`) | `topic: 'drive', kind: 'alert'`, `key: drive-<verdict\|alert>-<pr>` |
| act wait finished — blocked settle keeps today's `act:block`; green/externally-settled adds `act:result` | `key: act-wait-<pr>` |
| retro/wtf captured | `topic: 'wtf', kind: 'note'`, `key: wtf-<id>` on capture; `topic: 'retro', kind: 'result'`, `key: retro-<id>` on record |

### `bro sinks` (CLI)

`list` prints resolved sinks — type, event patterns, whether each
`*Env` secret is set (never values). `test` delivers a probe event and
reports per-sink `ok`/`err` — the operator's "does my webhook work"
check without waiting for a real event.

## Out of scope

- Daemon/broker-side delivery — sinks fire in the publisher's process;
  no running service required (adoption-first).
- Retries, queueing, rate-limit buckets — `minIntervalMs` is the whole
  floor; a dead endpoint is a missed delivery, reported in the result.
- Slack blocks/modals, telegram inline keyboards — `{ text }` is the
  contract.

## Plan

- [ ] `specs/bro-huy5o.8.md` — this spec
- [ ] `config.ts` — `notify` section (operator-classed) + `sinksSection` validation
- [ ] `sinks.ts` — match/render/request/dedup/`deliverSinks` + `withSinks`
- [ ] `events-connectors.ts` — wrap mailbox + bus `events` facades
- [ ] emit sites: act settle `act:result`, convoy `convoy:gate` (wait + run), drive `drive:alert`, retrospect `wtf`/`retro`
- [ ] `bro sinks list|test` plugin (comms group, notify skill)
- [ ] docs: events.md sinks section, skills/notify/SKILL.md
- [ ] tests: sinks unit tests (match/route/dedup/delivery/fail-open), emit-site assertions where harness exists
