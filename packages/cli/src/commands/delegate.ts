/**
 * `bro fleet delegate` — agent A activates agent B (spec bro-z8tng).
 *
 *   bro fleet delegate [prompt…] [--prompt <text>] [--prompt-file <file>]
 *                     [--provider <name> | --class <name>] [--model <m>]
 *                     [--wait [--timeout <sec>] | --detach [--connector <name>]
 *                      [--worktree <path>] [--auto-approve]] [--beads-dir <dir>]
 *                     [--json]
 *
 * One contract, two modes: --wait is the synchronous short ask — one
 * pooled ACP turn on a providers.<name> acp entry, text + provenance
 * back, no registry entry. --detach is real work — the same registry
 * spawn `bro agents run` takes (routing, walls, fleet.maxConcurrent,
 * session quotas, claim artifacts), returning an agentId. The caller's
 * BRO_AGENT_ID rides as delegatedBy provenance on both.
 */
import { readFileSync, statSync, type Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  BATCH_MARKER_ENV,
  resolveStepClass,
  SpawnError,
  wallText,
  type AgentInfo,
  type ProviderEntry,
  type ResolvedClass,
} from '@broject/core'
import {
  acpOpen,
  acpPooledTurn,
  type AcpSeam,
  type FetchFn,
  type ProviderWireOpts,
} from '@broject/providers'
import { beadsDir } from '@broject/convoy'
import {
  providerWallsFor,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError, spawnStepAgent } from './agents.ts'

const DEFAULT_TIMEOUT_SEC = 120
/** A pooled-turn payload — generous for diffs/specs, never a stream. */
const MAX_PROMPT_FILE_BYTES = 1024 * 1024
/** 24h — beyond that a "sync ask" isn't one, and the deadline math
 *  approaches the runtime timer ceiling (~24.8d). Exported for the
 *  CLI surface's usage validation. */
export const MAX_TIMEOUT_SEC = 86_400

/** The mode-independent request — the CLI parser and the plane's
 *  exec('delegate') args map onto this one shape. */
export interface DelegateRequest {
  prompt?: string
  promptFile?: string
  /** 'wait' (default) = pooled ACP turn; 'detach' = registry spawn. */
  mode?: 'wait' | 'detach'
  provider?: string
  class?: string
  model?: string
  /** --wait deadline seconds (default 120). */
  timeoutSec?: number
  connector?: string
  worktree?: string
  autoApprove?: boolean
  /** agentId of the asking agent — CLI defaults it from the caller's
   *  BRO_AGENT_ID pin; the MCP caller may declare its own. */
  delegatedBy?: string
  beadsDir?: string
}

export interface DelegateWaitResult {
  mode: 'wait'
  provider: string
  model: string
  class?: string
  stopReason: string
  text: string
  delegatedBy?: string
}

export interface DelegateDetachResult {
  mode: 'detach'
  delegatedBy?: string
  agent: AgentInfo
}

export type DelegateResult = DelegateWaitResult | DelegateDetachResult

/** The resolved side of a request — the routing lane verdict plus the
 *  provenance stamp (BRO_AGENT_ID fallback already applied). */
interface DelegateSel {
  req: DelegateRequest
  routed?: ResolvedClass
  delegatedBy?: string
}

export type DelegateOpts = { fetch?: FetchFn; acp?: AcpSeam }

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

/** fleet.routing is "declared" only when it holds at least one lane —
 *  an empty table reads the same as none. */
function declaredRouting(env: AgentConnectorEnv): NonNullable<AgentConnectorEnv['fleet']>['routing'] {
  const routing = env.fleet?.routing
  return routing !== undefined && Object.keys(routing).length > 0 ? routing : undefined
}

/** Shared provider/lane resolution: --provider pins directly, --class
 *  names a fleet.routing lane whose chain[0] supplies provider (+model);
 *  an unclassed request falls to the 'default' lane when routing is
 *  declared. undefined when no routing is declared and no provider is
 *  pinned — --wait refuses, --detach spawns provider-less like `bro
 *  agents run`. */
function routedLane(env: AgentConnectorEnv, req: DelegateRequest): ResolvedClass | undefined {
  if (req.provider !== undefined && req.class !== undefined) {
    throw new SpawnInputError('--provider and --class are mutually exclusive')
  }
  // an explicit provider pin bypasses lane resolution entirely — the
  // pin IS the lane, and a routing table with no usable default must
  // not reject a request that never asked for one
  if (req.provider !== undefined) {
    return undefined
  }
  const routing = declaredRouting(env)
  if (routing === undefined) {
    if (req.class !== undefined) {
      throw new SpawnInputError('--class names a fleet.routing lane — no fleet.routing is declared')
    }
    return undefined
  }
  // a delegate spawn/ask has no bead to read a class: label off — the
  // phantom molStep is minted per request, so the lane resolves the
  // same way routeStepClass would for a label-less step
  return resolveStepClass(routing, env.providers ?? {}, { class: req.class })
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
async function delegateWait(
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

/** --detach — the same spawn 'bro agents run' resolves: routing,
 *  walls, fleet.maxConcurrent, session quotas and the claim artifacts
 *  all ride spawnStepAgent. BRO_BATCH marks the fleet's lane (wall
 *  refusal + batch budget); delegatedBy stamps via the spec's
 *  provenance pin. */
async function delegateDetach(
  dir: string,
  env: AgentConnectorEnv,
  sel: DelegateSel,
  opts: DelegateOpts
): Promise<DelegateDetachResult> {
  const { req, delegatedBy } = sel
  const agent = await spawnStepAgent(
    dir,
    env,
    {
      molStep: `adhoc-${randomBytes(4).toString('hex')}`,
      connector: req.connector,
      worktree: req.worktree,
      prompt: req.prompt,
      promptFile: req.promptFile,
      beadsDir: req.beadsDir ?? beadsDir(),
      provider: req.provider,
      model: req.model,
      class: req.class,
      autoApprove: req.autoApprove,
      delegatedBy,
      env: { [BATCH_MARKER_ENV]: '1' },
    },
    opts
  )
  return {
    mode: 'detach',
    ...(delegatedBy !== undefined ? { delegatedBy } : {}),
    agent,
  }
}

/** Fields that only make sense under one mode — the other mode
 *  refuses them rather than silently ignoring a caller's intent. */
const DETACH_ONLY_FIELDS = ['connector', 'worktree', 'autoApprove'] as const
const WAIT_ONLY_FIELDS = ['timeoutSec'] as const

/** Mode-shape gate the CLI and the plane share — the exec boundary
 *  would otherwise accept mode-foreign fields the CLI's parser dies
 *  on. */
function checkModeFields(req: DelegateRequest): void {
  const mode = req.mode ?? 'wait'
  const foreign = (mode === 'wait' ? DETACH_ONLY_FIELDS : WAIT_ONLY_FIELDS).filter(
    (k) => req[k] !== undefined
  )
  if (foreign.length > 0) {
    const other = mode === 'wait' ? 'detach' : 'wait'
    throw new SpawnInputError(`${foreign.join(', ')} only apply to --${other}`)
  }
}

/** The delegate contract — both CLI and the agents plane's
 *  exec('delegate') run it. Throws SpawnInputError on bad input,
 *  SpawnError on refusal/config/availability — callers render. */
export async function delegate(
  dir: string,
  env: AgentConnectorEnv,
  req: DelegateRequest,
  opts: DelegateOpts = {}
): Promise<DelegateResult> {
  checkModeFields(req)
  const sel: DelegateSel = {
    req,
    routed: routedLane(env, req),
    delegatedBy: req.delegatedBy ?? (process.env.BRO_AGENT_ID?.trim() || undefined),
  }
  return (req.mode ?? 'wait') === 'wait'
    ? delegateWait(dir, env, sel, opts)
    : delegateDetach(dir, env, sel, opts)
}

