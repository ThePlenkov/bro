/** `bro fleet delegate --wait` — the synchronous ask. One pooled ACP
 *  turn on a providers.<name> acp entry, bounded by --timeout, refused
 *  by provider walls before any spend. Reply text + provenance back;
 *  no registry entry. (spec bro-z8tng) */
import {
  acpOpen,
  acpPooledTurn,
  type ProviderWireOpts,
} from '@broject/providers'
import {
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError } from './agents.ts'
import { delegatePrompt } from './delegate-prompt.ts'
import { acpEntry, refuseWalled, waitProviderName } from './delegate-provider.ts'
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  type DelegateOpts,
  type DelegateSel,
  type DelegateWaitResult,
} from './delegate.ts'

function validTimeoutSec(sec: number): boolean {
  return Number.isFinite(sec) && sec > 0 && sec <= MAX_TIMEOUT_SEC
}

function waitDeadline(timeoutSec: number | undefined): number {
  const sec = timeoutSec ?? DEFAULT_TIMEOUT_SEC
  if (!validTimeoutSec(sec)) {
    throw new SpawnInputError(`--timeout must be 1..${MAX_TIMEOUT_SEC} seconds`)
  }
  return Date.now() + sec * 1000
}

/** --wait — one pooled ACP turn. Provider walls refuse first: a
 *  delegate turn is automated spend, not the interactive lane. The
 *  peer is per-request (no pool to keep warm across CLI invocations)
 *  and always closes — the 'exit' hook covers a mid-turn kill so the
 *  acp child can never orphan. */
export async function delegateWait(
  dir: string,
  env: AgentConnectorEnv,
  sel: DelegateSel,
  opts: DelegateOpts
): Promise<DelegateWaitResult> {
  const name = waitProviderName(sel.req, sel.routed)
  const entry = acpEntry(env, name, sel.req.provider !== undefined)
  refuseWalled(dir, name)
  // resolve the prompt before the peer exists — a bad request must not
  // spawn (and then tear down) a provider process, nor burn the
  // shared deadline on acpOpen for an ask that can never run
  const prompt = delegatePrompt(sel.req)
  const deadline = waitDeadline(sel.req.timeoutSec)
  const wire = waitWire(sel, dir, opts)
  const peer = await acpOpen(`delegate:${name}`, entry, wire, deadline)
  const onExit = (): void => peer.close()
  process.once('exit', onExit)
  try {
    const r = await acpPooledTurn(peer, entry, wire, prompt, deadline, {
      by: 'delegate',
      requestModel: sel.req.model,
      signal: opts.acp?.signal,
      onUpdate: opts.acp?.onUpdate,
    })
    return waitResult(name, sel, r)
  } finally {
    process.removeListener('exit', onExit)
    peer.close()
  }
}

/** --model is the request pin: it outranks the chain's and the
 *  entry's configured model but the reported model stays honest
 *  (resolveTurnModel reports what the agent actually runs); a routed
 *  model only applies to an unpinned ask. */
function waitWire(sel: DelegateSel, dir: string, opts: DelegateOpts): ProviderWireOpts {
  const model = sel.req.model ?? (sel.req.provider === undefined ? sel.routed?.model : undefined)
  return { model, acp: { ...opts.acp, cwd: opts.acp?.cwd ?? dir } }
}

/** The wait contract's result — class/delegatedBy ride as optional
 *  provenance, absent fields omitted honestly. */
function waitResult(
  name: string,
  sel: DelegateSel,
  r: { model: string; stopReason: string; text: string }
): DelegateWaitResult {
  return {
    mode: 'wait',
    provider: name,
    model: r.model,
    ...(sel.routed?.class !== undefined ? { class: sel.routed.class } : {}),
    stopReason: r.stopReason,
    text: r.text,
    ...(sel.delegatedBy !== undefined ? { delegatedBy: sel.delegatedBy } : {}),
  }
}
