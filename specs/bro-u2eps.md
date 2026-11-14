# bro-u2eps — acp proxy: tool_call guards + stop gate at turn end

Parent: bro-l67jh (ACP-native connective layer). Depends on: bro-bhyo1 (closed).

## Problem

Hook mechanics cost 166–303 ms per tool call when they run as a subprocess
(the `hooks/run.sh` path every interactive session pays). The ACP proxy
(`packages/providers/src/acp-proxy.ts`) forwards `session/update`
notifications to telemetry only (`feedPlane`) — the session-marker arming
and guard defs that the hook plane runs per tool call never fire in proxy
mode, and the stop gate has no turn-end evaluation at all. An agent driving
through `bro acp proxy` gets none of the gates an interactive session gets.

Audit note (bro-l67jh, 2026-11-11): `acp-proxy.ts` on main has no tool_call
guard or turn-end stop gate; `session/update` feeds only the telemetry
plane. The rs8sp spec's stop row explicitly defers the continuation
semantic here.

## Design

All in-process — no subprocess per tool call.

1. **tool_call arming + guards.** On `session/update` notifications whose
   `update.sessionUpdate === 'tool_call'` (and the matching
   `tool_call_update` completion), run the same work the hook plane does:
   session-marker arming (`readArmed`-family classification of the tool
   call's command/cwd) and guard-def evaluation. Reuse the in-process
   collectors the proxy already wires (`AcpProxyOptions.seam` —
   `collectSessionContext`/`collectPromptContext`); call the hooks module's
   classifier functions directly rather than shelling `run.sh`.
   Guard output follows the hook plane's contract: `say` text surfaces to
   the agent (as a proxy-side notice on the session/update stream or the
   next prompt context — pick the seam that already carries advisory text,
   never a fabricated wire message the client can't parse).

2. **Turn-end stop gate.** The turn ends when the agent's `session/prompt`
   response lands (`onAgentResponse` → `finishTurn`, ~L555). Before the
   response is written up to the client, evaluate `stopGateContributions`
   (`packages/core/src/connectors.ts`) for the session's cwd/markers:
   - no blocking contribution → forward the response verbatim (today's
     behavior);
   - blocking contribution → hold the prompt response, issue ONE follow-up
     `session/prompt` to the agent carrying the gate's message, and only
     forward a response once a turn ends with no block. "Gates, not loops"
     — the second end-of-turn passes unconditionally (same rule as the
     hook Stop gate: a repeated stop is let through).
   - The held response must still close the turn's span/plane bookkeeping
     (`finishTurn` semantics) — decide whether the re-prompt opens a new
     turn span or extends the current one; document the choice in code.

3. **BRO_HOOKS=0.** When `BRO_HOOKS=0` is set for the proxy process, skip
   both halves — the proxy is a transport, not a gate, for machine-backend
   trees. (ACP carries no per-session env channel — `session/new` params are
   `cwd`/`mcpServers` — so the process env is the only kill switch on this
   leg. `acpChildEnv` separately pins `BRO_HOOKS=0` into the spawned agent's
   env, which governs the child's own hook subprocesses, not the proxy's.)

4. **Failure posture.** Guard/stop evaluation is advisory-to-blocking per
   the gate contract, but a throwing probe must never corrupt the wire:
   evaluation errors are logged and treated as non-blocking (fail-open for
   transport integrity — the hook plane's own rule for probe crashes).

## Verify

- e2e: an armed `act` marker in the session's repo produces exactly one
  re-prompt; the second end-of-turn passes (spec acceptance criterion).
- unit: a `tool_call` session/update runs arming/guards with zero spawned
  subprocesses (assert no child_process spawn in the proxy path — test).
- unit: `BRO_HOOKS=0` disables both halves.
- unit: a throwing stopGate contribution does not block the turn and does
  not break the wire.
- regression: existing proxy forwarding tests stay green (verbatim
  passthrough unchanged when no gate blocks).
