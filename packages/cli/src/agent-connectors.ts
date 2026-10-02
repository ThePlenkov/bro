/**
 * Agent connector registry + the native backend.
 *
 * Spec: specs/sessions/bro-f4ot/spec.md. Resolution mirrors the facade
 * seam — explicit --connector → `connectors.agents` in bro.config.json →
 * matchRemote/matchDir → registry order (`native` is the designed
 * default; it registers first).
 *
 * The native backend is detached `sh -c` spawn: nohup-equivalent (own
 * process group, parent-unref'd, output to a log file), liveness via
 * kill(pid, 0) — the pgrep+kill -0 folklore as code — plus a `.work`
 * marker in the hooks state dir so parallel-session detection sees the
 * agent, and molStep claims pinned into the shared beads store.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AgentNotFound,
  agentsSection,
  bdActor,
  claimStep,
  gitTry,
  loadConfig,
  mintAgentId,
  patchAgentRegistry,
  probeStep,
  rebindStep,
  SpawnError,
  readAgentRegistry,
  withAgentRegistryLock,
  type AgentConnector,
  type AgentInfo,
  type AgentRegistryEntry,
  type AgentState,
  type ConnectorCtx,
  type SpawnSpec,
} from '@broject/core'
import { expandAgentCmd, loopSection, type LoopConfig } from '@broject/loop'

/** Everything a factory needs: the repo ctx + the resolved config
 *  (agents.<backend> knobs, connectors.agents pick, loop.agent fallback). */
export interface AgentConnectorEnv {
  agents: Record<string, Record<string, unknown>>
  /** Facade → connector precedence — `connectors.agents` selects here. */
  connectors: Record<string, string>
  loop?: LoopConfig
}

export type AgentConnectorFactory = (
  ctx: ConnectorCtx,
  env: AgentConnectorEnv
) => AgentConnector

// --- registry ------------------------------------------------------------------

const agentRegistry: { name: string; make: AgentConnectorFactory }[] = []

/** External backends (gascity, tmux, …) register here. Duplicate names
 *  are skipped — a plugin cannot shadow a built-in backend. */
export function registerAgentConnector(name: string, make: AgentConnectorFactory): void {
  if (agentRegistry.some((x) => x.name === name)) {
    console.error(`warning: agent connector "${name}" already registered — skipped`)
    return
  }
  agentRegistry.push({ name, make })
}

export function agentConnectorNames(): string[] {
  return agentRegistry.map((x) => x.name)
}

/** Config sections the agents facade reads — the caller may already have
 *  a resolved config; this is the load path when it doesn't. */
export function loadAgentEnv(dir: string): AgentConnectorEnv {
  const cfg = loadConfig(dir, {
    agents: agentsSection,
    loop: loopSection,
  }) as {
    agents?: Record<string, Record<string, unknown>>
    connectors?: Record<string, string>
    loop?: LoopConfig
  }
  return { agents: cfg.agents ?? {}, connectors: cfg.connectors ?? {}, loop: cfg.loop }
}

/** Pick the serving backend: explicit --connector → connectors.agents →
 *  matchRemote/matchDir → registry order. Provisional factories are
 *  cheap — a connector that must not be picked stays unconstructed
 *  until chosen. */
export function resolveAgentConnector(
  ctx: ConnectorCtx,
  opts: { connector?: string } = {},
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir)
): AgentConnector {
  const prefer = opts.connector ?? env.connectors['agents']
  if (prefer !== undefined) {
    const hit = agentRegistry.find((x) => x.name === prefer)
    if (!hit) {
      throw new Error(
        `agent connector "${prefer}" is not registered (known: ${agentConnectorNames().join(', ') || 'none'})`
      )
    }
    return hit.make(ctx, env)
  }
  const url = gitTry(['-C', ctx.dir, 'remote', 'get-url', 'origin'])
  const remote = url.code === 0 ? url.out.trim() : ''
  // matchers run on a probe instance — construction must be side-effect free
  if (remote !== '') {
    for (const c of agentRegistry) {
      const probe = c.make(ctx, env)
      if (probe.matchRemote?.(remote)) {
        return probe
      }
    }
  }
  for (const c of agentRegistry) {
    const probe = c.make(ctx, env)
    if (probe.matchDir?.(ctx.dir)) {
      return probe
    }
  }
  const first = agentRegistry[0]
  if (!first) {
    throw new Error('no agent connector registered')
  }
  return first.make(ctx, env)
}

/** Every registered backend, constructed — fleet reads across ALL of
 *  them (the view works regardless of which backend a fleet runs on);
 *  each connector's list() carries its own degraded flag. A throwing
 *  factory is degrade-equivalent: with `onFactoryError` it contributes a
 *  note and the other backends still construct — without it, the throw
 *  propagates as before. */
export function eachAgentConnector(
  ctx: ConnectorCtx,
  env: AgentConnectorEnv = loadAgentEnv(ctx.dir),
  onFactoryError?: (name: string, error: unknown) => void
): AgentConnector[] {
  const connectors: AgentConnector[] = []
  for (const x of agentRegistry) {
    try {
      connectors.push(x.make(ctx, env))
    } catch (error) {
      if (onFactoryError === undefined) {
        throw error
      }
      onFactoryError(x.name, error)
    }
  }
  return connectors
}

// --- native --------------------------------------------------------------------

/** `<git-common-dir>/bro/agents/` — per-agent artifacts (prompt, log,
 *  exit status) live in the shared dir, not the worktree: a prompt file
 *  in the tree would be a dirty file the agent might commit. */
function agentsHome(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'agents')
}

/** agentIds become filenames under shared dirs — a tampered registry
 *  entry's `../x` must not escape them. Minted ids are `<backend>-<hex>`;
 *  the pattern starts alnum so `.`/`..` segments can never form. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `<common>/bro/agents/<agentId>.prompt.md` — the spawn-time rendered
 *  instructions. Respawn of a custom-prompt agent (a fixer round's
 *  thread context, say) reuses it — the agentId survives process death,
 *  so the file does too. Null for an unsafe or unanchorable id. */
export function agentPromptPath(dir: string, agentId: string): string | null {
  const home = agentsHome(dir)
  return home === null || !SAFE_AGENT_ID.test(agentId)
    ? null
    : join(home, `${agentId}.prompt.md`)
}

/** `<common>/bro/hooks/agent-<id>.work` — hooks markers are
 *  `<common>/bro/hooks/<session>.<aspect>`; the agent gets a synthetic
 *  session name so `otherLiveWork` (session-start parallel detection)
 *  reports it as live work on the molStep. Null outside a common dir. */
function workMarkerPath(dir: string, agentId: string): string | null {
  if (!SAFE_AGENT_ID.test(agentId)) {
    return null
  }
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = r.code === 0 ? r.out.trim() : ''
  return common === '' ? null : join(common, 'bro', 'hooks', `agent-${agentId}.work`)
}

function writeWorkMarker(dir: string, agentId: string, molStep: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker === null) {
      return
    }
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, `${Date.now()}\n${molStep}\n`)
  } catch {
    // marker is advisory — never break a spawn over detection cosmetics
  }
}

function dropWorkMarker(dir: string, agentId: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker !== null) {
      rmSync(marker, { force: true })
    }
  } catch {
    // best-effort
  }
}

/** Marker mtime IS the liveness signal detection reads — refresh it
 *  while the agent is verifiably alive or a long-running worker goes
 *  stale (and a dead one's leftover marker stops looking live). */
function touchWorkMarker(dir: string, agentId: string): void {
  try {
    const marker = workMarkerPath(dir, agentId)
    if (marker !== null && existsSync(marker)) {
      const now = new Date()
      utimesSync(marker, now, now)
    }
  } catch {
    // best-effort
  }
}

/** pid alive = kill(pid, 0) doesn't throw. EPERM means the process
 *  exists but isn't ours — still alive. pid <= 0 is never a live agent
 *  (kill(0) would signal OUR OWN process group — not a probe). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The shared spawn prologue every built-in backend runs under the
 *  registry lock — dedup across the two state planes (registry liveness
 *  + beads claim), the claim/rebind, and the shared-dir artifacts
 *  (prompt/log/exit). Returns the paths the backend tail needs.
 *
 *  Dedup correlates both planes: a claim alone is not a conflict — a
 *  crashed worker's stale in_progress must not block respawn — and a
 *  live agent alone is not spawnable-over either. The registry entry
 *  goes in FIRST: every later failure (claim refused, spawn error)
 *  leaves a respawn-able 'lost' entry instead of a foreign claim that
 *  can never be rebound. `opts.isLive` is the backend's liveness probe
 *  on an existing entry; `opts.entry` merges backend-private fields
 *  (tmux's session name) into the patch. */
function prepareSpawn(
  dir: string,
  home: string,
  backend: string,
  spec: SpawnSpec,
  opts: {
    isLive: (existing: AgentRegistryEntry) => boolean
    liveDetail?: (existing: AgentRegistryEntry) => string
    entry?: (agentId: string) => Record<string, unknown>
  }
): { agentId: string; promptFile: string; log: string; exitFile: string } {
  const registry = readAgentRegistry(dir)
  const existing = registry[spec.molStep]
  // a registry entry belongs to the backend that wrote it — the respawn
  // contract (same agentId, same claim rebind) is per-runtime; one
  // backend must not adopt another's entry
  if (existing !== undefined && existing.backend !== backend) {
    throw new SpawnError(
      `${spec.molStep} is registered to backend "${existing.backend}" — respawn belongs to it`
    )
  }
  if (existing !== undefined && opts.isLive(existing)) {
    const detail = opts.liveDetail?.(existing) ?? `pid ${String(existing.pid)}`
    throw new SpawnError(
      `${spec.molStep} already has a live agent (${existing.agentId}, ${detail})`
    )
  }
  const step = probeStep(spec.beadsDir, spec.molStep)
  const claimed = step?.status === 'in_progress'
  if (claimed && existing === undefined) {
    // claimed with no registry entry — an interactive session or a
    // foreign backend owns it; spawning would double-claim
    throw new SpawnError(
      `${spec.molStep} is claimed outside the agent registry (assignee ${step?.assignee ?? '?'})`
    )
  }
  // a dead entry doesn't entitle us to whatever claim sits on the step
  // now — if another actor picked it up meanwhile, rebinding would steal
  // a live worker's (or a human's) step. The actor resolves in the
  // pinned store's context — the same context the claim was written under.
  const actor = claimed ? bdActor(spec.beadsDir) : undefined
  if (claimed && step?.assignee !== actor) {
    throw new SpawnError(
      `${spec.molStep} is claimed by ${step?.assignee ?? '?'} — rebind only takes our own claim`
    )
  }
  // a reused id must stay filename-safe — a tampered entry gets a fresh
  // mint, not a path escape into <home>/
  const agentId =
    existing !== undefined && SAFE_AGENT_ID.test(existing.agentId)
      ? existing.agentId
      : mintAgentId(backend)
  mkdirSync(home, { recursive: true })
  const promptFile = join(home, `${agentId}.prompt.md`)
  const log = join(home, `${agentId}.log`)
  const exitFile = join(home, `${agentId}.exit`)
  rmSync(exitFile, { force: true })
  writeFileSync(promptFile, spec.prompt)
  // exitStatus: undefined clears a respawned entry's stale harvest — the
  // new run must not read as already-exited (undefined keys drop out of
  // the serialized registry). pid/spawnError likewise — a claim failure
  // before the backend patches its handle would leave a stale value that
  // could alias an unrelated process/session later
  patchAgentRegistry(dir, spec.molStep, {
    agentId,
    backend,
    spawnedAt: new Date().toISOString(),
    worktree: spec.repoRoot,
    log,
    stopped: false,
    exitStatus: undefined,
    pid: undefined,
    spawnError: undefined,
    ...opts.entry?.(agentId),
  })
  if (claimed) {
    rebindStep(spec.beadsDir, spec.molStep, actor!)
  } else {
    claimStep(spec.beadsDir, spec.molStep)
  }
  return { agentId, promptFile, log, exitFile }
}

/** Exit status the wrapper dropped at `<agentId>.exit` — absent when the
 *  process is still running or died by SIGKILL (nothing to write with). */
function readExitFile(home: string, agentId: string): number | undefined {
  try {
    const v = readFileSync(join(home, `${agentId}.exit`), 'utf8').trim()
    const n = Number(v)
    return Number.isInteger(n) ? n : undefined
  } catch {
    return undefined
  }
}

/** The recorded-death ladder both backends walk once liveness fails —
 *  stopped flag → harvested exitStatus → the .exit file (lazily
 *  harvested into the registry so `agents.json` keeps pid+exit-status
 *  alongside the handle, and the harvest is once). Terminal states
 *  also retire the .work marker: a dead agent must not keep reporting
 *  as live work to parallel-session detection. Returns undefined when
 *  nothing recorded a death — the caller decides what unproven means
 *  ('lost' for a confirmed-dead backend, 'spawned' for a failed probe). */
function recordedDeath(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry
): AgentState | undefined {
  if (entry.stopped === true) {
    dropWorkMarker(dir, entry.agentId)
    return 'stopped'
  }
  if (entry.exitStatus !== undefined) {
    dropWorkMarker(dir, entry.agentId)
    return 'exited'
  }
  if (home) {
    const code = readExitFile(home, entry.agentId)
    if (code !== undefined) {
      try {
        patchAgentRegistry(dir, molStep, { exitStatus: code })
      } catch {
        // harvest is advisory — the .exit file still proves the exit
      }
      dropWorkMarker(dir, entry.agentId)
      return 'exited'
    }
  }
  return undefined
}

/** Registry scan by agentId within one backend — status()/stop()
 *  resolve through it. */
function findAgentEntry(
  dir: string,
  backend: string,
  id: string
): [string, AgentRegistryEntry] | undefined {
  for (const [molStep, e] of Object.entries(readAgentRegistry(dir))) {
    if (e.backend === backend && e.agentId === id) {
      return [molStep, e]
    }
  }
  return undefined
}

/** Spawn guards shared by the built-in backends — they refuse before a
 *  claim or registry write lands: an unconfigured agent command, a
 *  nonexistent worktree, or an unanchorable agents home. Returns the
 *  shared artifacts dir on success. */
function spawnHome(dir: string, backend: string, command: string, spec: SpawnSpec): string {
  if (command === '') {
    throw new SpawnError(
      `no agent command configured — set agents.${backend}.command or loop.agent in bro.config.json`
    )
  }
  if (!existsSync(spec.repoRoot)) {
    throw new SpawnError(`worktree ${spec.repoRoot} does not exist`)
  }
  const home = agentsHome(dir)
  if (!home) {
    throw new SpawnError(`no git common dir for ${spec.repoRoot}`)
  }
  return home
}

/** Live state for a registry entry under this backend. */
function nativeState(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentState {
  // liveness first: a 'stopped' marker on a pid that is still alive means
  // SIGTERM hasn't landed yet — the agent IS still running, and dedup
  // must keep refusing a respawn that would run alongside it
  const pid = typeof entry.pid === 'number' ? entry.pid : undefined
  if (pid !== undefined && pidAlive(pid)) {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  const dead = recordedDeath(dir, home, molStep, entry)
  if (dead !== undefined) {
    return dead
  }
  dropWorkMarker(dir, entry.agentId)
  return 'lost'
}

function toInfo(dir: string, home: string | null, molStep: string, entry: AgentRegistryEntry): AgentInfo {
  return {
    id: entry.agentId,
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: nativeState(dir, home, molStep, entry),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  }
}

/** The native backend — detached process, self-sufficient
 *  (supervisor:'none'). Agent command template resolves as
 *  agents.native.command → loop.agent; `{promptFile}` expands like the
 *  loop's agent template. */
export function makeNativeConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['native'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''

  const findEntry = (id: string) => findAgentEntry(dir, 'native', id)

  return {
    name: 'native',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> {
      const home = spawnHome(dir, 'native', command, spec)
      // dedup → claim → spawn → pid-patch runs as ONE critical section:
      // without the lock a second bro process can pass the liveness
      // check between our read and our write and double-spawn (TOCTOU).
      // Everything inside is synchronous — the bd subprocesses are
      // spawnSync — so the hold is milliseconds in the common case.
      return withAgentRegistryLock(dir, () => {
        const { agentId, promptFile, log, exitFile } = prepareSpawn(dir, home, 'native', spec, {
          isLive: (e) => nativeState(dir, home, spec.molStep, e) === 'running',
        })
        const fd = openSync(log, 'a')
        let spawned: AgentRegistryEntry
        try {
          // the wrapper captures $? into the .exit file — the only exit
          // record a detached process can leave once the parent is gone
          const child = spawn(
            'sh', // NOSONAR — PATH lookup is the contract (same as git/bd everywhere)
            ['-c', `${expandAgentCmd(command, promptFile)}; s=$?; printf %s "$s" > "$1"`, 'bro-agent', exitFile],
            { // NOSONAR — operator-configured agent command (same contract as loop)
              cwd: spec.repoRoot,
              env: {
                ...process.env,
                ...spec.env,
                // identity pins last — spec.env must never redirect the
                // claim store or re-badge the worker as another bead/agent
                BEADS_DIR: spec.beadsDir,
                BRO_BEAD_ID: spec.molStep,
                BRO_AGENT_ID: agentId,
                BRO_PROMPT_FILE: promptFile,
              },
              stdio: ['ignore', fd, fd],
              detached: true,
            }
          )
          // an unhandled 'error' event would take the whole CLI down —
          // a failed exec records itself on the entry and reads 'lost'
          child.on('error', (err) => {
            try {
              patchAgentRegistry(dir, spec.molStep, { spawnError: err.message })
            } catch {
              // the entry may not have landed yet — nothing else to do
            }
          })
          child.unref()
          spawned = patchAgentRegistry(dir, spec.molStep, { pid: child.pid ?? -1 })
          writeWorkMarker(dir, agentId, spec.molStep)
        } finally {
          closeSync(fd)
        }
        return toInfo(dir, home, spec.molStep, spawned)
      })
    },

    async list() {
      try {
        const home = agentsHome(dir)
        const agents = Object.entries(readAgentRegistry(dir))
          .filter(([, e]) => e.backend === 'native')
          .map(([molStep, e]) => toInfo(dir, home, molStep, e))
        return { agents }
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async status(id: string): Promise<AgentInfo> {
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no native agent ${id}`)
      }
      return toInfo(dir, agentsHome(dir), hit[0], hit[1])
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const pid = typeof entry.pid === 'number' ? entry.pid : undefined
      if (pid !== undefined && pidAlive(pid)) {
        try {
          process.kill(-pid, 'SIGTERM') // detached → own process group
        } catch {
          // No fallback to kill(pid): a native child is always its own
          // group leader, so a failed group signal means the pid was
          // recycled by a non-leader — signaling it would hit an
          // unrelated process.
        }
        // let the signal land before recording the stop — `stopped` on a
        // still-living pid would let a respawn run alongside the dying
        // agent (nativeState reports live pids as running regardless)
        const deadline = Date.now() + 2_000
        while (pidAlive(pid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      withAgentRegistryLock(dir, () => {
        const cur = readAgentRegistry(dir)[molStep]
        if (
          cur === undefined ||
          cur.agentId !== entry.agentId ||
          cur.spawnedAt !== entry.spawnedAt ||
          (pid !== undefined && pidAlive(pid))
        ) {
          return // respawned or still alive — the live run owns the entry
        }
        try {
          patchAgentRegistry(dir, molStep, { stopped: true })
        } catch {
          // the marker removal below still records intent
        }
        dropWorkMarker(dir, id)
      })
    },

    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' }),
  }
}

registerAgentConnector('native', makeNativeConnector)

// --- tmux ----------------------------------------------------------------------

/** tmux runs the pane command through sh — single-quote a path the same
 *  way expandAgentCmd quotes {promptFile}. */
const SH_SQUOTE = String.raw`'\''` // ' → '\'' : close, escaped quote, reopen
const shQuote = (s: string): string => `'${s.replaceAll("'", SH_SQUOTE)}'`

/** tmux session names can't hold `.`/`:` (target syntax) — minted ids
 *  (`tmux-<hex>` → `bro-tmux-<hex>`) always pass; a tampered registry
 *  entry's name must still be proven safe before it becomes a -t arg. */
const TMUX_SESSION_NAME = /^[A-Za-z0-9_-]+$/

interface TmuxResult {
  code: number
  out: string
  err: string
  /** ENOENT — the binary isn't there at all (degrade, don't probe). */
  missing: boolean
}

/** One tmux call on a socket. `socket === ''` targets the user's default
 *  server (no -L); the default 'bro' socket keeps the fleet off it. */
function tmuxRun(socket: string, args: string[]): TmuxResult {
  const proc = spawnSync('tmux', socket === '' ? args : ['-L', socket, ...args], { // NOSONAR — PATH lookup is the contract (same as git/bd)
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  })
  return {
    code: proc.status ?? 1,
    out: proc.stdout ?? '',
    err: (proc.stderr ?? proc.error?.message ?? '').trim(),
    missing: (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  }
}

/** The registry entry's tmux session name — the recorded one, or derived
 *  from a safe agentId for entries written before `session` existed.
 *  Undefined when neither is a legal tmux name. */
function tmuxSessionName(entry: AgentRegistryEntry): string | undefined {
  if (typeof entry.session === 'string' && TMUX_SESSION_NAME.test(entry.session)) {
    return entry.session
  }
  const derived = `bro-${entry.agentId}`
  return TMUX_SESSION_NAME.test(derived) ? derived : undefined
}

/** Tri-state liveness from has-session: exit 0 proves the session lives;
 *  TMUX_DEAD_ERR shapes prove it dead — sessions live inside the
 *  server, so a missing session, a downed server, or a socket file
 *  that isn't there are all corpses, not mysteries. Anything else
 *  (timeout, refused connection, permissions) is 'unknown': the probe
 *  failed and must not read as 'lost'. */
type TmuxLiveness = 'running' | 'dead' | 'unknown'

const TMUX_DEAD_ERR = /can't find session|no server running|no such file or directory/i

function tmuxProbe(socket: string, name: string): { live: TmuxLiveness; err: string } {
  const r = tmuxRun(socket, ['has-session', '-t', name])
  if (r.code === 0) {
    return { live: 'running', err: '' }
  }
  return {
    live: TMUX_DEAD_ERR.test(r.err) ? 'dead' : 'unknown',
    err: r.err !== '' ? r.err : `tmux exited ${r.code}`,
  }
}

/** Live state for a tmux entry: `probe` is the session liveness verdict
 *  (tmuxProbe for one entry, list()'s batched list-sessions for the
 *  fleet — the pane dying takes the session with it), then the shared
 *  recorded-death ladder. An 'unknown' probe still honors recorded
 *  death but never reports 'lost' — a failed probe didn't find a
 *  corpse, so 'spawned' (registered, unverified) is the honest read. */
function tmuxState(
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  probe: TmuxLiveness
): AgentState {
  // liveness first — 'stopped' on a session that still exists means
  // kill-session hasn't landed; the agent IS still running
  if (probe === 'running') {
    touchWorkMarker(dir, entry.agentId)
    return 'running'
  }
  const dead = recordedDeath(dir, home, molStep, entry)
  if (dead !== undefined) {
    return dead
  }
  if (probe === 'unknown') {
    // the marker stays — an unverifiable agent may still be live work
    return 'spawned'
  }
  dropWorkMarker(dir, entry.agentId)
  return 'lost'
}

function toTmuxInfo(
  socket: string,
  dir: string,
  home: string | null,
  molStep: string,
  entry: AgentRegistryEntry,
  live?: Set<string>
): AgentInfo {
  const name = tmuxSessionName(entry)
  // a batch `live` set decides outright; without one, probe the server
  let probe: TmuxLiveness
  if (name === undefined) {
    probe = 'dead' // no legal session name → nothing to find
  } else if (live !== undefined) {
    probe = live.has(name) ? 'running' : 'dead'
  } else {
    probe = tmuxProbe(socket, name).live
  }
  return {
    id: entry.agentId,
    pid: typeof entry.pid === 'number' ? entry.pid : undefined,
    molStep,
    backend: entry.backend,
    state: tmuxState(dir, home, molStep, entry, probe),
    worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
    log: typeof entry.log === 'string' ? entry.log : undefined,
  }
}

/** The tmux backend — each agent is a detached tmux session on a
 *  dedicated socket (`agents.tmux.socket`, default 'bro'; '' = the
 *  user's default server). Interactive: `tmux -L bro attach -t
 *  bro-<agentId>` is the attach the capability flag promises. The tmux
 *  server self-starts on new-session, so supervisor stays 'none'.
 *
 *  Dedup/claim/registry semantics are the native one's — the beads
 *  claim in the shared store is the single source of truth, the
 *  agentId survives respawn, and a foreign backend's entry is never
 *  adopted. Knobs: `agents.tmux.command` → `loop.agent` (same agent
 *  command template as native, `{promptFile}` expanded). */
export function makeTmuxConnector(ctx: ConnectorCtx, env: AgentConnectorEnv): AgentConnector {
  const dir = ctx.dir
  const knobs = env.agents['tmux'] ?? {}
  const command =
    (typeof knobs.command === 'string' && knobs.command.trim() !== ''
      ? knobs.command
      : undefined) ?? env.loop?.agent ?? ''
  const socket = typeof knobs.socket === 'string' ? knobs.socket : 'bro'

  const findEntry = (id: string) => findAgentEntry(dir, 'tmux', id)

  return {
    name: 'tmux',

    async spawn(spec: SpawnSpec): Promise<AgentInfo> { // NOSONAR — connector contract is async; the critical section is sync
      const home = spawnHome(dir, 'tmux', command, spec)
      const ver = tmuxRun(socket, ['-V'])
      if (ver.missing || ver.code !== 0) {
        throw new SpawnError(`tmux unavailable — ${ver.missing ? 'not on PATH' : ver.err}`)
      }
      // same critical section as native: dedup → claim → session →
      // pid-patch under the registry lock, all synchronous shell-outs
      return withAgentRegistryLock(dir, () => {
        // the session name derives from the agentId prepareSpawn
        // resolves — entry callback, not a precomputed name, because a
        // tampered entry's unsafe id is reminted inside
        const { agentId, promptFile, log, exitFile } = prepareSpawn(dir, home, 'tmux', spec, {
          isLive: (e) => {
            const n = tmuxSessionName(e)
            if (n === undefined) {
              return false
            }
            const p = tmuxProbe(socket, n)
            if (p.live === 'unknown') {
              // an unverifiable liveness probe must not let a duplicate
              // spawn kill-session a worker that may still be alive
              throw new SpawnError(`cannot verify ${spec.molStep}'s tmux session — ${p.err}`)
            }
            if (p.live === 'running') {
              touchWorkMarker(dir, e.agentId)
            }
            return p.live === 'running'
          },
          liveDetail: (e) => `session ${tmuxSessionName(e) ?? '?'}`,
          entry: (id) => ({ session: `bro-${id}` }),
        })
        const session = `bro-${agentId}`
        // a leftover session with our name (crash between entry and
        // kill, a respawn over a zombie) would make new-session fail
        // 'duplicate' — clear it; kill-session on a missing target is
        // a no-op error we ignore
        tmuxRun(socket, ['kill-session', '-t', session])
        // ambient env (process.env + spec.env) rides a 0600 file the
        // pane sources, not argv — -e KEY=VALUE would expose secrets on
        // the tmux client's world-readable cmdline, a regression vs
        // native's spawn env. Identity pins are non-secret and stay on
        // -e; they're also filtered OUT of the file so sourcing can
        // never redirect the claim store or re-badge the worker
        const envFile = join(home, `${agentId}.env`)
        const PIN_KEYS = ['BEADS_DIR', 'BRO_BEAD_ID', 'BRO_AGENT_ID', 'BRO_PROMPT_FILE']
        const ambient = Object.entries({ ...process.env, ...spec.env })
          .filter(
            (e): e is [string, string] =>
              e[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) && !PIN_KEYS.includes(e[0])
          )
          .map(([k, v]) => `export ${k}=${shQuote(v)}`)
          .join('\n')
        writeFileSync(envFile, `${ambient}\n`, { mode: 0o600 })
        const envArgs = Object.entries({
          BEADS_DIR: spec.beadsDir,
          BRO_BEAD_ID: spec.molStep,
          BRO_AGENT_ID: agentId,
          BRO_PROMPT_FILE: promptFile,
        }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
        // the pane sources the ambient env and drops the file, then runs
        // the agent; $? lands in the .exit file before the pipeline
        // drains, tee keeps a log the way native's fd redirect does.
        // Session dies with the pane → has-session IS liveness. tmux
        // runs the command through the user's default-shell — a
        // non-POSIX one (fish) would eat the braces, so sh -c pins the
        // dialect the same way native's spawn does
        const paneScript = `. ${shQuote(envFile)}; rm -f ${shQuote(envFile)}; { ${expandAgentCmd(command, promptFile)}; s=$?; printf %s "$s" > ${shQuote(exitFile)}; } 2>&1 | tee -a ${shQuote(log)}`
        const paneCmd = `sh -c ${shQuote(paneScript)}` // NOSONAR — operator-configured agent command (same contract as native/loop)
        const res = tmuxRun(socket, [
          'new-session',
          '-d',
          '-s',
          session,
          '-c',
          spec.repoRoot,
          ...envArgs,
          paneCmd,
        ])
        if (res.code !== 0) {
          rmSync(envFile, { force: true }) // a failed spawn must not leave ambient env on disk
          try {
            patchAgentRegistry(dir, spec.molStep, { spawnError: res.err })
          } catch {
            // the entry landed already — the SpawnError still reports
          }
          throw new SpawnError(`tmux new-session failed — ${res.err}`)
        }
        // pane pid — a display handle like native's child pid, not the
        // liveness signal (has-session is)
        const pp = tmuxRun(socket, ['list-panes', '-t', session, '-F', '#{pane_pid}'])
        const panePid = pp.code === 0 ? Number(pp.out.trim().split('\n')[0]) : Number.NaN
        const spawned = patchAgentRegistry(
          dir,
          spec.molStep,
          Number.isInteger(panePid) && panePid > 0 ? { pid: panePid } : {}
        )
        writeWorkMarker(dir, agentId, spec.molStep)
        return toTmuxInfo(socket, dir, home, spec.molStep, spawned)
      })
    },

    async list() { // NOSONAR — connector contract is async; the body is sync
      try {
        const ver = tmuxRun(socket, ['-V'])
        if (ver.missing || ver.code !== 0) {
          return { agents: [], degraded: ver.missing ? 'tmux not on PATH' : ver.err }
        }
        const home = agentsHome(dir)
        const entries = Object.entries(readAgentRegistry(dir)).filter(
          ([, e]) => e.backend === 'tmux'
        )
        // one server round-trip for the whole fleet instead of a
        // has-session per entry — a name absent from a SUCCESSFUL
        // listing is proof of dead, and so is a dead-server error (the
        // server holds its sessions). Any other failure degrades the
        // list rather than reporting live agents as corpses
        const ls = tmuxRun(socket, ['list-sessions', '-F', '#{session_name}'])
        if (ls.code !== 0 && !TMUX_DEAD_ERR.test(ls.err)) {
          return { agents: [], degraded: ls.err !== '' ? ls.err : `tmux exited ${ls.code}` }
        }
        const live = new Set(ls.out.split('\n').filter((s) => s !== ''))
        return {
          agents: entries.map(([molStep, e]) => toTmuxInfo(socket, dir, home, molStep, e, live)),
        }
      } catch (err) {
        return {
          agents: [],
          degraded: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async status(id: string): Promise<AgentInfo> { // NOSONAR — connector contract is async; the body is sync
      const hit = findEntry(id)
      if (!hit) {
        throw new AgentNotFound(`no tmux agent ${id}`)
      }
      return toTmuxInfo(socket, dir, agentsHome(dir), hit[0], hit[1])
    },

    async stop(id: string): Promise<void> {
      const hit = findEntry(id)
      if (!hit) {
        return // idempotent — gone is the desired end state
      }
      const [molStep, entry] = hit
      const name = tmuxSessionName(entry)
      if (name !== undefined) {
        tmuxRun(socket, ['kill-session', '-t', name])
        // let the kill land before recording the stop — 'stopped' on a
        // still-live session would let a respawn run alongside it
        const deadline = Date.now() + 2_000
        while (
          tmuxProbe(socket, name).live === 'running' &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 25)) // NOSONAR — bounded kill-wait poll
        }
      }
      // a respawn during the kill wait re-probes and re-pins the entry
      // under the registry lock — re-verify under the SAME lock or
      // 'stopped' + the marker drop land on a live, respawned entry
      withAgentRegistryLock(dir, () => {
        const cur = readAgentRegistry(dir)[molStep]
        if (
          cur === undefined ||
          cur.agentId !== entry.agentId ||
          cur.spawnedAt !== entry.spawnedAt
        ) {
          return // respawned — the live run owns the entry
        }
        if (name !== undefined) {
          const p = tmuxProbe(socket, name)
          if (p.live === 'running') {
            return // still alive — the live run owns the entry
          }
          if (p.live === 'unknown') {
            // an unverifiable probe must not record 'stopped' on a
            // session that may still be live — fail loudly instead
            throw new Error(`cannot verify ${id}'s tmux session stopped — ${p.err}`)
          }
        }
        try {
          patchAgentRegistry(dir, molStep, { stopped: true })
        } catch {
          // the marker removal below still records intent
        }
        dropWorkMarker(dir, id)
      })
    },

    capabilities: () => ({ attach: true, respawn: true, supervisor: 'none' }),
  }
}

registerAgentConnector('tmux', makeTmuxConnector)
