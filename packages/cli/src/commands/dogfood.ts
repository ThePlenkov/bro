/**
 * `bro self dogfood` — scenario-driven e2e self-test (spec:
 * specs/bro-vwms5.md). The formula:
 *
 *   scenario (committed markdown runbook, no links — bro commands and
 *   $skill names inlined)
 *   → RUNNER: a fresh agent spawned through the fleet registry
 *     (spawnStepAgent — the `bro fleet agents up` path, never nohup)
 *     working in a scratch repo provisioned per run
 *   → ANALYST: a second fresh agent that reads the scenario, the
 *     runner's transcript, and the scratch repo's end state, then
 *     writes verdict.md
 *
 * The run is orchestration-only: registry spawn, claims, liveness and
 * exit classification all come from the existing fleet machinery.
 * There is no hidden scheduler — `status` is the point check AND the
 * lazy advancer: a runner recorded terminal triggers the analyst
 * spawn there, never from a background tick. Orchestrator-only like
 * `fleet daemon up` / `fleet resume`: a worker never arms workers.
 *
 *   bro self dogfood scenarios
 *   bro self dogfood run <name> [--backend <c>] [--analyst <c|same|none>] [--keep]
 *   bro self dogfood status [run-id] [--json]
 *   bro self dogfood report <run-id>
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gitCommonDir, gitTry, taskStoreAt, type AgentInfo } from '@broject/core'
import { loadAgentEnv, type AgentConnectorEnv } from '../agent-connectors.ts'
import { collectAgentBackends, spawnStepAgent } from './agents.ts'
import { flag, positionals } from './args.ts'
import { isOrchestratorSession } from './watch-pulse.ts'


function usage(): never {
  console.error(`usage:
  bro self dogfood scenarios
  bro self dogfood run <name> [--backend <c>] [--analyst <c|same|none>] [--keep]
  bro self dogfood status [run-id] [--json]
  bro self dogfood report <run-id>`)
  process.exit(2)
}

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** `<git-common>/bro/dogfood/` — run ledger root. */
export function dogfoodHome(dir: string): string | null {
  const common = gitCommonDir(dir)
  return common === null ? null : join(common, 'bro', 'dogfood')
}

// --- scenarios --------------------------------------------------------------

/** Committed `dogfood/*.md` names (extension stripped). */
export function listScenarios(dir: string): string[] {
  const home = join(dir, 'dogfood')
  if (!existsSync(home)) {
    return []
  }
  return readdirSync(home)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort()
}

function scenarioPath(dir: string, name: string): string {
  const file = join(dir, 'dogfood', name.endsWith('.md') ? name : `${name}.md`)
  if (!existsSync(file)) {
    die(`no scenario ${name} — \`bro self dogfood scenarios\` lists them`)
  }
  return file
}

// --- run records ------------------------------------------------------------

type RunPhase = 'running' | 'analyzing' | 'done' | 'failed'

interface RunState {
  scenario: string
  phase: RunPhase
  /** Step bead in the scratch store — the runner's claim/registry key. */
  bead: string
  /** The scratch repo's path — under os.tmpdir(), never inside the
   *  host tree (see provisionRepo). */
  repo: string
  runnerAgent?: string
  runnerBackend?: string
  analystAgent?: string
  analystBackend?: string
  /** 'none' skips the analyst pass. */
  analyst: string
  createdAt: string
}

function runDir(dir: string, runId: string): string {
  const home = dogfoodHome(dir)
  if (home === null) {
    die('not inside a git worktree')
  }
  return join(home, runId)
}

function readRun(rdir: string): RunState | null {
  const f = join(rdir, 'state.json')
  if (!existsSync(f)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as RunState
  } catch {
    return null
  }
}

function writeRun(rdir: string, s: RunState): void {
  writeFileSync(join(rdir, 'state.json'), JSON.stringify(s, null, 2))
}

function listRuns(dir: string): Array<{ id: string; dir: string; state: RunState }> {
  const home = dogfoodHome(dir)
  if (home === null || !existsSync(home)) {
    return []
  }
  return readdirSync(home)
    .map((id) => {
      const rdir = join(home, id)
      const state = readRun(rdir)
      return state === null ? null : { id, dir: rdir, state }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.state.createdAt.localeCompare(b.state.createdAt))
}

// --- prompt wrapping --------------------------------------------------------

function runnerPrompt(repo: string, scenario: string): string {
  return `You are the RUNNER of a bro dogfood scenario — a scripted
end-to-end exercise of the bro CLI itself.

Work ONLY inside ${repo}. Every command runs there. \`bro\` is on PATH
(\`which bro\` to confirm).
\`bd\` works inside the repo — a stealth store was initialized at
provisioning.

Follow the scenario below literally, step by step, top to bottom.
Where the runbook is ambiguous, note the ambiguity and pick the most
reasonable reading — a dogfood run reports friction, it does not
silently work around it. When done — or when a step cannot be
completed — end with a short final report: what ran, what failed,
what surprised you, what the docs/skill should have said.

--- scenario ---
${scenario}`
}

function analystPrompt(
  scenarioFile: string,
  rdir: string,
  repo: string,
  runnerAgent: string | undefined
): string {
  return `You are the ANALYST of a bro dogfood run. Judge the run, do
not repeat it.

Inputs:
- scenario: ${scenarioFile}
- scratch repo (survives): ${repo}
- runner agent: ${runnerAgent ?? 'unrecorded'} — its transcript/log
  live under the shared agents dir (\`bro fleet agents\` resolves it);
  the run record itself is ${join(rdir, 'state.json')}

Read the scenario, then the runner's transcript, then inspect the
scratch repo's surviving state (\`git log\`, \`bd list\`, \`bro status\`,
whatever the scenario's ## Assert section names).

Write your verdict to ${join(rdir, 'verdict.md')} in exactly this shape:

    verdict: PASS | ISSUES
    fail: <one line per violated assertion — omit entirely when none>
    - <finding bullet>
    - <finding bullet>

PASS means the scenario accomplished its intent end-to-end; ISSUES
means it did not, or surfaced real friction/failures worth a bead.
The verdict file is the artifact — keep it tight.`
}

// --- spawn ------------------------------------------------------------------

/** Provision the scratch repo — own git store, own stealth beads
 *  store; claims the runner makes never pollute the host's. It lives
 *  under os.tmpdir(), NOT inside the run dir: `bd init` walks ancestor
 *  directories for an existing .beads config, and a scratch nested
 *  under the host checkout would silently bootstrap from the host's
 *  beads remote instead of starting empty. Isolation requires being
 *  outside the tree. The step bead lives in the scratch store for the
 *  same reason (state.json is the host-side record). */
function provisionRepo(): { repo: string; beads: string; initErr: string | null } {
  const repo = mkdtempSync(join(tmpdir(), 'bro-dogfood-'))
  const beads = join(repo, '.beads')
  execFileSync('git', ['init', '-q', '-b', 'main', repo]) // NOSONAR — PATH lookup is the contract
  execFileSync('git', [ // NOSONAR — PATH lookup is the contract
    '-C',
    repo,
    // identity pinned — a scratch must never depend on ambient
    // user.name/user.email living in global config (or a host-only one)
    '-c',
    'user.name=bro-dogfood',
    '-c',
    'user.email=dogfood@localhost',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'dogfood scratch',
  ])
  // the store must be a real bd database, not just a dir — best-effort:
  // a scripted bd (tests) may not implement init; initErr rides into
  // the step-bead create's failure so the real cause is never buried
  let initErr: string | null = null
  try {
    execFileSync('bd', ['init', '--stealth'], { cwd: repo, stdio: 'pipe' }) // NOSONAR — PATH lookup is the contract
  } catch (err) {
    initErr = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
  }
  mkdirSync(beads, { recursive: true })
  return { repo, beads, initErr }
}

/** Resolve a live/terminal view of one agent id across backends. */
async function agentView(
  dir: string,
  env: AgentConnectorEnv,
  agentId: string
): Promise<AgentInfo | null> {
  const { backends } = await collectAgentBackends(dir, env)
  for (const p of backends) {
    const hit = p.agents.find((a) => a.id === agentId)
    if (hit !== undefined) {
      return hit
    }
  }
  return null
}

/** Agent states the pipeline treats as runner-finished — `blocked` is
 *  respawn-able debt, not completion. */
const TERMINAL = new Set(['exited', 'lost', 'stopped'])

/** `status` is the lazy advancer: a terminal runner spawns the analyst
 *  here. Returns the (possibly updated) run state. */
async function advanceRun(
  dir: string,
  env: AgentConnectorEnv,
  rdir: string,
  state: RunState
): Promise<RunState> {
  if (state.phase !== 'running' || state.runnerAgent === undefined) {
    return state
  }
  const runner = await agentView(dir, env, state.runnerAgent)
  if (runner === null || !TERMINAL.has(runner.state)) {
    return state
  }
  if (state.analyst === 'none') {
    state.phase = 'done'
    writeRun(rdir, state)
    return state
  }
  // a WORKER session calling status must not arm the analyst spawn —
  // same guard as `run`: workers never arm workers
  if (!isOrchestratorSession()) {
    return state
  }
  const scenarioFile = join(rdir, 'scenario.md')
  const prompt = analystPrompt(scenarioFile, rdir, state.repo, state.runnerAgent)
  const promptFile = join(rdir, 'analyst.prompt.md')
  writeFileSync(promptFile, prompt)
  // 'same' means the runner's lane when recorded; an absent pin (a
  // pre-field run record) falls through to the default connector probe,
  // which names its own resolution failure — never a silent mystery
  const backend = state.analyst === 'same' ? state.runnerBackend : state.analyst
  try {
    // a step of its own — registry dedup keys on molStep, and the
    // runner's entry (dead or alive) must not collide with the
    // analyst's claim; both beads live in the scratch store
    const beads = join(state.repo, '.beads')
    const analystBead = taskStoreAt(beads).create({
      title: `dogfood analyst ${state.scenario} ${basename(rdir)}`,
      description: `Analyst pass of ${basename(rdir)} — verdict writer.`,
      type: 'task',
      priority: 2,
    })
    const info = await spawnStepAgent(dir, env, {
      molStep: analystBead.id,
      worktree: state.repo,
      promptFile,
      connector: backend,
      beadsDir: beads,
    })
    state.analystAgent = info.id
    state.analystBackend = info.backend
    state.phase = 'analyzing'
  } catch (err) {
    state.phase = 'failed'
    writeRun(rdir, state)
    die(
      `analyst spawn failed for ${basename(rdir)}: ` +
        (err instanceof Error ? err.message : String(err))
    )
  }
  writeRun(rdir, state)
  return state
}

// --- verbs ------------------------------------------------------------------

async function cmdRun(dir: string, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--backend', '--analyst']), {
    boolFlags: new Set(['--keep']),
    strict: true,
  })
  const name = pos[0]
  if (name === undefined) {
    usage()
  }
  if (!isOrchestratorSession()) {
    die('BRO_AGENT_ID is set — dogfood runs are orchestrator-only (a worker never arms workers)')
  }
  const analyst = flag(argv, '--analyst') ?? 'same'
  const backend = flag(argv, '--backend')
  const keep = argv.includes('--keep')
  const src = scenarioPath(dir, name)

  const home = dogfoodHome(dir)
  if (home === null) {
    die('not inside a git worktree')
  }
  // millisecond ts alone collides for same-name runs in one tick —
  // a random suffix keeps every run dir distinct
  const runId = `df-${name.replace(/\.md$/, '')}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  const rdir = join(home, runId)
  mkdirSync(rdir, { recursive: true })
  copyFileSync(src, join(rdir, 'scenario.md'))
  const { repo, beads, initErr } = provisionRepo()

  // the step bead lives in the scratch store — the runner's claims
  // stay inside the disposable repo
  let bead: { id: string }
  try {
    bead = taskStoreAt(beads).create({
      title: `dogfood ${name} ${runId}`,
      description: `Dogfood run ${runId} of scenario ${name} — runner claim.`,
      type: 'task',
      priority: 2,
    })
  } catch (err) {
    die(
      `step bead create failed` +
        (initErr === null ? '' : ` (bd init also failed: ${initErr})`) +
        `: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const prompt = runnerPrompt(repo, readFileSync(src, 'utf8'))
  const promptFile = join(rdir, 'runner.prompt.md')
  writeFileSync(promptFile, prompt)

  const env = loadAgentEnv(dir)
  const state: RunState = {
    scenario: name,
    phase: 'running',
    bead: bead.id,
    repo,
    analyst,
    createdAt: new Date().toISOString(),
  }
  try {
    const info = await spawnStepAgent(dir, env, {
      molStep: bead.id,
      worktree: repo,
      promptFile,
      connector: backend ?? undefined,
      beadsDir: beads,
      env: keep ? { BRO_DOGFOOD_KEEP: '1' } : undefined,
    })
    state.runnerAgent = info.id
    state.runnerBackend = info.backend
  } catch (err) {
    state.phase = 'failed'
    writeRun(rdir, state)
    die(`runner spawn failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  writeRun(rdir, state)
  console.log(
    `dogfood run ${runId} — runner ${state.runnerAgent} (${state.runnerBackend}) on ${repo}` +
      `\n  status: bro self dogfood status ${runId}`
  )
}

interface StatusRow {
  run: string
  scenario: string
  phase: RunPhase
  runner?: string
  analyst?: string
  verdict?: string
  repo: string
}

function agentLabel(
  state: RunState,
  which: 'runner' | 'analyst',
  info: AgentInfo | null
): string | undefined {
  const id = which === 'runner' ? state.runnerAgent : state.analystAgent
  if (id === undefined) {
    return which === 'analyst' && state.analyst === 'none' ? 'none' : undefined
  }
  const cause = info?.cause === undefined ? '' : ` (${info.cause})`
  return `${id} ${info?.state ?? '?'}${cause}`
}

/** One run's status row — advance the pipeline first (status IS the
 *  advancer), then read agent liveness and the verdict file. A verdict
 *  on disk closes the run even before the analyst's process exits. */
async function statusRow(
  dir: string,
  env: AgentConnectorEnv,
  run: { id: string; dir: string; state: RunState }
): Promise<StatusRow> {
  const state = await advanceRun(dir, env, run.dir, run.state)
  const verdict = join(run.dir, 'verdict.md')
  const hasVerdict = existsSync(verdict)
  if (state.phase === 'analyzing' && hasVerdict) {
    state.phase = 'done'
    writeRun(run.dir, state)
  }
  const [runner, analyst] = await Promise.all([
    state.runnerAgent === undefined
      ? Promise.resolve(null)
      : agentView(dir, env, state.runnerAgent),
    state.analystAgent === undefined
      ? Promise.resolve(null)
      : agentView(dir, env, state.analystAgent),
  ])
  // a terminal analyst that left no verdict failed the run — 'analyzing'
  // must not sit forever waiting for a file that will never land
  if (
    state.phase === 'analyzing' &&
    !hasVerdict &&
    analyst !== null &&
    TERMINAL.has(analyst.state)
  ) {
    state.phase = 'failed'
    writeRun(run.dir, state)
  }
  return {
    run: run.id,
    scenario: state.scenario,
    phase: state.phase,
    runner: agentLabel(state, 'runner', runner),
    analyst: agentLabel(state, 'analyst', analyst),
    verdict: hasVerdict ? verdict : undefined,
    repo: existsSync(state.repo) ? state.repo : 'reaped',
  }
}

function statusLine(r: StatusRow): string {
  const parts = [`${r.run} [${r.phase}] ${r.scenario}`]
  if (r.runner !== undefined) {
    parts.push(`runner ${r.runner}`)
  }
  if (r.analyst !== undefined) {
    parts.push(r.analyst === 'none' ? 'no analyst' : `analyst ${r.analyst}`)
  }
  return (
    parts.join(' — ') +
    (r.verdict === undefined ? '' : `\n  verdict: ${r.verdict}`) +
    `\n  repo: ${r.repo}`
  )
}

async function cmdStatus(dir: string, argv: string[]): Promise<void> {
  const runId = positionals(argv, new Set(), {
    boolFlags: new Set(['--json']),
    strict: true,
  })[0]
  const env = loadAgentEnv(dir)
  const runs =
    runId === undefined
      ? listRuns(dir)
      : [{ id: runId, dir: runDir(dir, runId), state: readRun(runDir(dir, runId)) }].filter(
          (r): r is { id: string; dir: string; state: RunState } => r.state !== null
        )
  if (runs.length === 0) {
    die(runId === undefined ? 'no dogfood runs' : `no run ${runId}`)
  }
  const rows = await Promise.all(runs.map((run) => statusRow(dir, env, run)))
  if (argv.includes('--json')) {
    console.log(JSON.stringify(runs.length === 1 ? rows[0] : rows, null, 2))
    return
  }
  for (const r of rows) {
    console.log(statusLine(r))
  }
}

function cmdReport(dir: string, argv: string[]): void {
  const runId = positionals(argv, new Set(), { strict: true })[0]
  if (runId === undefined) {
    usage()
  }
  const rdir = runDir(dir, runId)
  const state = readRun(rdir)
  if (state === null) {
    die(`no run ${runId}`)
  }
  const verdict = join(rdir, 'verdict.md')
  if (existsSync(verdict)) {
    console.log(readFileSync(verdict, 'utf8'))
    return
  }
  console.log(
    `run ${runId} [${state.phase}] — no verdict yet` +
      (state.runnerAgent === undefined ? '' : `\n  runner: ${state.runnerAgent}`) +
      (state.analystAgent === undefined ? '' : `\n  analyst: ${state.analystAgent}`) +
      `\n  transcript: bro fleet agents — or the agents dir under the git-common dir`
  )
}

export async function runDogfoodCommand(argv: string[]): Promise<void> {
  const verb = argv[0]
  const rest = argv.slice(1)
  if (verb === undefined || argv.includes('--help') || argv.includes('-h')) {
    usage()
  }
  // scenarios resolve against the CURRENT checkout — a scenario still
  // on a feature branch must run before it merges. The run dir and the
  // agents registry share gitCommonDir(dir), so linked worktrees land
  // in the same ledger either way.
  const dir = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd()
  switch (verb) {
    case 'scenarios':
      for (const s of listScenarios(dir)) {
        console.log(s)
      }
      return
    case 'run':
      await cmdRun(dir, rest)
      return
    case 'status':
      await cmdStatus(dir, rest)
      return
    case 'report':
      cmdReport(dir, rest)
      return
    default:
      usage()
  }
}
