---

parent: bro-olfvd
scope:
- packages/brouter/src/ask.ts
- packages/brouter/src/acp.ts
- packages/brouter/src/cli.ts
- packages/brouter/package.json

---

# bro-te3yf — brouter M5: the protocol clients — ask + acp

## Problem

The router fronts ACP agents. So far it only speaks one protocol: the
Anthropic Messages dialect, served to a client that already knows how to
ask questions. Two protocols are missing, and they are the ones a person
at a terminal actually wants:

- **ask** — one question to an ACP agent, the answer printed. The
  shortcut that makes the router usable without a client at all.
- **acp** — the router AS an ACP agent. Any ACP client (an IDE, another
  agent, a TUI) drives the router's configured agent as if the router
  were one agent. acpx's shape: an endpoint in front, a target behind,
  the session kept alive between the client's turns.

Both are protocol work, and both belong to the router — not to bro's
workflow rig.

## Design

### Reuse, not reimplementation

`@broject/providers` already speaks ACP over stdio:

| the binding        | what it does                                                   | what brouter needs it for |
| ------------------ | -------------------------------------------------------------- | ------------------------- |
| `acpConverse`      | one turn: initialize → session/new → model pin → prompt → pump | `ask`                     |
| `acpOpen`          | a live peer to the target agent (the bridge lives inside)      | `acp`                     |
| `acpSessionRetain` | a session that SURVIVES between turns (prompt → answer)        | `acp`                     |

brouter adds the CLI around them. No new protocol code, no second ACP
implementation.

### `brouter ask`

```text
brouter ask [--provider <name>] [--model <id>] [--timeout <ms>] [--json] <question…>
```

- the provider — a `providers.<name>` entry of type `acp`; absent a
  `--provider`, the FIRST acp entry in config order (the router's lanes
  are acp).
- the question — the positionals, joined.
- the answer — the agent's text on stdout; `--json` gives
  `{provider, model, stopReason, text}`.
- one question = one session. A fresh ACP session per question; a
  continued conversation is `brouter acp`'s job (its session persists).

### `brouter acp`

```text
brouter acp [--provider <name>] [--model <id>]
```

An ACP endpoint over **stdio**: the SDK's `agent()` app, connected to
`ndJsonStream(stdout, stdin)`.

- `initialize` — the TARGET's initialize response: the client learns
  what the agent behind the router can do.
- `session/new` — a local session id plus the TARGET's `configOptions`
  and `modes`, so the client's model picker shows the target's models.
- `session/prompt` — relayed to the retained target session; every
  target `session/update` is pushed to the client as its own
  `session/update` notification.
- the target's client-bound calls (permission, fs, terminal) BRIDGE to
  the real client — the router never invents an answer the agent asked
  for.

The target session is opened once and kept: the client's second prompt
continues the SAME agent session (acpx's property — the session is the
router's, not the client's).

### The provider entries

One config file for both CLIs: `bro.config.json` `providers.<name>`.
`brouter providers` prints the inventory the two commands name from.

## Plan

- [x] `packages/brouter/src/ask.ts` — the ask command
- [x] `packages/brouter/src/acp.ts` — the stdio facade
- [x] the CLI wiring — `brouter ask`, `brouter acp`
- [x] the `@broject/providers` dependency
- [x] tests — the provider default, the question shape, the facade's
  session/new + prompt relay
- [x] the skill — the two commands

## Verify

- `npx tsx --test packages/brouter/src/*.test.ts`
- `npx tsc --noEmit -p packages/brouter/tsconfig.json`
- Live: `brouter ask --provider devin-acp "say hi"` answers; a client
  that speaks ACP over stdio can drive `brouter acp`.

## Non-negotiables

- **No second ACP implementation.** The binding is the protocol; brouter
  is the CLI around it.
- **The bridge never invents.** The target's permission/fs/terminal
  calls reach the real client; a refusal is the client's own answer.
- **One session per target.** The facade's session outlives the
  client's turns — a second prompt continues the conversation.
- **The provider is named, never guessed.** An absent `--provider`
  resolves to the first acp entry and says so; an unknown name is an
  error naming the known ones.

## Risks named up front

- **Two protocol stacks, one repo.** bro's `serve-acp.ts` brokers ACP
  over HTTP for the gateway; brouter's facade brokers it over stdio for
  a client. They share the binding, not the code — the HTTP broker
  stays where it is until the gateway moves (M4).
- **The target asks for permission.** A headless facade denies (the
  binding's default posture); a bridged client answers for real. The
  difference is a flag, not a fork.
