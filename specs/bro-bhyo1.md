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
| `session/new` · `session/fork` · `session/load` · `session/resume` | Forward verbatim. On a SUCCESSFUL response, stamp a pending-context buffer `{cwd}` under the session id — preferring the RESPONSE's `sessionId` (`session/fork`'s params carry the source id; the fork's own id only exists in the result) and falling back to the request param when the result omits one. An error response stamps nothing — a failed open must not register a session the client's retry would collide with. `cwd` comes from request params — absent on load/resume the session stamps cwd-less and the seam skips it; the proxy's own cwd is never a fallback. |
| `session/prompt` | Queue the prompt behind the session's serialized write; inside the queue, decide "first" as *first prompt to actually cross* (a cancelled held prompt never claims the slot, and two queued prompts can't both take it). While the session owes start context, run the session seam; a SETTLED collection contributes its text and marks the slot done, an unsettled one (probe timeout/error) injects nothing and retries on the next prompt — partial output is never presented as complete. Run the prompt-submit seam on the flattened prompt text on every prompt; prepend ONE `text` content block combining whatever context exists; forward the rewritten params. |
| `session/cancel` | Held prompts (injection queued or computing) are answered upstream with `{stopReason:'cancelled'}` and never cross — the wire never shows a prompt after its cancel. The cancel itself crosses only while crossed work still runs downstream — it is session-scoped, in-flight prompts are its real targets; a cancel whose whole target set was held prompts is fully handled by the proxy, so the wire never shows a cancel without its prompt either. |
| `session/close` | Forward verbatim (queued with the session's other writes). On a successful response the session is released — held prompts answered `stopReason:'cancelled'`, session entry dropped, span ended, plane drained — so a reused session id can't see stale state. A failed close leaves the session live. |
| everything else | Verbatim — `session/set_*`, `session/delete`, `session/list`, `authenticate`, `providers/*`, `nes/*`, `document/*`, unknown `_`-methods. |

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
The CLI wires the seam — `settled` crosses into the proxy so an
unsettled probe set is retried, not presented as complete:

```ts
seam.sessionContext = async (cwd, sessionId) => {
  const r = await collectSessionContext(cwd, sessionId)
  return { text: r.lines.join('\n') || undefined, settled: r.settled }
}
seam.promptContext = async (cwd, sessionId, text) =>
  (await collectPromptContext(cwd, sessionId, text)).lines.join('\n') || undefined
```

**cwd is per-session.** Every probe runs against `session/new.cwd`,
never the proxy process's cwd — a client that opens a session in
another repo gets THAT repo's context or nothing, and a session whose
params carry no `cwd` at all (`session/load`/`resume`/`fork`) skips the
seam rather than probing the wrong repo. `hooksStateDir` resolves the
session's common dir through `gitCommonDir(dir)` — the canonical
probe resolves relative `.git` output against `dir` and scrubs an
inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`, so markers,
trace tails, and the context cache all resolve inside the session's
repo and never retarget at whatever repository spawned the proxy. The pending buffer records `cwd` at `session/new`; the prompt
seam uses it; a session whose cwd hosts no bro-enabled repo simply
collects zero lines (fail-open, same as the hook).

The injected block is one plain `text` content block — no `bro:`
marker in v1 (bro-rs8sp's open question; the plainest block that works
wins — honesty about injection is a client-compat tradeoff the seam
defers). Prompt content blocks flatten to text for the prompt-submit
probe input (text blocks join; non-text blocks contribute nothing —
the probes read prompt text today, not images).

**Trust model on the session cwd.** `bro acp proxy` is spawned *by*
the ACP client over stdio — the client already executes with the
proxy's privileges (it could exec the same file directly), so a
client-supplied `cwd` is input inside the client's own trust domain,
not a privilege boundary. The seam therefore executes the session
repo's `bro.config.ts` exactly as the hook path does in its own
project — repo config is code by design. A client pointing at a
hostile directory can only trigger what it could already run itself.

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
  upstream session id — `by: 'acp proxy'`. The plane's
  `start()`/`stop()` bookend each turn: `start` when a prompt crosses
  downstream, `stop` when its response lands (a held prompt aborted by
  cancel/close never started a downstream turn and emits neither). The
  plane already degrades unbadged (no `BRO_AGENT_ID`) runs to
  bus-only; the proxy-scoped archive dir lands with the
  turn-observation wiring (an unbadged human-run `bro acp proxy`
  journals under
  `<common>/bro/proxy/acp-<session>-p<pid>.events.jsonl`, not the
  agents dir — the pid keeps concurrent runs of one session id from
  sharing an archive).

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
    that prompt, and the retry that crosses next is still the
    session's "first" prompt (session context rides it).
  - An unsettled session collection injects nothing and retries on the
    next prompt; a settled one (even empty) marks the slot done.
  - `session/fork` registers under the RESPONSE's sessionId —
    prompting the fork gets the seam.
  - `session/close` releases the session — a later prompt on the same
    id crosses un-stamped (no seam, no injection).
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
