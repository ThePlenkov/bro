---
parent: bro-l67jh
scope:
  - packages/providers/src/acp-proxy.ts
  - packages/providers/src/acp-proxy.test.ts
  - packages/providers/src/index.ts
  - packages/cli/src/commands/acp.ts
  - packages/cli/src/commands/acp-agent.ts
  - packages/cli/src/commands/acp.test.ts
  - packages/cli/src/plugins.ts
  - skills/acp/SKILL.md
---

# bro-tegz2 — acp: `bro acp` agent mode — contract commands as slash commands, routing via providers

Parent: `bro-l67jh` (epic — bro speaks ACP outward). Depends on:
bro-k9ces (the CLI contract registry) + bro-bhyo1 (`runAcpProxy` — both
closed). The shape sketch lives in bro-rs8sp §"Agent mode"; this spec
turns it into the running surface.

## Problem

An ACP client that wants bro's surface must today name the downstream
agent itself (`bro acp proxy -- <cmd>`). There is no mode where bro IS
the agent: the client spawns `bro acp`, sees bro's commands as slash
commands, and free-form prompts land on the operator's configured
provider. The alternative — a client plugin per host re-implementing
bro's vocabulary — is the drift machine the epic exists to end.

### The te3yf boundary — who owns the generic facade

`brouter acp` (specs/bro-te3yf.md — shipped as
`packages/brouter/src/acp.ts`) is the **generic acpx-like stdio
facade**: a retained `providers.<name>` session with verbatim update
relay and bridged client-bound calls. The generic
"stdio-endpoint-in-front-of-a-configured-provider" surface belongs to
brouter — the router as one agent.

`bro acp` agent mode (this spec) is the **bro-agent surface**: bro's
own command contract advertised as slash commands, the hook seam on
crossed prompts, and provider selection through `fleet.routing`. It
does NOT re-implement a provider facade — its free-form leg is the
SAME `runAcpProxy` pump `bro acp proxy` runs, plus an agent overlay.
Two surfaces, one pump, zero second ACP servers. A future "facade over
stdio" feature request belongs to brouter, never to `bro acp`.

## Design

### CLI surface

```
bro acp                             agent mode — ACP server over stdio
bro acp --provider <name>           pin providers.<name> (type acp only)
bro acp --class <name>              fleet.routing.<class> instead of 'default'
bro acp proxy -- <agent cmd…>       unchanged (bro-bhyo1)
```

`--provider` and `--class` are mutually exclusive — a pin and a lane
can't both answer "which provider". Any other argv → usage, exit 2.

Bare `bro acp` blocking on stdin IS the convention — every `* acp`
binary (`devin acp`, `kilo acp`) is a stdio server; the old `[]` →
exit-2 usage case is superseded (usage stays for `bro acp <bogus>`).

### Provider selection — fleet.routing class → chain head

1. `--provider <name>` → `providers.<name>`; must be `type:'acp'` —
   an unknown name or a wrong kind is a config error naming it.
2. else `fleet.routing` declared → `resolveStepClass(routing,
   providers, {class: sel.class ?? 'default'})` → the chain HEAD's
   provider, which must be `type:'acp'` — `resolveStepClass` already
   guarantees a spawn surface; agent mode narrows that to the acp
   wire, and a `cli`/`api` head is a config error naming class +
   entry.
3. else (no routing declared) → the first `type:'acp'` entry in
   config order — the same fallback `brouter ask`/`brouter acp`
   use; none configured → a config error saying so.

Chain-head `model`/entry `model` are NOT pinned in v1 — the pump
forwards `session/new` verbatim, and pinning needs a proxy-originated
`session/set_config_option` (the gate re-prompt mechanism
generalizes) — a follow-up, not this spec.

The downstream argv is the entry's own command: `shellWords(entry.
command)` plus `--profile <p>` when the entry pins one — identical to
how `acpOpen` spawns acp entries — run through
`runAcpProxy(argv, opts)` (spawn, `acpChildEnv`, the pump — unchanged).

### The agent overlay — one new option on the existing pump

`AcpProxyOptions.agent?: AcpAgentOverlay`:

```ts
interface AcpAgentOverlay {
  /** bro's identity for the initialize answer — the downstream's
   *  original agentInfo survives under _meta.bro.downstreamAgent. */
  agentInfo?: { name: string; version?: string; title?: string };
  /** Commands announced once per stamped session. */
  commands?: AvailableCommand[];
  /** Local turn handler — undefined forwards the prompt downstream. */
  prompt?(turn: AcpAgentTurn): Promise<{ stopReason: string } | undefined>;
}
interface AcpAgentTurn {
  sessionId: string;
  cwd: string | undefined;             // session/new's cwd — never the server's
  text: string;                        // the flattened prompt text
  emit(update: SessionUpdate): void;   // session/update → upstream
  signal: AbortSignal;                 // fires on session/cancel
}
```

Three interception points, all inside the existing machinery:

- **initialize** — the response's `agentInfo` is replaced by the
  overlay's (bro IS the agent); the downstream's original survives
  under `result._meta.bro.downstreamAgent`. Capabilities, auth
  methods, and `protocolVersion` stay verbatim — the downstream
  negotiates what prompts can do.
- **session-open** — a newly stamped session announces the overlay's
  `commands` as ONE upstream `session/update`
  `{sessionUpdate:'available_commands_update'}` written right after
  the open response crosses. Once per stamped session id;
  load/fork/resume announce the same way.
- **session/prompt** — inside `crossPrompt` (the session's serialized
  writeQ), before the injection/forward path: `agent.prompt(turn)` —
  a non-undefined return answers the request upstream and the prompt
  never crosses; `undefined` falls through to today's verbatim + seam
  path. `emit` writes `session/update` notifications upstream,
  guarded by the pending entry — a cancelled turn emits nothing. The
  turn's span ends with `acp.proxy.local: true` + the stopReason. A
  handler throw answers a `-32603` error upstream — never a fake
  success.
- **cancel** — `PendingRequest.abort` (a new optional field) is armed
  for the local turn's duration; `abortHeld` fires it, so a running
  local command's signal aborts before the `cancelled` answer
  crosses.

What a local turn does NOT do (documented, deliberate): consume the
first-prompt injection slot (injection is about the downstream's first
turn — a local command isn't one); run the promptContext/toolCall/
stopGate legs (local turns produce no downstream response, so there is
nothing to gate — the gate's re-prompt is a downstream turn by
definition); feed the agent-turn plane.

### Slash commands — the CLI contract on the wire

The advertised set is `buildDump(PLUGINS, GROUP_META)` — the live
registry document `bro contract dump --json` emits — filtered to
`hidden === false` minus a serving/loop blocklist: `acp`,
`acp-worker`, `herdr`, `mcp`, `serve`, `daemon`, `watch`, `watchdog`,
`loop` (protocol servers whose stdio IS a wire, and turns that cannot
end — a slash command is a turn, bounded by `SLASH_TIMEOUT_MS`).

Each command becomes
`{name, description: summary, input: {hint}}` — the hint names the
contract's declared subs (`status|threads|…`) or `args`.

**Invocation** — a `session/prompt` whose flattened text matches
`^/<name>(\s+args)?` with `name` in the advertised set runs
`bro <name> <args>`: a real subprocess (`process.execPath` + the
resolved `process.argv[1]`), `cwd` = the session's `session/new.cwd`
(never the server's own), env = `acpChildEnv()`. stdout streams
upstream as `agent_message_chunk` updates; a non-zero exit appends
the code + a stderr tail as a final chunk; the response is always
`{stopReason:'end_turn'}` — the command's failure is turn content,
not a wire error. A `/name` NOT in the advertised set falls through —
the prompt forwards downstream, so the agent's own slash vocabulary
composes with bro's. `session/cancel` SIGTERMs the child and answers
`cancelled`; `SLASH_TIMEOUT_MS` (5 min) bounds a stuck run.

### Seam — same as proxy mode

The full `AcpProxySeam` wiring `bro acp proxy` carries
(sessionContext / promptContext / toolCall / stopGate via the
in-process collectors) applies unchanged — crossed prompts still get
session-start + prompt-submit context, tool calls still arm and
guard, turn ends still gate. Agent mode ADDS the local surface; it
never subtracts the seam. `BRO_HOOKS=0` keeps its meaning on both
legs.

## Verify

- providers suite (`acp-proxy.test.ts`): commands announce once per
  stamped session after the open response; an overlay-handled prompt
  answers upstream while the downstream never sees it; `undefined`
  falls through to verbatim + injection; cancel mid-local-turn
  answers `cancelled` and aborts the signal; initialize reports
  bro's agentInfo with the downstream's under
  `_meta.bro.downstreamAgent`; no overlay → byte-identical current
  behavior (the existing tests stay green).
- cli suite (`acp.test.ts` + `acp-agent.test.ts`): `bro acp` argv
  parsing (flags, mutual exclusivity, bogus → 2); provider
  resolution (`--provider`, routing class→head, a non-acp head is a
  config error, the first-acp fallback, none → error); the
  advertised set (hidden out, blocklist out, hint shape);
  `matchSlash`; and the e2e — a fake client over a stream pair in
  front of a stub downstream lists the commands, runs `/act status`
  (a stub spawn echoes), and a free-form prompt forwards to the
  downstream and streams its updates back verbatim.
- `npm run build`, `npm run typecheck`, `npm test` — the repo's CI
  gates, run before the PR.

## Non-negotiables

- **One pump.** Agent mode is an overlay on `acpProxy` — never a
  second ACP server, never a fork of brouter's facade.
- **The downstream negotiates.** Capabilities stay the downstream's;
  bro adds its surface through `available_commands_update`, not by
  claiming caps it won't serve.
- **cwd is per-session.** Slash commands run inside
  `session/new.cwd`, never the server's own cwd.
- **No synthesized success.** A crashed handler answers an error; a
  cancelled turn answers `cancelled`; a failed command reports its
  exit in-band.
