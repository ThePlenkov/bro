---
parent: bro-l67jh
scope:
  - packages/providers/src/acp-proxy.ts
  - packages/providers/src/acp-proxy.test.ts
  - packages/providers/src/acp-events.ts
  - packages/providers/src/acp-events.test.ts
  - packages/cli/src/commands/acp.ts
  - packages/cli/src/commands/hooks.ts
  - packages/cli/src/commands/hooks.test.ts
  - skills/acp/SKILL.md
---

# bro-9qopj — acp proxy: permission policy at the protocol seam

Parent: `bro-l67jh` (epic — bro speaks ACP outward). The audit groundwork
is already decided: `specs/bro-rs8sp.md`'s hook↔ACP table maps the
`permission` row — `allow` → `allow_once`, `ask` → forward upstream,
`deny` → `reject_once` (`cancelled` when no reject option is offered),
`*_always` kinds deliberately unmapped — and its pre-tool row maps
connector guard verdicts onto this same path (the permission ask is the
wire's only veto point; input rewrites degrade to their verdict). This
spec turns those two rows into running seam behavior on top of
bro-bhyo1's pump and bro-u2eps's in-process seam structure.

## Problem

Permission handling is duplicated per client: `hooks.ts`'s
`emitPermission` (session cap + self-tool approve) runs for the
PermissionRequest hosts, `emitPreTool`'s `preToolVerdicts` connector
sweep for the PreToolUse hosts, cursor's `permission` dialect answers
`ask` — every adapter re-derives "should this call run" its own way. An
ACP client behind `bro acp proxy` gets none of it: `routeA2C` forwards
agent→client requests verbatim (`isRequest` → `writeUp`), so a
`session/request_permission` always lands on the human — even for a
`bd ready` the hook plane would auto-approve, and even for a
session-spawning command the cap must refuse. Policy decided per
client cannot see bro's guard plane at all.

In the proxy, `session/request_permission` is ONE place: every ACP
client inherits the policy the hooks already run.

## Design

### The a2c pending table

Today only c2a requests are tracked (`pending`); a2c requests forward
untouched. Interception needs a second table — `pendingA2C` — where
EVERY agent→client request registers `{method, sessionId?, permission?}`
before it crosses upstream. It buys three things:

- **Response relay.** A c2a response discharges its entry, lands the
  bookkeeping (a forwarded permission ask's answer journals), then
  relays verbatim downstream. Untracked responses relay the same way —
  the table annotates, it doesn't gate the wire.
- **Held-ask settling.** A permission ask held for the policy eval is
  session-scoped: a `session/cancel` or `session/close` on that session
  answers it `{outcome:'cancelled'}` downstream — the wire never shows
  an ask after its cancel (the held-prompt rule, one level up).
  Already-forwarded asks keep their pending entry — the client's own
  answer is owed the relay.
- **Dead-client settling.** When the upstream leg ends first, every
  outstanding a2c request is answered downstream — a permission ask
  gets `{outcome:'cancelled'}`, anything else a `-32603` "upstream
  client closed" error. A client that can never answer must not leave
  the agent stalled on its question; mirrored from the
  downstream-dead sweep the c2a table already runs.

### The permission interception

`routeA2C`'s request branch routes `session/request_permission` to the
seam eval; every other a2c request registers and crosses verbatim. The
eval is **free-standing** — it must never queue on the session's
`writeQ`: an ask inside a gate turn would deadlock behind the
discharge it exists to unblock (the gate turn holds the writeQ slot
until its response lands; the response can't land until the ask is
answered). The pending entry registers synchronously at request time,
so a cancel/close/teardown racing the eval settles the ask and the
verdict lands on an empty slot — same `crossable` discipline the held
prompt uses.

`AcpProxySeam.permission(cwd, sessionId, call)` returns
`{verdict:'allow'|'deny'|'ask', reason?, hints?}` — the PermissionRequest
hook's three outcomes. `call` is the wire's `toolCall` normalized like
`AcpProxyToolCall` (`input` = `rawInput` verbatim, the `tool_input`
analog).

The verdict maps onto the wire per bro-rs8sp:

- **allow** → `selected` with the `allow_once` option; `allow_always`
  only when it is the polarity's sole offered variant (the option set
  is the agent's own choice space — refusing a sole offered option
  fails an answerable request). No allow option offered at all →
  denied, never an invented approval (the acp-worker autoApprove
  rule): the answer falls to the deny path.
- **deny** → `selected` with `reject_once` (same `*_always` fallback);
  `cancelled` when no reject option is offered — the `denyPermission`
  shape already proven in acp.ts/acp-worker.
- **ask** — and also: no seam leg, a throwing eval (fail-open, logged),
  `BRO_HOOKS=0`, a cwd-less or unstamped session → forward verbatim.
  The client's own answer is the honest one.

`hints` buffer onto `ses.advisory` — guard `warn` lines ride the next
crossed prompt, the same advisory channel toolCall's say lines already
use. `reason` journals the why (a deny's block/cap-refusal text, an
allow-fallback's "no allow option offered").

### The journal

Decisions land in the session's events archive through a new
`AgentTurnPlane.note(row)` — an out-of-band row written outside the
update funnel: a permission verdict is a client-bound exchange the
`session/update` stream never carries, so a cross-process viewer only
sees it through the journal. This is the acp-worker's
`agentEventRecord` posture (`kind:'permission'` rows, same `title`/
`verdict` vocabulary) moved onto the plane itself — which is what lets
an UNBADGED proxy run journal under `bro/proxy/` where
`agentEventRecord`'s agents-scope badge requirement would write
nothing.

Row shape: `{kind:'permission', title, toolCallId?, by, verdict,
optionId?, reason?}` — `by:'proxy'` for seam-decided answers
(`approved`/`denied`/`cancelled`), `by:'client'` for forwarded asks,
with the client's selected optionId mapped back to a verdict through
the offered option kinds (a `cancelled` outcome or an error answer
journals as such).

### The collector (CLI side)

`collectPermission(dir, sessionId, call)` in hooks.ts — the
PermissionRequest hook's in-process half, same collector shape as
`collectToolCallGuards`/`collectStopGate` (fail-open to `ask`, `dir` is
the session repo, never the proxy's cwd). Order mirrors the real hook
pipeline — pre-tool verdicts first (the PreToolUse event precedes
PermissionRequest on hook hosts), then emitPermission's own checks:

1. `preToolVerdicts(hookCtx(dir, sessionId, toolCallId), tool, input)`
   — the connector guard plane's only ACP veto point (spec rs8sp's
   pre-tool row). `block` → deny with the block text; `warn` → hints;
   `input` overrides are dropped — input rewrite is unsupported in
   proxy mode, a probe returning one degrades to its verdict.
2. `sessionCapRefusalForHook(cmd, dir, sessionId, undefined,
   toolCallId)` → deny — the same call `emitPermission` makes, and
   unconditional the same way: a mode that disables the session-cap
   connector still can't spend the account. Dedup is the shared
   `toolUseId` claim key — the pre-tool sweep and this call claim ONE
   slot for one call, exactly like the two hook events they replace.
3. `isSelfToolCommand(cmd)` → allow — bro/bd invocations approve
   outright.
4. Otherwise → `ask` (+ any warn hints).

### What changes for the client

Nothing on the wire it can't already parse: a denied ask resolves as a
normal `selected`/`cancelled` permission response — indistinguishable
from the human's own answer, which is the point: every client gets the
policy, no client needs a hook dialect for it.

## Verify

- providers unit (acp-proxy.test.ts): allow → `selected` allow_once
  downstream, client never sees the ask; deny → `selected` reject_once,
  `cancelled` when no reject offered; `*_once` preferred over
  `*_always`, `*_always` taken when sole of its polarity; allow with no
  allow option → denied, not invented; ask/absent/throwing seam /
  BRO_HOOKS=0 / cwd-less session → verbatim forward; cancel during the
  eval → downstream `cancelled`, ask never crosses; upstream death →
  held asks answered; journal rows written for proxy-decided and
  client-answered asks.
- providers unit (acp-events.test.ts): `plane.note` lands an
  out-of-band row in the plane's own archive (agents scope AND the
  unbadged proxy scope).
- cli unit (hooks.test.ts): `collectPermission` — connector block →
  deny, warn → hints, self-tool `bd`/`bro` → allow, ordinary call →
  ask, fail-open outside a bro repo.
- cli e2e (acp.test.ts): the seam wired as `commands/acp.ts` wires it —
  a connector `preTool` block denies on the wire, a `bd` call
  auto-approves, and `bro/proxy/*.events.jsonl` carries the
  `kind:'permission'` rows.
- regression: the verbatim-forwarding and bro-u2eps suites stay green —
  non-permission a2c traffic is untouched.
