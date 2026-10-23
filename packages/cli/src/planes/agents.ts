/** agents plane — the worker registry behind `bro agents status` and
 *  the fleet table `bro fleet` renders. Rows are Worker; `backend` is
 *  a provenance value, never a field name (specs/bro-9rls.1.md). The
 *  `delegate` verb is the plane's one wired write surface — agent A
 *  activates agent B (spec bro-z8tng): exec args map onto the same
 *  delegate() core `bro fleet delegate` runs, so REST POST
 *  /api/v1/planes/agents/delegate and the MCP bro_agents_delegate tool
 *  serve the identical contract. */
import {
  JudgeUnavailable,
  PlaneUnavailable,
  PlaneVerbError,
  SpawnError,
  verbsNotWired,
  type AgentInfo,
  type PlaneCtx,
  type PlaneDescriptor,
  type Worker,
} from '@broject/core'
import { resolve, sep } from 'node:path'
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
  delegatedBy: a.delegatedBy,
})

/** The exec surface — prompt shape is `verbArgs`'s schema; types are
 *  checked here so a mistyped field is a client bug, not a silent
 *  cast. `delegatedBy` is deliberately absent: provenance derives from
 *  the caller's authenticated identity (BRO_AGENT_ID), never from a
 *  self-declared request field. */
const DELEGATE_ARG_TYPES: Record<string, 'string' | 'number' | 'boolean'> = {
  prompt: 'string',
  promptFile: 'string',
  provider: 'string',
  class: 'string',
  model: 'string',
  connector: 'string',
  worktree: 'string',
  beadsDir: 'string',
  mode: 'string',
  timeoutSec: 'number',
  autoApprove: 'boolean',
}

/** exec args → DelegateRequest — PlaneVerbError on a mistyped field
 *  (client bug), the core's SpawnInputError on a semantically bad one. */
function delegateArgs(args: Record<string, unknown>): DelegateRequest {
  const req: Record<string, unknown> = {}
  for (const [k, kind] of Object.entries(DELEGATE_ARG_TYPES)) {
    const v = args[k]
    if (v === undefined) {
      continue
    }
    if (typeof v !== kind || v === '' || (kind === 'number' && !Number.isFinite(v))) {
      throw new PlaneVerbError('agents', DELEGATE, `${k} must be a non-empty ${kind}`)
    }
    req[k] = v
  }
  if (req['mode'] !== undefined && req['mode'] !== 'wait' && req['mode'] !== 'detach') {
    throw new PlaneVerbError('agents', DELEGATE, `mode must be 'wait' or 'detach'`)
  }
  if (args['delegatedBy'] !== undefined) {
    throw new PlaneVerbError(
      'agents',
      DELEGATE,
      'delegatedBy is stamped from the caller identity (BRO_AGENT_ID) — it is not a request arg'
    )
  }
  return req as unknown as DelegateRequest
}

/** delegate()'s error vocabulary → the plane's: caller input is a
 *  client bug (PlaneVerbError → REST 400), a refusal or unreachable
 *  backend — including an ACP peer that never answered — is
 *  PlaneUnavailable (→ 503). Never a bare 500. */
function execOrPlaneError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  if (err instanceof SpawnInputError || (err instanceof SpawnError && err.kind === 'input')) {
    throw new PlaneVerbError('agents', DELEGATE, msg)
  }
  if (err instanceof SpawnError || err instanceof JudgeUnavailable) {
    throw new PlaneUnavailable('agents', msg)
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
          beadsDir: { type: 'string', description: 'shared store override' },
        },
        anyOf: [{ required: ['prompt'] }, { required: ['promptFile'] }],
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
        const req = delegateArgs(args)
        // the exec boundary reads files with the server's privileges —
        // a promptFile must resolve inside the project dir or it is an
        // exfil channel, not a prompt
        if (req.promptFile !== undefined) {
          const resolved = resolve(dir, req.promptFile)
          const root = resolve(dir)
          if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
            throw new PlaneVerbError('agents', DELEGATE, 'promptFile must resolve inside the project directory')
          }
          req.promptFile = resolved
        }
        return await delegate(dir, env(), req)
      } catch (err) {
        execOrPlaneError(err)
      }
    },
  }
}
