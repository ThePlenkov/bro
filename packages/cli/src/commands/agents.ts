/**
 * `bro agents` — the supervisor surface over the agents facade.
 * Spec: specs/sessions/bro-f4ot/spec.md.
 *
 *   bro agents status [<id|step>] [--json] [--connector <name>]
 *                       agent plane: every backend × its agents; an arg
 *                       prints one agent's detail. Degraded backends
 *                       warn — never a hard failure of the view.
 *   bro agents up [<step>] [--connector <name>] [--worktree <path>]
 *                  [--prompt-file <file>] [--beads-dir <dir>]
 *                       no arg: the resolved backend's supervisor up —
 *                       `supervisor:'none'` backends (native) are
 *                       self-sufficient, so it's a reported no-op.
 *                       with <step>: spawn the step's agent — a lost /
 *                       exited agent is RESPAWNED on the same agentId
 *                       (the claim rebinds), a live one is a SpawnError.
 *                       This is the action behind fleet's
 *                       `lost — respawn?` decision surface.
 *   bro agents down [<id|step>] [--connector <name>]
 *                       no arg: supervisor down. With a target: stop
 *                       that one agent — idempotent, a gone agent is
 *                       the desired end state, exit 0.
 *
 * The respawn semantics live in the connector (spawn dedup correlates
 * the beads claim with the registry's liveness); this command only
 * resolves the SpawnSpec — worktree (recorded → <repo>--<step>
 * convention → --worktree), prompt (--prompt-file → the dead agent's
 * stored prompt → the bead's own text), and the pinned shared store.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  bdAt,
  readAgentRegistry,
  SpawnError,
  type AgentConnector,
  type AgentInfo,
} from '@broject/core'
import { beadsDir } from '@broject/convoy'
import {
  agentPromptPath,
  eachAgentConnector,
  loadAgentEnv,
  resolveAgentConnector,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { flag, positionals } from './args.ts'
import { mainWorktree, worktreePathFor } from './work.ts'

function usage(): never {
  console.error(`usage:
  bro agents status [<id|step>] [--json] [--connector <name>]
  bro agents up [<step>] [--connector <name>] [--worktree <path>] [--prompt-file <file>] [--beads-dir <dir>]
  bro agents down [<id|step>] [--connector <name>]`)
  process.exit(2)
}

// a function declaration, not a const arrow — tsc only treats calls to
// never-returning function declarations as terminating the control flow,
// so the die() call sites below narrow correctly
function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** All backends' agent planes — a throwing factory or list() is
 *  degrade-equivalent (one `degraded` note), never a hard failure. */
async function collectAgents(
  dir: string,
  env: AgentConnectorEnv,
  connectorName?: string
): Promise<{ backends: { conn: AgentConnector; agents: AgentInfo[]; degraded?: string }[] }> {
  const backends = []
  for (const conn of eachAgentConnector({ dir }, env, (name, err) => {
    // --connector scopes failures too — an unrelated backend's throwing
    // factory must not leak a degraded stub into the selected view
    if (connectorName === undefined || name === connectorName) {
      backends.push({
        conn: { name, capabilities: () => ({ supervisor: 'none' as const }) } as AgentConnector,
        agents: [],
        degraded: `factory: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })) {
    if (connectorName !== undefined && conn.name !== connectorName) {
      continue
    }
    try {
      const res = await conn.list()
      backends.push({ conn, agents: res.agents, degraded: res.degraded })
    } catch (err) {
      backends.push({
        conn,
        agents: [],
        degraded: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (connectorName !== undefined && !backends.some((b) => b.conn.name === connectorName)) {
    die(`agent connector "${connectorName}" is not registered`)
  }
  return { backends }
}

/** Target → agent + its backend, matched on agentId OR molStep.
 *  `degraded` names backends whose list() failed — a miss next to a
 *  degraded backend is "couldn't verify", not "gone". */
function findInBackends(
  backends: { conn: AgentConnector; agents: AgentInfo[]; degraded?: string }[],
  target: string
): { hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] } {
  const degraded = backends
    .filter((b) => b.degraded !== undefined)
    .map((b) => `${b.conn.name}: ${b.degraded}`)
  for (const { conn, agents } of backends) {
    const hit = agents.find((a) => a.id === target || a.molStep === target)
    if (hit) {
      return { hit: { conn, agent: hit }, degraded }
    }
  }
  return { degraded }
}

async function findAgent(
  dir: string,
  env: AgentConnectorEnv,
  target: string,
  connectorName?: string
): Promise<{ hit?: { conn: AgentConnector; agent: AgentInfo }; degraded: string[] }> {
  const { backends } = await collectAgents(dir, env, connectorName)
  return findInBackends(backends, target)
}

// --- status -------------------------------------------------------------------

function printStatusTable(
  backends: { conn: AgentConnector; agents: AgentInfo[]; degraded?: string }[]
): void {
  const cols = ['backend', 'supervisor', 'agent', 'step', 'state', 'pid', 'worktree']
  const rows = backends.flatMap(({ conn, agents }) => {
    const sup = conn.capabilities().supervisor
    if (agents.length === 0) {
      return [[conn.name, sup, '—', '—', '—', '—', '—']]
    }
    return agents.map((a) => [
      conn.name,
      sup,
      a.id,
      a.molStep,
      a.state,
      a.pid === undefined ? '—' : String(a.pid),
      a.worktree === undefined ? '—' : basename(a.worktree),
    ])
  })
  const widths = cols.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  console.log(line(cols))
  for (const r of rows) {
    console.log(line(r))
  }
  for (const { conn, degraded } of backends) {
    if (degraded) {
      console.error(`warning: backend degraded — ${conn.name}: ${degraded}`)
    }
  }
}

async function cmdStatus(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector']))
  if (pos.length > 1) {
    usage()
  }
  const target = pos[0]
  const json = argv.includes('--json')
  const connectorName = flag(argv, '--connector')
  const { backends } = await collectAgents(dir, env, connectorName)

  if (target !== undefined) {
    // the table path already collected — search it, don't list() twice
    const { hit, degraded } = findInBackends(backends, target)
    if (!hit) {
      const blind = degraded.length > 0 ? ` (degraded: ${degraded.join('; ')})` : ''
      die(
        `no agent "${target}"${blind} — checked ${backends.map((b) => b.conn.name).join(', ') || 'no backends'}`
      )
    }
    // a found agent doesn't mean the fleet view is complete — surface
    // degraded backends on the targeted read too (stderr, so --json
    // stays parseable)
    for (const d of degraded) {
      console.error(`warning: backend degraded — ${d}`)
    }
    const a = hit.agent
    if (json) {
      console.log(JSON.stringify(a, null, 2))
      return
    }
    console.log(`agent     ${a.id}`)
    console.log(`backend   ${a.backend} (supervisor: ${hit.conn.capabilities().supervisor})`)
    console.log(`step      ${a.molStep}`)
    console.log(`state     ${a.state}`)
    if (a.pid !== undefined) console.log(`pid       ${a.pid}`)
    if (a.worktree !== undefined) console.log(`worktree  ${a.worktree}`)
    if (a.log !== undefined) console.log(`log       ${a.log}`)
    return
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          backends: backends.map(({ conn, agents, degraded }) => ({
            name: conn.name,
            capabilities: conn.capabilities(),
            agents,
            ...(degraded !== undefined ? { degraded } : {}),
          })),
        },
        null,
        2
      )
    )
    return
  }
  printStatusTable(backends)
}

// --- up / down ------------------------------------------------------------------

/** Supervisor lifecycle on the resolved backend. `none` backends are
 *  self-sufficient — the verb is a reported no-op, not an error. A
 *  supervised backend without the method is a real gap: name it. */
async function supervisorVerb(conn: AgentConnector, verb: 'up' | 'down'): Promise<void> {
  const sup = conn.capabilities().supervisor
  if (sup === 'none') {
    console.log(`${conn.name}: supervisor 'none' — detached agents are self-sufficient, nothing to ${verb}`)
    return
  }
  const fn = verb === 'up' ? conn.up : conn.down
  if (fn === undefined) {
    die(`${conn.name} declares supervisor '${sup}' but implements no ${verb}() — connector gap`)
  }
  await fn!.call(conn)
  console.log(`${conn.name}: supervisor ${verb}`)
}

/** The step's worktree: explicit --worktree → the registry's recorded
 *  path (a respawn reuses the dead agent's checkout) → the
 *  `<repo>--<step>` sibling convention. Missing = the caller never
 *  entered one — the error names the command, not a guess. */
function resolveWorktree(
  dir: string,
  molStep: string,
  explicit: string | undefined,
  backend: string
): string {
  if (explicit !== undefined) {
    return explicit
  }
  // recorded state is the resolving backend's — `--connector x` must not
  // inherit backend-y's worktree/prompt for the same step
  const entry = readAgentRegistry(dir)[molStep]
  const recorded = entry?.backend === backend ? entry.worktree : undefined
  if (typeof recorded === 'string' && existsSync(recorded)) {
    return recorded
  }
  const conventional = worktreePathFor(mainWorktree().path, molStep)
  if (existsSync(conventional)) {
    return conventional
  }
  die(
    `no worktree for ${molStep} — run \`bro work enter ${molStep}\` first ` +
      `(or pass --worktree <path>)`
  )
}

/** The spawn prompt: --prompt-file → the previous run's stored prompt
 *  (respawn keeps a custom-prompt agent's real instructions — the
 *  agentId outlives the process, so its prompt file does too) → the
 *  bead's own text, the convoy formula's rendered instructions. */
function resolvePrompt(
  dir: string,
  beads: string,
  molStep: string,
  promptFile: string | undefined,
  backend: string
): string {
  if (promptFile !== undefined) {
    if (!existsSync(promptFile)) {
      die(`prompt file ${promptFile} does not exist`)
    }
    return readFileSync(promptFile, 'utf8')
  }
  const entry = readAgentRegistry(dir)[molStep]
  const agentId = entry?.backend === backend ? entry.agentId : undefined
  const stored = agentId === undefined ? null : agentPromptPath(dir, agentId)
  if (stored !== null && existsSync(stored)) {
    return readFileSync(stored, 'utf8')
  }
  const r = bdAt(beads, ['show', molStep, '--json'])
  if (r.code !== 0) {
    die(`cannot render a prompt — bead ${molStep} unreadable (${r.err}); pass --prompt-file`)
  }
  let row: { title?: string; description?: string } | undefined
  try {
    row = (JSON.parse(r.out) as { title?: string; description?: string }[])[0]
  } catch {
    // exit-0 garbage (non-JSON diagnostics, truncated output) falls
    // through to the same die as an empty row
    row = undefined
  }
  const prompt = `# ${row?.title ?? molStep}\n\n${row?.description ?? ''}`.trim()
  if (row === undefined || prompt === `# ${molStep}`) {
    die(`bead ${molStep} has no title/description to prompt with — pass --prompt-file`)
  }
  return prompt
}

async function cmdUp(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector', '--worktree', '--prompt-file', '--beads-dir']))
  const connectorName = flag(argv, '--connector')
  if (pos.length > 1) {
    usage()
  }
  const conn = resolveAgentConnector({ dir }, { connector: connectorName }, env)
  const molStep = pos[0]
  if (molStep === undefined) {
    await supervisorVerb(conn, 'up')
    return
  }
  const beads = flag(argv, '--beads-dir') ?? beadsDir()
  const repoRoot = resolveWorktree(dir, molStep, flag(argv, '--worktree'), conn.name)
  if (!existsSync(repoRoot)) {
    die(`worktree ${repoRoot} does not exist`)
  }
  const prompt = resolvePrompt(dir, beads, molStep, flag(argv, '--prompt-file'), conn.name)
  let info: AgentInfo
  try {
    info = await conn.spawn({ molStep, repoRoot, beadsDir: beads, prompt })
  } catch (err) {
    if (err instanceof SpawnError) {
      die(err.message)
    }
    throw err
  }
  const pid = info.pid === undefined ? '' : ` pid ${info.pid}`
  console.log(`agent ${info.id} ${info.state} for ${molStep} (${info.backend}${pid})`)
  if (info.log !== undefined) {
    console.log(`  log: ${info.log}`)
  }
  if (info.worktree !== undefined) {
    console.log(`  worktree: ${info.worktree}`)
  }
}

async function cmdDown(dir: string, env: AgentConnectorEnv, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--connector']))
  const connectorName = flag(argv, '--connector')
  if (pos.length > 1) {
    usage()
  }
  const target = pos[0]
  if (target === undefined) {
    await supervisorVerb(resolveAgentConnector({ dir }, { connector: connectorName }, env), 'down')
    return
  }
  const { hit, degraded } = await findAgent(dir, env, target, connectorName)
  if (!hit) {
    // a degraded read can't confirm "gone" — report unverified, don't
    // claim the desired end state was reached
    if (degraded.length > 0) {
      die(`down: no agent "${target}" found — backend(s) degraded: ${degraded.join('; ')}`)
    }
    // stop() is idempotent — a gone agent is the desired end state
    console.log(`down: no agent "${target}" — nothing to stop`)
    return
  }
  // bind the stop to what the backend reports NOW, not the list()
  // snapshot — a respawn between the two reuses the agentId with a new
  // pid, and a dead agent is already the desired end state
  let current = hit.agent
  try {
    current = await hit.conn.status(hit.agent.id)
  } catch {
    // the read failed — stop() still binds to the observed id
  }
  if (current.state === 'exited' || current.state === 'stopped' || current.state === 'lost') {
    console.log(`down: ${hit.agent.id} is ${current.state} — nothing to stop`)
    return
  }
  if (current.pid !== hit.agent.pid) {
    console.error(
      `note: ${hit.agent.id} respawned since lookup (pid ${String(hit.agent.pid)} → ${String(current.pid)}) — stopping current instance`
    )
  }
  await hit.conn.stop(hit.agent.id)
  console.log(`stopped ${hit.agent.id} (${hit.agent.molStep}, ${hit.conn.name})`)
}

export async function runAgentsCommand(argv: string[]): Promise<void> {
  const dir = process.cwd()
  const env = loadAgentEnv(dir)
  const sub = argv[0]
  switch (sub) {
    case 'status':
      await cmdStatus(dir, env, argv.slice(1))
      return
    case 'up':
      await cmdUp(dir, env, argv.slice(1))
      return
    case 'down':
      await cmdDown(dir, env, argv.slice(1))
      return
    case undefined:
    case '--help':
    case '-h':
      usage()
      return
    default:
      console.error(`error: unknown agents subcommand "${sub}"`)
      usage()
  }
}

