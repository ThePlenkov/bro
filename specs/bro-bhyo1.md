---
parent: bro-l67jh
scope:
  - packages/providers/src/acp-proxy.ts
  - packages/providers/src/acp-proxy.test.ts
  - packages/cli/src/commands/acp.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/plugins.ts
  - skills/acp/SKILL.md
---

# bro-bhyo1 — acp: `bro acp proxy -- <agent cmd>` — transparent forwarding + session/new context injection

Parent: `bro-l67jh` (epic — bro speaks ACP outward). The edge shape is
already decided: `bro-rs8sp` picked the **cascading proxy** (bro knows
its successor via argv) over the upstream RFD's conductor model, pinned
the verbatim-forwarding contract, and mapped hook events onto ACP v1
wire points. This spec turns that decision into the first running seam.
What is NOT here: permission policy (bro-9qopj), tool_call guards and
the stop gate at the seam (bro-u2eps), agent mode (bro-tegz2).

## Problem

bro consumes ACP strictly as a client today. Every host integration —
`hooks.json` for claude/devin, cursor's stdin dialect, codex —
re-implements bro's hook vocabulary client-side: seven adapters, seven
partial mappings, drift per host. An ACP client that could sit behind
bro gets none of it — no session-start rehydrate, no prompt-submit
context, no agent-plane telemetry.

`bro acp proxy -- <agent cmd>` puts bro on the wire: the client (Zed,
JetBrains, Neovim, Devin's own CLI) talks ACP to bro; bro talks ACP to
the spawned agent. bro's session context rides the existing protocol —
injected into the session's first `session/prompt` — and every other
message crosses untouched.

## Design

### Transport — a message pump over `Stream`/`ndJsonStream`

The proxy is two `Stream` pairs joined by a small pump — deliberately
NOT the typed `agent()`/`client()` apps and NOT the raw `Connection`
class either:

- `agent()`/`client()` parse params against generated schemas and
  silently narrow the wire — a transparent proxy cannot ride typed
  handlers.
- `Connection`/`JsonRpcHandler`/`IncomingRequest` are SDK-internal in
  1.7.0 (not reachable through the package `exports` map), so the raw
  handler-chain design from bro-rs8sp is not available — and it is not
  needed: the pump moves the already-parsed `{jsonrpc, id, method,
  params}` objects across untouched. Nothing re-encodes, so `_`-methods,
  future v1 additions, `_meta`, and error envelopes cross without a
  handler list that can rot. Request ids forward verbatim too — each
  direction's outbound id space is single-sourced (client-originated on
  the downstream leg, agent-originated on the upstream leg), so no id
  translation is ever required.
- **downstream** — spawned argv exec'd directly (no shell — the ` -- `
  tail is already tokenized; provider entries use `sh -c` only because
  they carry operator config strings). `ndJsonStream` over the child's
  stdio pair; `BRO_HOOKS=0` via `acpChildEnv()` on the child env — the
  seam is the sole hook executor, the child tree never re-runs hooks.
  The proxy's own env is unpinned (it serves a human-facing client).

Upstream is the proxy process's own stdin/stdout — `bro acp proxy` IS
the agent the client spawns, so its stdio pair is the wire.

### Forwarding contract

Default is **verbatim** — method, params, `_meta`, and error envelopes
pass through untouched in both directions:

- **request** → written verbatim to the peer's writer and recorded in a
  per-direction pending table keyed by its wire id. The peer's response
  (result or error envelope) crosses back verbatim — error
  code/message/data re-crosses byte-identical.
- **notification** → written verbatim to the peer's writer.
- **response-shaped inbound** → written verbatim to the other leg; the
  pending entry it discharges supplies only the bookkeeping (session
  bind, turn span).
- **`session/cancel`** is a plain notification — it forwards verbatim;
  a downstream that observes ACP answers its held prompt
  `stopReason:'cancelled'` and that response crosses back the same way.
- Downstream death → every request still pending upstream gets a
  `{code:-32603, message:'acp proxy: downstream agent closed'}` answer —
  pending work fails visibly, never silently.

Intercepted, all inside the upstream catch-all (direction C→A):

| Wire point | What bro does |
| ---------- | ------------- |
| `initialize` | Forward verbatim both ways — the downstream negotiates; the proxy never claims caps it won't serve. |
| `session/new` · `session/fork` · `session/load` · `session/resume` | Forward verbatim. On a successful response carrying `sessionId`, stamp a pending-context buffer `{cwd}` for that session (`cwd` from request params for new/fork; `params.sessionId` keyed for load/resume). |
| `session/prompt` | Claim the session's pending buffer atomically; run the prompt-submit seam on the flattened prompt text; prepend ONE `text` content block combining session-start context (first prompt only) + prompt-submit context (every prompt); forward the rewritten params. |
| `session/cancel` | Forward verbatim; if the session has a held first-prompt still computing its injection, answer that prompt upstream with `{stopReason:'cancelled'}` ourselves — the wire never shows a prompt after its cancel. |
| everything else | Verbatim — `session/set_*`, `authenticate`, `providers/*`, `nes/*`, `document/*`, unknown `_`-methods. |

And the downstream catch-all (direction A→C): everything verbatim —
`session/update`, `session/request_permission` (policy is bro-9qopj),
`fs/*`, `terminal/*`, `elicitation/*`, unknowns.

### The hook seam — same code, no pipe

`bro-hooks`-as-library: `hooks.ts` grows two exported collectors and
threads `dir` through the probe plumbing (`hookCtx`, `hooksStateDir`,
`parallelLines`, `guardLines`, `sessionTail`,
`sessionContextTextCached` — markers/arming stay on the CLI's own
process cwd, they are never reached by the seam):

```ts
collectSessionContext(dir, sessionId, event?)
  → { lines: string[]; settled: boolean }
collectPromptContext(dir, sessionId, prompt)
  → { lines: string[] }
```

`emitSessionContext`/`emitPromptContext` keep the stdin→stdout CLI
contract — they delegate to the collectors and stay the semantic spec.
The CLI wires the seam:

```ts
seam.sessionContext = async (cwd, sessionId) =>
  (await collectSessionContext(cwd, sessionId)).lines.join('\n') || undefined
seam.promptContext = async (cwd, sessionId, text) =>
  (await collectPromptContext(cwd, sessionId, text)).lines.join('\n') || undefined
```

**cwd is per-session.** Every probe runs against `session/new.cwd`,
never the proxy process's cwd — a client that opens a session in
another repo gets THAT repo's context or nothing. `hooksStateDir`
execs `git rev-parse --git-common-dir` with `cwd: dir` so markers,
trace tails, and the context cache all resolve inside the session's
repo. The pending buffer records `cwd` at `session/new`; the prompt
seam uses it; a session whose cwd hosts no bro-enabled repo simply
collects zero lines (fail-open, same as the hook).

The injected block is one plain `text` content block — no `bro:`
marker in v1 (bro-rs8sp's open question; the plainest block that works
wins — honesty about injection is a client-compat tradeoff the seam
defers). Prompt content blocks flatten to text for the prompt-submit
probe input (text blocks join; non-text blocks contribute nothing —
the probes read prompt text today, not images).

### Lifecycle and failure contract

- Downstream dead at `initialize` → its real error crosses to the
  client (verbatim errors — no synthesized success).
- Downstream dies mid-session → `Connection.closed` rejects pending
  upstream responses; surfaced, never faked.
- Upstream closes (client exited / stdin EOF) → close downstream, kill
  the child, exit 0.
- Downstream closes first → close upstream, exit 1 — a dead agent is
  not a clean session end.
- The seam runs only at the mapped points — never per `session/update`
  chunk; text deltas pay no probe cost.

### Telemetry

- `otelSpan('acp.proxy.session')` wraps a session's life
  (`session/new` → `session/close` or connection end);
  `otelSpan('acp.proxy.turn')` wraps each `session/prompt` round-trip
  with `{sessionId, injected, stopReason}` — same `otelSpan` tree the
  acp provider uses.
- `session/update` observations feed `agentTurnPlane` keyed by the
  upstream session id — `by: 'acp proxy'`. The plane already degrades
  unbadged (no `BRO_AGENT_ID`) runs to bus-only; the proxy-scoped
  archive dir lands with the turn-observation wiring (an unbadged
  human-run `bro acp proxy` journals under
  `<common>/bro/proxy/<session>.events.jsonl`, not the agents dir).

### CLI surface

`bro acp proxy -- <agent cmd…>` — one subcommand; `--` is mandatory
(the argv tail is the successor, tokenized verbatim — never a shell
string). Registered in `plugins.ts` as a visible `fleet`-group plugin
with `skill: 'acp'`; `acp-worker` stays the hidden sibling. Usage
errors (no `proxy`, no `--`, empty tail) exit 2.

## Verify

- `acp-proxy.test.ts` — the e2e is in-process: a real `client()` app
  drives the proxy over a memory stream; the proxy's downstream is a
  real `agent()` app (`fakeAcpAgent`'s shape) over the paired memory
  stream. Assert:
  - `initialize`/`session/new`/`session/prompt` round-trip — response
    envelopes identical to a direct client→agent leg.
  - First `session/prompt` carries ONE prepended text block with the
    seam's session-start context; the second prompt of the same
    session does not re-inject it; prompt-submit context lands on
    every prompt; absent seam → byte-identical forwarding.
  - `session/update` notifications and `session/request_permission`
    cross verbatim agent→client (the fake's scripted permission ask
    gets the client's answer).
  - An unknown `_`-method request forwards and its response/error
    crosses verbatim.
  - `session/cancel` arriving while the seam is computing answers the
    held prompt `stopReason:'cancelled'` — the downstream never sees
    that prompt.
  - A downstream request error (`failPrompt`) surfaces upstream with
    the peer's code/message — no rewrite.
  - Downstream spawn argv: `BRO_HOOKS=0` pinned on the child env.
- Latency: the test measures in-process per-turn overhead
  (proxied-vs-direct on the same fake agent) and prints it — the
  in-process floor documents the transport cost; real-agent overhead
  is dominated by the agent itself. Number recorded in the PR body.
- `npm run build`, `npm run typecheck`, `npm test` — the repo's CI
  gates, run before the PR.
- Manual pass against `devin -p --acp` and `kilo --acp` — the
  acceptance the bead names; documented in the skill (how to wire a
  client), executed in the PR verification where a live agent exists.
