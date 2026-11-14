---

title: bro acp
description: bro on the ACP wire — bro-as-agent with CLI slash commands and a routed downstream, or the cascading proxy edge.
---

`bro acp` puts bro on the [ACP](https://agentclientprotocol.com) wire so
any ACP client — Zed, JetBrains, Neovim, `devin acp`, any `* acp` agent
binary — reaches bro's surface without a client-side plugin.

## Agent mode — `bro acp`

Bare `bro acp` **is** the agent: the client's "custom agent" argv is
just `bro acp`, and the session gets bro's own surface.

- **Slash commands are the CLI contract.** The registry `bro contract
  dump --json` emits is announced per session as ACP
  `available_commands` — `/act status`, `/next`, `/drill`, and the rest.
  A prompt starting `/name args…` runs the real `bro` child inside the
  session's repo (`session/new`'s `cwd`) and streams stdout back as
  agent message chunks. A non-zero exit, exec failure, or the 5-minute
  turn cap reports in-band as the turn's own text.
- **Free-form prompts forward downstream.** The configured provider
  answers them; every `session/update` streams back verbatim. An
  unknown slash (`/plan-mode`) belongs to the downstream's own
  vocabulary and crosses too.
- **Provider selection is `fleet.routing` class → chain head** (spec
  bro-tegz2): `chain[0]` must be an `acp`-type provider entry. Bare
  `bro acp` uses the `default` class; `--class <name>` picks another
  lane; `--provider <name>` pins an entry directly (exclusive with
  `--class`). With no routing table, the first `acp` entry in the
  config answers.

| Command                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `bro acp`                   | Agent mode — bro's slash surface + routed downstream on stdio |
| `bro acp --class <name>`    | Agent mode on another routing lane                            |
| `bro acp --provider <name>` | Agent mode pinned to `providers.<name>`                       |

Exit: 0 = client closed the wire, 1 = the downstream died first or a
config error (wrong provider kind, dead lane, no `acp` entry), 2 =
usage.

The generic "stdio endpoint in front of a configured provider" facade
is `brouter acp` (spec bro-te3yf) — retained provider sessions and
bridged client-bound calls. `bro acp` is bro-as-agent: the command
contract, the hook seam, and routing are bro's own.

## Proxy mode — `bro acp proxy -- <agent cmd…>`

The cascading edge: the client names the downstream in argv and bro
forwards every message verbatim — except the session's first
`session/prompt` (which carries the hook seam's session-start +
prompt-submit context as one prepended text block), `tool_call`
updates (which run the post-tool guards in-process), and turn ends
(the stop gate can hold one for exactly one re-prompt). `--` is
mandatory; the tail is exec'd without a shell and the child env pins
`BRO_HOOKS=0` so the downstream tree never re-runs hooks.

```bash
bro acp proxy -- kilo acp
```

Exit: 0 = client ended the wire, 1 = downstream died first, 2 = usage.

Both surfaces run the same message pump (`runAcpProxy` in
`@broject/providers`) and the same hook seam — agent mode adds bro's
initialize identity, the per-session command announcement, and
local-turn interception; it subtracts nothing.
