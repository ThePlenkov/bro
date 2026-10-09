/** agents plane — the worker registry behind `bro agents status` and
 *  the fleet table `bro fleet` renders. Rows are Worker; `backend` is
 *  a provenance value, never a field name (specs/bro-9rls.1.md). */
import {
  PlaneUnavailable,
  verbsNotWired,
  type AgentInfo,
  type PlaneCtx,
  type PlaneDescriptor,
  type Worker,
} from '@broject/core'
import { loadAgentEnv } from '../agent-connectors.ts'
import { collectAgentBackends, findInBackends } from '../commands/agents.ts'
import { collectFleet } from '../commands/fleet.ts'
import { bounded, dispatchRead } from './helpers.ts'

const VERBS = ['spawn', 'stop', 'respawn']

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
    readArgs: {
      list: { type: 'object', properties: {} },
      backends: { type: 'object', properties: {} },
      fleet: { type: 'object', properties: {} },
    },
    /** spawn-able means ≥1 backend answers list() non-degraded — the
     *  same signal occupancy/fleet reads report. A fully degraded
     *  registry hides the tools instead of serving all-error rows. */
    capabilities: async () => {
      const ok = await bounded(
        collectAgentBackends(dir, env())
          .then(({ backends }) => backends.some((b) => b.degraded === undefined))
          .catch(() => false),
        10_000,
        false
      )
      return { read: ok, spawn: false, stop: false, respawn: false }
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
    exec: verbsNotWired('agents', VERBS),
  }
}
