/** DELETE /api/v1/agents/<ref> — the stop route's response builder,
 *  kept out of serve.ts (the file is over the 1000-line/75-function
 *  budget; the route's verdict ladder is its own unit) (bro-l8c4f.3). */
import type { StopOutcome } from './agents.ts'
import type { ServeDeps, ServeResponse } from './serve.ts'

/** Operator-facing detail for a non-clean verdict — the connector's
 *  own detail when it has one, else the reported post-stop state. */
function stopDetail(outcome: StopOutcome): string | undefined {
  return (
    outcome.detail ??
    (outcome.agent !== undefined ? `the backend reports ${outcome.agent.state}` : undefined)
  )
}

/** The 409's error line — names what the connector could not confirm. */
function stopRefusalError(ref: string, outcome: StopOutcome, detail: string | undefined): string {
  if (outcome.verdict === 'timeout') {
    return `"${ref}" survived the stop signal — still running`
  }
  return `"${ref}" — stop unverified` + (detail !== undefined ? `: ${detail}` : '')
}

/** A stop that did not reach verified death is not a 200 a client
 *  could read as safe-to-respawn (bro-l8c4f.3): a survivor or an
 *  unverifiable death is 409; a delivered-but-unconfirmable stop is
 *  202 — accepted, not enacted. */
function stopVerdictResponse(ref: string, outcome: StopOutcome): ServeResponse | undefined {
  if (outcome.verdict === undefined || outcome.verdict === 'stopped') {
    return undefined
  }
  const detail = stopDetail(outcome)
  const body = {
    agent: outcome.agent,
    stopped: false,
    verdict: outcome.verdict,
    ...(detail !== undefined ? { detail } : {}),
    ...(outcome.respawned !== undefined ? { respawned: outcome.respawned } : {}),
  }
  if (outcome.verdict === 'stopping') {
    // delivered but unconfirmable by this backend — accepted, not dead
    return { status: 202, body }
  }
  return { status: 409, body: { error: stopRefusalError(ref, outcome, detail), ...body } }
}

/** The 200 envelope — verified stops only; `terminal`/`note` keep
 *  "was already dead" machine-readable so clients never string-match. */
function stoppedOkBody(outcome: StopOutcome): Record<string, unknown> {
  return {
    agent: outcome.agent,
    stopped: outcome.stopped,
    ...(outcome.terminal === true ? { terminal: true } : {}),
    ...(outcome.cleared === true ? { cleared: true } : {}),
    ...(outcome.terminal === true && outcome.agent !== undefined
      ? {
          note: outcome.cleared === true ? 'blocked — cleared' : `already ${outcome.agent.state}`,
        }
      : {}),
    ...(outcome.respawned !== undefined ? { respawned: outcome.respawned } : {}),
  }
}

/** The full DELETE response — the miss ladder, the verdict refusal,
 *  then the verified-stop 200. */
function agentDeleteResponse(ref: string, outcome: StopOutcome): ServeResponse {
  if (!outcome.found) {
    // a degraded read can't confirm "gone" — unverifiable is not 404
    return outcome.degraded.length > 0
      ? {
          status: 503,
          body: {
            error: `cannot verify "${ref}" — backend(s) degraded`,
            degraded: outcome.degraded,
          },
        }
      : { status: 404, body: { error: `no agent "${ref}"` } }
  }
  return stopVerdictResponse(ref, outcome) ?? { status: 200, body: stoppedOkBody(outcome) }
}

export async function routeAgentDelete(
  ref: string,
  deps: ServeDeps
): Promise<ServeResponse> {
  return agentDeleteResponse(ref, await deps.stop(ref))
}
