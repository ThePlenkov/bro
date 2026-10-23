/** `bro fleet delegate --wait` — the synchronous ask. One pooled ACP
 *  turn on a providers.<name> acp entry, bounded by --timeout, refused
 *  by provider walls before any spend. Reply text + provenance back;
 *  no registry entry. (spec bro-z8tng) */
import { readFileSync, statSync, type Stats } from 'node:fs'
import {
  SpawnError,
  wallText,
  type ProviderEntry,
  type ResolvedClass,
} from '@broject/core'
import {
  acpOpen,
  acpPooledTurn,
  type ProviderWireOpts,
} from '@broject/providers'
import {
  providerWallsFor,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError } from './agents.ts'
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_PROMPT_FILE_BYTES,
  MAX_TIMEOUT_SEC,
  type DelegateOpts,
  type DelegateRequest,
  type DelegateSel,
  type DelegateWaitResult,
} from './delegate.ts'

/** Read a --prompt-file — size + regularity gate before the read: a
 *  prompt file is one turn's payload, never an unbounded stream or a
 *  device. */
function promptFileText(path: string): string {
  let st: Stats
  try {
    st = statSync(path)
  } catch {
    throw new SpawnInputError(`prompt file ${path} does not exist or is not a regular file`)
  }
  if (!st.isFile()) {
    throw new SpawnInputError(`prompt file ${path} is not a regular file`)
  }
  if (st.size > MAX_PROMPT_FILE_BYTES) {
    throw new SpawnInputError(
      `prompt file ${path} is ${st.size} bytes — a turn payload caps at ${MAX_PROMPT_FILE_BYTES}`
    )
  }
  return readFileSync(path, 'utf8')
}

/** The prompt text the request carries — --prompt and --prompt-file
 *  are the same channel (mutually exclusive), whitespace-only is no
 *  prompt at all. */
function delegatePrompt(req: DelegateRequest): string {
  if (req.prompt !== undefined && req.promptFile !== undefined) {
    throw new SpawnInputError('prompt and promptFile are mutually exclusive')
  }
  const text =
    req.prompt ?? (req.promptFile === undefined ? undefined : promptFileText(req.promptFile))
  if (text === undefined) {
    throw new SpawnInputError('delegate requires a prompt — --prompt <text> or --prompt-file <file>')
  }
  if (text.trim() === '') {
    throw new SpawnInputError('prompt must not be empty')
  }
  return text
}

/** --wait's provider name: the pin wins, else the routed chain head. */
function waitProviderName(req: DelegateRequest, routed: ResolvedClass | undefined): string {
  const name = req.provider ?? routed?.provider
  if (name === undefined) {
    throw new SpawnInputError(
      'delegate --wait needs a provider — pass --provider <name> or declare fleet.routing.<class>.chain'
    )
  }
  return name
}

/** The provider's entry — must be acp-typed: a pooled turn needs an
 *  ACP peer, api/cli kinds have no session to converse over. A
 *  missing entry is the caller's bug when they pinned it, config when
 *  the lane resolved to it. */
function acpEntry(
  env: AgentConnectorEnv,
  name: string,
  pinned: boolean
): Extract<ProviderEntry, { type: 'acp' }> {
  const entry = env.providers?.[name]
  if (entry === undefined) {
    throw new SpawnError(`providers.${name} is not configured`, pinned ? 'input' : 'config')
  }
  if (entry.type !== 'acp') {
    throw new SpawnError(
      `providers.${name} (type '${entry.type}') cannot serve a delegate turn — --wait needs an 'acp' provider`,
      'config'
    )
  }
  return entry
}

/** Provider walls live in the repo registry — a non-repo dir reads as
 *  no walls (readAgentRegistry returns {} for ENOENT/no-common-dir), so
 *  any throw IS registry corruption: fail the wait closed rather than
 *  spend against a provider whose wall status is unknown. */
function wallsFor(dir: string): ReturnType<typeof providerWallsFor> {
  try {
    return providerWallsFor(dir)
  } catch (err) {
    throw new SpawnError(
      `provider walls unreadable — refusing the delegate turn closed: ${err instanceof Error ? err.message : String(err)}`,
      'unavailable'
    )
  }
}

function waitDeadline(timeoutSec: number | undefined): number {
  const sec = timeoutSec ?? DEFAULT_TIMEOUT_SEC
  if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_TIMEOUT_SEC) {
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
  const wall = wallsFor(dir).find((w) => w.provider === name)
  if (wall !== undefined) {
    throw new SpawnError(
      `${wallText(wall)} — the delegate lane waits; retry after the reset or --detach to a different lane`,
      'cap'
    )
  }
  const deadline = waitDeadline(sel.req.timeoutSec)
  // --model is the request pin: it outranks the chain's and the
  // entry's configured model but the reported model stays honest
  // (resolveTurnModel reports what the agent actually runs); a routed
  // model only applies to an unpinned ask
  const model = sel.req.model ?? (sel.req.provider === undefined ? sel.routed?.model : undefined)
  const wire: ProviderWireOpts = {
    model,
    acp: { ...opts.acp, cwd: opts.acp?.cwd ?? dir },
  }
  const peer = await acpOpen(`delegate:${name}`, entry, wire, deadline)
  const onExit = (): void => peer.close()
  process.once('exit', onExit)
  try {
    const r = await acpPooledTurn(peer, entry, wire, delegatePrompt(sel.req), deadline, {
      by: 'delegate',
      requestModel: sel.req.model,
      signal: opts.acp?.signal,
      onUpdate: opts.acp?.onUpdate,
    })
    return {
      mode: 'wait',
      provider: name,
      model: r.model,
      ...(sel.routed?.class !== undefined ? { class: sel.routed.class } : {}),
      stopReason: r.stopReason,
      text: r.text,
      ...(sel.delegatedBy !== undefined ? { delegatedBy: sel.delegatedBy } : {}),
    }
  } finally {
    process.removeListener('exit', onExit)
    peer.close()
  }
}
