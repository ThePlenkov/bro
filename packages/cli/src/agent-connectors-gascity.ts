/**
 * The gascity backend for the agents facade — `gc` as code.
 *
 * Spec: specs/sessions/bro-f4ot/spec.md + spike-gascity.md (bro-4bkv
 * verdict: viable). Model mismatch (configured agents + routed work, not
 * ephemeral per-step processes) is absorbed here, not in the facade:
 * one worker template per city, per-step identity = session alias +
 * agents.json entry.
 *
 * Contract mapping (spike):
 *  - spawn   = `gc session new <template> --no-attach --json` +
 *              `gc sling <session> <molStep>` (+ `session submit` for the
 *              rendered prompt); respawn = registry-id reuse + `session
 *              reset`/re-sling;
 *  - list    = `gc session list --json --state all`; supervisor
 *              unreachable ⇒ degraded, never `lost` (a failed read must
 *              not look like a dead fleet);
 *  - status  = session state map: active→running, suspended→stopped,
 *              closed→exited, absent→lost (only when the supervisor is
 *              verifiably reachable);
 *  - stop    = `gc session close` (terminal op — `kill` races the
 *              reconciler); not-found ⇒ no-op;
 *  - claims  = the shared beads store, exactly like native: the rig is
 *              the repo adopted via `gc rig add --adopt`, so the rig's
 *              beads DB *is* the repo store. `sling --force` is never
 *              used — a dispatch with no shared-store claim would double
 *              workers.
 *
 * Knobs: `agents.gascity.configDir` (default `<git-common-dir>/bro/
 * gascity`), `agents.gascity.template` (default `bro-worker`),
 * `agents.gascity.command` (provider command; falls back to loop.agent).
 * Supervisor lifecycle: `gc start`/`gc stop <city>` — city-scoped; the
 * machine-wide supervisor is never stopped from here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AgentNotFound,
  bdActor,
  claimStep,
  gitTry,
  mintAgentId,
  patchAgentRegistry,
  probeStep,
  readAgentRegistry,
  rebindStep,
  SpawnError,
  withAgentRegistryLock,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type ListResult,
  type SpawnSpec,
} from '@broject/core'
import type { AgentConnectorEnv } from './agent-connectors.ts'

/** gc subprocess — PATH lookup is the same contract as git/gh/bd. */
function gc(args: string[], timeoutMs = 30_000): { code: number; out: string; err: string } {
  const proc = spawnSync('gc', args, { // NOSONAR — PATH lookup is the contract (same as gh/git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
  }
}

/** `gc session list` row — only the fields this connector reads; the
 *  schema carries more (see `gc session list --json-schema result`). */
interface GcSession {
  id: string
  alias?: string
  state: string
  closed?: boolean
  work_dir?: string
}

/** session list → (sessions, err). A parse failure IS a failed read. */
function listSessions(configDir: string): { sessions?: GcSession[]; err?: string } {
  const r = gc(['session', 'list', '--json', '--state', 'all', '--city', configDir])
  if (r.code !== 0) {
    return { err: r.err !== '' ? r.err : `gc session list exited ${r.code}` }
  }
  try {
    const v = JSON.parse(r.out) as { sessions?: GcSession[] }
    return { sessions: Array.isArray(v.sessions) ? v.sessions : [] }
  } catch {
    return { err: 'gc session list returned unparseable JSON' }
  }
}

/** The session owned by a registry entry — the stored sessionId first,
 *  the molStep alias as the pre-patch fallback. */
function sessionFor(entry: AgentRegistryEntry, molStep: string, sessions: GcSession[]): GcSession | undefined {
  const sid = typeof entry.sessionId === 'string' ? entry.sessionId : undefined
  return sessions.find((s) => s.id === sid) ?? sessions.find((s) => s.alias === molStep)
}

/** gc session state → AgentState. `closed` rows map regardless of the
 *  state string; unstarted-but-durable sessions are 'spawned'. */
function mapState(s: GcSession): AgentState {
  if (s.closed === true || s.state === 'closed') {
    return 'exited'
  }
  switch (s.state) {
    case 'active':
      return 'running'
    case 'suspended':
      return 'stopped'
    default:
      return 'spawned'
  }
}

/** Supervisor reachability — the liveness oracle. Absent/down is NOT a
 *  dead fleet: callers degrade rather than report `lost` on it. */
function supervisorRunning(): boolean | undefined {
  const r = gc(['supervisor', 'status', '--json'])
  if (r.code !== 0) {
    return undefined
  }
  try {
    return (JSON.parse(r.out) as { running?: boolean }).running === true
  } catch {
    return undefined
  }
}

/** Directory that owns the shared store — the rig root. `beadsDir` is
 *  the resolved `.beads`, so its parent is the project gc must adopt. */
function rigDirOf(spec: SpawnSpec): string {
  return dirname(spec.beadsDir)
}

const CITY_TOML = (provider: string, command: string): string =>
  `# authored by bro's gascity connector (bro-cduq) — regenerate by deleting
[workspace]
provider = "${provider}"

[providers.${provider}]
command = "${command.replaceAll('"', '\\"')}"
prompt_mode = "none"
`

const AGENT_TOML = `scope = "city"
wake_mode = "resume"
`

const PROMPT_TEMPLATE = `You are a bro-managed worker in a Gas City session.

Work arrives as a bead routed to this session — its description is the
work order — plus a submitted message carrying the rendered prompt. Follow
it exactly: work in this session's work_dir, verify like CI, push, open
the PR. The beads store is the shared store (this rig is adopted) —
verdicts go through \`bd update\`/\`bd close\` on the routed bead.
`

/** Provider label for city.toml — the command's first token, sanitized;
 *  'agent' when nothing resolves. */
function providerName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? ''
  return /^[a-zA-Z][\w-]*$/.test(base) ? base : 'agent'
}

export function makeGascityConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['gascity'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''
  const template =
    typeof knobs.template === 'string' && knobs.template.trim() !== ''
      ? knobs.template.trim()
      : 'bro-worker'

  /** City root — explicit `agents.gascity.configDir`, else the shared
   *  `<git-common-dir>/bro/gascity` (out of every worktree). */
  const configDir = (): string | null => {
    const k = knobs.configDir
    if (typeof k === 'string' && k.trim() !== '') {
      return isAbsolute(k) ? k : resolve(dir, k)
    }
    const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = r.code === 0 ? r.out.trim() : ''
    return common === '' ? null : join(common, 'bro', 'gascity')
  }

  const findEntry = (id: string): [string, AgentRegistryEntry] | undefined => {
    for (const [molStep, e] of Object.entries(readAgentRegistry(dir))) {
      if (e.backend === 'gascity' && e.agentId === id) {
        return [molStep, e]
      }
    }
    return undefined
  }

  const toInfo = (
    molStep: string,
    entry: AgentRegistryEntry,
    sessions: GcSession[] | undefined,
    missing: AgentState
  ): AgentInfo => {
    const s = sessions === undefined ? undefined : sessionFor(entry, molStep, sessions)
    return {
      id: entry.agentId,
      molStep,
      backend: entry.backend,
      state: sessions === undefined ? missing : s === undefined ? missing : mapState(s),
      worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
      log: typeof entry.log === 'string' ? entry.log : undefined,
    }
  }

  /** City bootstrap — author city.toml + the worker template once, then
   *  `gc init --file … --no-start`; adopt the repo as a rig (the rig's
   *  beads DB IS the shared store); ensure the machine-wide supervisor
   *  via city-scoped `gc start` (never `gc supervisor start/stop` —
   *  other cities ride the same supervisor). */
  const ensureCity = (spec: SpawnSpec, city: string): void => {
    mkdirSync(city, { recursive: true })
    const toml = join(city, 'city.toml')
    if (!existsSync(toml)) {
      writeFileSync(toml, CITY_TOML(providerName(command), command))
      const agentDir = join(city, 'agents', template)
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(join(agentDir, 'prompt.template.md'), PROMPT_TEMPLATE)
      writeFileSync(join(agentDir, 'agent.toml'), AGENT_TOML)
      const init = gc(
        ['init', '--file', toml, '--preserve-existing', '--no-start', '--skip-provider-readiness', '--yes', city],
        120_000
      )
      if (init.code !== 0) {
        throw new SpawnError(`gc init failed — ${init.err !== '' ? init.err : `exited ${init.code}`}`)
      }
    }
    const rigDir = rigDirOf(spec)
    const rigs = gc(['rig', 'list', '--json', '--city', city])
    const registered =
      rigs.code === 0 &&
      (() => {
        try {
          const v = JSON.parse(rigs.out) as { rigs?: { path?: string }[] }
          return (v.rigs ?? []).some((r) => r.path === rigDir)
        } catch {
          return false
        }
      })()
    if (!registered) {
      const add = gc(['rig', 'add', rigDir, '--adopt', '--city', city], 60_000)
      if (add.code !== 0) {
        throw new SpawnError(`gc rig add ${rigDir} failed — ${add.err !== '' ? add.err : `exited ${add.code}`}`)
      }
    }
    if (supervisorRunning() !== true) {
      const start = gc(['start', city], 120_000)
      if (start.code !== 0) {
        throw new SpawnError(`gc start failed — ${start.err !== '' ? start.err : `exited ${start.code}`}`)
      }
    }
  }

  return {
    name: 'gascity',

    // gascity claims a configDir layout — an authored city.toml at the
    // resolved configDir is the marker (spec: agents.gascity.configDir).
    matchDir: () => {
      const city = configDir()
      return city !== null && existsSync(join(city, 'city.toml'))
    },

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      if (command === '') {
        throw new SpawnError(
          'no agent command configured — set agents.gascity.command or loop.agent in bro.config.json'
        )
      }
      const city = configDir()
      if (city === null) {
        throw new SpawnError(`no git common dir for ${spec.repoRoot}`)
      }
      // same TOCTOU critical section as native: dedup → claim → backend
      // spawn → registry patch, all under the agents.json lock.
      return withAgentRegistryLock(dir, () => {
        const registry = readAgentRegistry(dir)
        const existing = registry[spec.molStep]
        if (existing?.backend === 'gascity') {
          const { sessions, err } = listSessions(city)
          if (sessions === undefined) {
            // unreadable backend → refuse, don't risk a double worker
            throw new SpawnError(`gascity unreachable — cannot verify existing agent: ${err}`)
          }
          const s = sessionFor(existing, spec.molStep, sessions)
          if (s !== undefined && (mapState(s) === 'running' || mapState(s) === 'spawned')) {
            throw new SpawnError(
              `${spec.molStep} already has a live agent (${existing.agentId}, session ${s.id})`
            )
          }
        }
        const step = probeStep(spec.beadsDir, spec.molStep)
        const claimed = step?.status === 'in_progress'
        if (claimed && existing === undefined) {
          throw new SpawnError(
            `${spec.molStep} is claimed outside the agent registry (assignee ${step?.assignee ?? '?'})`
          )
        }
        const actor = claimed ? bdActor(spec.beadsDir) : undefined
        if (claimed && step?.assignee !== actor) {
          throw new SpawnError(
            `${spec.molStep} is claimed by ${step?.assignee ?? '?'} — rebind only takes our own claim`
          )
        }
        // registry entry FIRST — a later failure leaves a respawn-able
        // 'lost' entry, same rationale as the native connector.
        const agentId = existing?.agentId ?? mintAgentId('gascity')
        patchAgentRegistry(dir, spec.molStep, {
          agentId,
          backend: 'gascity',
          spawnedAt: new Date().toISOString(),
          worktree: spec.repoRoot,
          stopped: false,
          sessionId: undefined,
          spawnError: undefined,
        })
        if (claimed) {
          rebindStep(spec.beadsDir, spec.molStep, actor!)
        } else {
          claimStep(spec.beadsDir, spec.molStep)
        }
        let sessionId: string | undefined
        try {
          ensureCity(spec, city)
          // respawn: the old session survives in gc's durable list —
          // `session reset` restarts it in place (preserves alias+bead)
          // instead of colliding on a fresh --alias.
          const prior = typeof existing?.sessionId === 'string' ? existing.sessionId : undefined
          const { sessions } = listSessions(city)
          const alive = sessions?.find(
            (s) => s.id === prior || (prior === undefined && s.alias === spec.molStep)
          )
          if (alive !== undefined) {
            const reset = gc(['session', 'reset', alive.id, '--city', city])
            if (reset.code !== 0) {
              throw new Error(`gc session reset ${alive.id} — ${reset.err !== '' ? reset.err : `exited ${reset.code}`}`)
            }
            sessionId = alive.id
          } else {
            const created = gc(
              ['session', 'new', template, '--alias', spec.molStep, '--no-attach', '--json', '--city', city],
              120_000
            )
            if (created.code !== 0) {
              throw new Error(
                `gc session new ${template} — ${created.err !== '' ? created.err : `exited ${created.code}`}`
              )
            }
            sessionId = (JSON.parse(created.out) as { session_id?: string }).session_id
            if (sessionId === undefined) {
              throw new Error('gc session new returned no session_id')
            }
          }
          // dispatch order: sling the bead (the routed work order), then
          // submit the rendered prompt. Never --force — a bead that
          // doesn't resolve in the rig store would be a claimless
          // dispatch.
          const sling = gc(['sling', spec.molStep, spec.molStep, '--city', city])
          if (sling.code !== 0) {
            throw new Error(`gc sling ${spec.molStep} — ${sling.err !== '' ? sling.err : `exited ${sling.code}`}`)
          }
          const submit = gc(['session', 'submit', spec.molStep, spec.prompt, '--city', city])
          if (submit.code !== 0) {
            throw new Error(
              `gc session submit ${spec.molStep} — ${submit.err !== '' ? submit.err : `exited ${submit.code}`}`
            )
          }
        } catch (err) {
          // leave the entry respawn-able: close the orphan session so a
          // retry can't run alongside a zombie, then record the failure.
          if (sessionId !== undefined) {
            gc(['session', 'close', sessionId, '--city', city])
          }
          patchAgentRegistry(dir, spec.molStep, {
            sessionId,
            spawnError: err instanceof Error ? err.message : String(err),
          })
          throw err instanceof SpawnError ? err : new SpawnError(err instanceof Error ? err.message : String(err))
        }
        const spawned = patchAgentRegistry(dir, spec.molStep, { sessionId })
        const { sessions } = listSessions(city)
        return toInfo(spec.molStep, spawned, sessions ?? [], 'spawned')
      })
    },

    async list(): Promise<ListResult> {
      try {
        const city = configDir()
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'gascity'
        )
        if (entries.length === 0) {
          return { agents: [] }
        }
        if (city === null || !existsSync(join(city, 'city.toml'))) {
          // never initialized — every gascity entry is unverifiable
          return { agents: [], degraded: 'gascity city not initialized' }
        }
        const { sessions, err } = listSessions(city)
        if (sessions === undefined) {
          return { agents: [], degraded: err }
        }
        // absent sessions are 'lost' only when the supervisor can verify;
        // unreachable → degrade and omit them: an unlisted agent renders
        // 'unknown' in fleet, a 'lost' one would look like a dead fleet.
        const reachable = supervisorRunning()
        if (reachable === undefined) {
          return {
            agents: entries
              .filter(([molStep, e]) => sessionFor(e, molStep, sessions) !== undefined)
              .map(([molStep, e]) => toInfo(molStep, e, sessions, 'lost')),
            degraded: 'gc supervisor unreachable — agent liveness unknown',
          }
        }
        return { agents: entries.map(([molStep, e]) => toInfo(molStep, e, sessions, 'lost')) }
      } catch (err) {
        return { agents: [], degraded: err instanceof Error ? err.message : String(err) }
      }
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no gascity agent ${id}`)
      }
      const [molStep, entry] = hit
      const city = configDir()
      if (city === null) {
        throw new Error('no git common dir — cannot reach gascity')
      }
      const { sessions, err } = listSessions(city)
      if (sessions === undefined) {
        throw new Error(`gascity unreachable — ${err}`)
      }
      if (sessionFor(entry, molStep, sessions) === undefined && supervisorRunning() === undefined) {
        throw new Error('gc supervisor unreachable — agent liveness unknown')
      }
      return toInfo(molStep, entry, sessions, 'lost')
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const city = configDir()
      if (city !== null) {
        // `close` is the terminal op — `kill` races the reconciler's
        // restart. Best-effort: a gone session is the desired end state.
        const target = typeof entry.sessionId === 'string' ? entry.sessionId : molStep
        gc(['session', 'close', target, '--city', city])
      }
      try {
        patchAgentRegistry(dir, molStep, { stopped: true })
      } catch {
        // stop intent is recorded best-effort, same as native
      }
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'required' }),
  }
}
