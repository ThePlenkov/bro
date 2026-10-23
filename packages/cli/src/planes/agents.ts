/** agents plane — the worker registry behind `bro agents status` and
 *  the fleet table `bro fleet` renders. Rows are Worker; `backend` is
 *  a provenance value, never a field name (specs/bro-9rls.1.md). The
 *  `delegate` verb is the plane's one wired write surface — agent A
 *  activates agent B (spec bro-z8tng): exec args map onto the same
 *  delegate() core `bro fleet delegate` runs, so REST POST
 *  /api/v1/planes/agents/delegate and the MCP bro_agents_delegate tool
 *  serve the identical contract. */
import {
  PlaneUnavailable,
  PlaneVerbError,
  SpawnError,
  verbsNotWired,
  type AgentInfo,
  type PlaneCtx,
  type PlaneDescriptor,
  type Worker,
} from '@broject/core'
import { loadAgentEnv } from '../agent-connectors.ts'
import { collectAgentBackends, findInBackends, SpawnInputError } from '../commands/agents.ts'
import { delegate, type DelegateRequest } from '../commands/delegate.ts'
import { collectFleet } from '../commands/fleet.ts'
import { bounded, dispatchRead } from './helpers.ts'

const VERBS = ['spawn', 'stop', 'respawn', 'delegate']
/** The one wired verb — declared, exec'd, and MCP-exposed
 *  (mcpVerbs); spawn/stop/respawn stay declared-but-unwired. */
const DELEGATE = 'delegate'

const workerRow = (a: AgentInfo): Worker => ({
  id: a.id,
  backend: a.backend,
  state: a.state,
  step: a.molStep,
  cause: a.cause,
  pid: a.pid,
  worktree: a.worktree,
  provider: a.provider,
  model: a.model,
})

const DELEGATE_STR_KEYS = [
  'prompt',
  'promptFile',
  'provider',
  'class',
  'model',
  'connector',
  'worktree',
  'delegatedBy',
  'beadsDir',
] as const

/** exec args → DelegateRequest — PlaneVerbError on a mistyped field
 *  (client bug), the core's SpawnInputError on a semantically bad one. */
function delegateArgs(args: Record<string, unknown>): DelegateRequest {
  const req: Record<string, unknown> = {}
  for (const k of DELEGATE_STR_KEYS) {
    const v = args[k]
    if (v === undefined) {
      continue
    }
    if (typeof v !== 'string' || v === '') {
      throw new PlaneVerbError('agents', DELEGATE, `${k} must be a non-empty string`)
    }
    req[k] = v
  }
  const mode = args['mode']
  if (mode !== undefined && mode !== 'wait' && mode !== 'detach') {
    throw new PlaneVerbError('agents', DELEGATE, `mode must be 'wait' or 'detach'`)
  }
  req['mode'] = mode
  const timeoutSec = args['timeoutSec']
  if (timeoutSec !== undefined) {
    if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec)) {
      throw new PlaneVerbError('agents', DELEGATE, 'timeoutSec must be a number')
    }
    req['timeoutSec'] = timeoutSec
  }
  const autoApprove = args['autoApprove']
  if (autoApprove !== undefined) {
    if (typeof autoApprove !== 'boolean') {
      throw new PlaneVerbError('agents', DELEGATE, 'autoApprove must be a boolean')
    }
    req['autoApprove'] = autoApprove
  }
  return req as unknown as DelegateRequest
}

/** delegate()'s error vocabulary → the plane's: caller input is a
 *  client bug (PlaneVerbError → REST 400), a refusal or unreachable
 *  backend is PlaneUnavailable (→ 503) — never a bare 500. */
function execOrPlaneError(err: unknown): never {
  if (err instanceof SpawnInputError || (err instanceof SpawnError && err.kind === 'input')) {
    throw new PlaneVerbError('agents', DELEGATE, err instanceof Error ? err.message : String(err))
  }
  if (err instanceof SpawnError) {
    throw new PlaneUnavailable('agents', err.message)
  }
  throw err
}

export function agentsPlane(ctx: PlaneCtx): PlaneDescriptor {
  const dir = ctx.dir
  const env = () => loadAgentEnv(dir)
  const reads: Record<string, (a?: Record<string, unknown>) => unknown> = {
    /** `bro agents status --json` — per-backend planes + occupancy,
     *  degraded notes kept verbatim. */
    backends: async () => {
      const { backends } = await collectAgentBackends(dir, env())
      return {
        backends: backends.map((b) => ({
          name: b.conn.name,
          agents: b.agents.length,
          ...(b.degraded === undefined ? {} : { degraded: b.degraded }),
        })),
      }
    },
    /** `bro fleet --json` — mol×step×worker×worktree×PR payload,
     *  degraded/conflict/wall planes included. The pinned reviews
     *  connector rides through or the PR column would resolve a
     *  different backend than the gates plane serves. */
    fleet: async () => collectFleet(dir, ctx.connectors),
  }
  return {
    name: 'agents',
    reads: Object.keys(reads),
    verbs: VERBS,
    mcpVerbs: [DELEGATE],
    readArgs: {
      list: { type: 'object', properties: {} },
      backends: { type: 'object', properties: {} },
      fleet: { type: 'object', properties: {} },
    },
    verbArgs: {
      [DELEGATE]: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'the ask (or work order) text' },
          promptFile: { type: 'string', description: 'path to a prompt file — exclusive with prompt' },
          mode: {
            type: 'string',
            enum: ['wait', 'detach'],
            description:
              "'wait' (default): synchronous short ask — one pooled ACP turn, text + provenance back. 'detach': real work — registry spawn, returns the new agentId",
          },
          provider: { type: 'string', description: 'providers.<name> — wait needs an acp entry' },
          class: { type: 'string', description: 'fleet.routing lane — chain[0] supplies the provider' },
          model: { type: 'string', description: 'model override' },
          timeoutSec: { type: 'number', description: 'wait-mode deadline seconds (default 120)' },
          connector: { type: 'string', description: 'detach-mode backend pin' },
          worktree: { type: 'string', description: 'detach-mode worktree path' },
          autoApprove: { type: 'boolean', description: 'detach-mode ACP permission policy' },
          delegatedBy: { type: 'string', description: 'agentId of the asking agent — defaults to the caller pin' },
          beadsDir: { type: 'string', description: 'shared store override' },
        },
      },
    },
    /** spawn-able means ≥1 backend answers list() non-degraded — the
     *  same signal occupancy/fleet reads report. A fully degraded
     *  registry hides the tools instead of serving all-error rows.
     *  `delegate` is capable when EITHER mode can serve: a live
     *  backend for --detach, or a configured acp provider for --wait. */
    capabilities: async () => {
      const ok = await bounded(
        collectAgentBackends(dir, env())
          .then(({ backends }) => backends.some((b) => b.degraded === undefined))
          .catch(() => false),
        10_000,
        false
      )
      const acpConfigured = Object.values(env().providers ?? {}).some((e) => e.type === 'acp')
      return { read: ok, spawn: false, stop: false, respawn: false, delegate: ok || acpConfigured }
    },
    list: async () => {
      const { backends } = await collectAgentBackends(dir, env())
      if (backends.length > 0 && backends.every((b) => b.degraded !== undefined)) {
        const notes = backends.map((b) => `${b.conn.name}: ${b.degraded}`).join('; ')
        throw new PlaneUnavailable('agents', `every agent backend degraded — ${notes}`)
      }
      return backends.flatMap((b) => b.agents.map(workerRow))
    },
    get: async (ref) => {
      const { backends } = await collectAgentBackends(dir, env())
      const { hit } = findInBackends(backends, ref)
      return hit === undefined ? undefined : workerRow(hit.agent)
    },
    read: (name, args) => dispatchRead('agents', reads, name, args),
    exec: async (verb, args) => {
      if (verb !== DELEGATE) {
        return verbsNotWired('agents', VERBS)(verb, args)
      }
      try {
        return await delegate(dir, env(), delegateArgs(args))
      } catch (err) {
        execOrPlaneError(err)
      }
    },
  }
}
