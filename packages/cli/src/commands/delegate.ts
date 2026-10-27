/** The delegate contract — `bro fleet delegate` agent A activates
 *  agent B (spec bro-z8tng). One request shape, two modes:
 *
 *   --wait   the synchronous short ask — one pooled ACP turn on a
 *            providers.<name> acp entry (delegate-wait.ts), text +
 *            provenance back, no registry entry.
 *   --detach real work — the same registry spawn `bro agents run`
 *            takes (routing, walls, fleet.maxConcurrent, session
 *            quotas, claim artifacts), returning an agentId.
 *
 *  The caller's BRO_AGENT_ID rides as delegatedBy provenance on both.
 *  The CLI surface lives in delegate-cli.ts; both it and the agents
 *  plane's exec('delegate') run the delegate() dispatcher here. */
import { randomBytes } from 'node:crypto'
import {
  BATCH_MARKER_ENV,
  resolveStepClass,
  type AgentInfo,
  type ResolvedClass,
} from '@broject/core'
import {
  type AcpSeam,
  type FetchFn,
} from '@broject/providers'
import { beadsDir } from '@broject/convoy'
import {
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError, spawnStepAgent } from './agents.ts'
import { delegateWait } from './delegate-wait.ts'

export const DEFAULT_TIMEOUT_SEC = 120
/** A pooled-turn payload — generous for diffs/specs, never a stream. */
export const MAX_PROMPT_FILE_BYTES = 1024 * 1024
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
   *  BRO_AGENT_ID pin; the exec boundary never accepts it (provenance
   *  derives from caller identity, not request fields). */
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
export interface DelegateSel {
  req: DelegateRequest
  routed?: ResolvedClass
  delegatedBy?: string
}

export type DelegateOpts = { fetch?: FetchFn; acp?: AcpSeam }

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
