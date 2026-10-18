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
 *   bro self dogfood run <name> [--backend <c>] [--analyst <c|same|none>] [--provider <p>] [--keep]
 *   bro self dogfood status [run-id] [--json]
 *   bro self dogfood report <run-id>
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  acquireFileLock,
  gitCommonDir,
  gitTry,
  loadConfigLayers,
  LockTimeout,
  taskStoreAt,
  type AgentInfo,
  type ProviderEntry,
} from '@broject/core'
import { loadAgentEnv, type AgentConnectorEnv } from '../agent-connectors.ts'
import { collectAgentBackends, spawnStepAgent } from './agents.ts'
import { flag, positionals } from './args.ts'
import { isOrchestratorSession } from './watch-pulse.ts'


function usage(): never {
  console.error(`usage:
  bro self dogfood scenarios
  bro self dogfood run <name> [--backend <c>] [--analyst <c|same|none>] [--provider <p>] [--keep]
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

/** A scenario name / run id is ONE path segment — separators or a
 *  dot-segment would let `join` escape the ledger. The values are
 *  local-CLI input, so this is path hygiene, not a security boundary. */
function segment(what: string, value: string): string {
  if (value === '' || /[/\\]/.test(value) || value.includes('..')) {
    die(`invalid ${what} "${value}"`)
  }
  return value
}

function scenarioPath(dir: string, name: string): string {
  const clean = segment('scenario name', name)
  const file = join(dir, 'dogfood', clean.endsWith('.md') ? clean : `${clean}.md`)
  if (!existsSync(file)) {
    die(`no scenario ${name} — \`bro self dogfood scenarios\` lists them`)
  }
  return file
}

/** A scenario's provision payload — `dogfood/<name>.files/**` is copied
 *  verbatim into the scratch repo and committed, so a scenario can
 *  seed client wiring (`.claude/settings.local.json`, `.devinrc`, …)
 *  the runner needs before its first turn. */
export function scenarioFilesDir(dir: string, name: string): string | null {
  const clean = segment('scenario name', name).replace(/\.md$/, '')
  const home = join(dir, 'dogfood', `${clean}.files`)
  return existsSync(home) ? home : null
}

// --- run records ------------------------------------------------------------

type RunPhase = 'running' | 'analyzing' | 'done' | 'failed'

interface RunState {
  scenario: string
  phase: RunPhase
  /** Step bead in the scratch store — the runner's claim/registry key. */
  bead: string
  /** The scratch repo's path — under scratchRoot(), never inside the
   *  host tree (see provisionRepo). */
  repo: string
  runnerAgent?: string
  runnerBackend?: string
  analystAgent?: string
  analystBackend?: string
  /** --provider pin — the worker engine for both spawns; a backend
   *  stays the transport shell around whatever worker the provider
   *  resolves to. */
  provider?: string
  /** 'none' skips the analyst pass. */
  analyst: string
  createdAt: string
}

function runDir(dir: string, runId: string): string {
  const home = dogfoodHome(dir)
  if (home === null) {
    die('not inside a git worktree')
  }
  return join(home, segment('run id', runId))
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

/** Scratch parent — `$XDG_DATA_HOME/bro/dogfood` (same convention as
 *  sessionSlotsDir). NOT inside the run dir or anywhere in the host
 *  checkout: `bd init` walks ancestor directories for an existing
 *  .beads config and a scratch nested under the host would silently
 *  bootstrap from the host's beads remote instead of starting empty.
 *  Persistent (not /tmp) on purpose: run repos survive reboots like
 *  every other dogfood record, and on hosts where ~ is already a
 *  trusted workspace (devin's trusted_paths is prefix-based) the tree
 *  inherits workspace trust — `devin -p` refused /tmp scratch as
 *  untrusted on the first live run. */
function scratchRoot(): string {
  const xdg = process.env['XDG_DATA_HOME']
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'bro', 'dogfood')
}

/** A real bind on port 0 is the only collision-proof probe — the
 *  listener closes before handoff, so the picked port races nothing
 *  except another process in the same instant (ensure's repo+pid
 *  squat-refusal covers that residual). */
async function pickFreePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as { port: number }
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

/** `.files` is copied verbatim except `{{PORT}}`, which substitutes the
 *  run's own allocated port — a fixed port would let one run's detached
 *  serve squat the next run's listener slot. */
function copyProvision(src: string, dst: string, port: number): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyProvision(from, to, port)
    } else {
      // bytes, not utf8 — a binary or executable payload must survive
      // provisioning with its contents and its mode intact
      const buf = readFileSync(from)
      writeFileSync(
        to,
        buf.includes(PORT_MARKER) ? substitutePort(buf, port) : buf
      )
      chmodSync(to, statSync(from).mode)
    }
  }
}

const PORT_MARKER = Buffer.from('{{PORT}}')

/** `{{PORT}}` substitution at the byte level — marker spans are the
 *  only bytes a non-utf8 payload loses. */
function substitutePort(src: Buffer, port: number): Buffer {
  const pin = Buffer.from(String(port))
  const out: Buffer[] = []
  let off = 0
  for (;;) {
    const i = src.indexOf(PORT_MARKER, off)
    if (i < 0) {
      out.push(src.subarray(off))
      break
    }
    out.push(src.subarray(off, i), pin)
    off = i + PORT_MARKER.length
  }
  return Buffer.concat(out)
}

/** Provision the scratch repo — own git store, own stealth beads
 *  store; claims the runner makes never pollute the host's. `{{PORT}}`
 *  in `.files` payloads resolves to the run's freshly allocated port. */
async function provisionRepo(
  filesDir?: string | null
): Promise<{ repo: string; beads: string; initErr: string | null }> {
  const root = scratchRoot()
  mkdirSync(root, { recursive: true })
  const repo = mkdtempSync(join(root, 'run-'))
  const beads = join(repo, '.beads')
  execFileSync('git', ['init', '-q', '-b', 'main', repo]) // NOSONAR — PATH lookup is the contract
  // the scenario's own seed files land FIRST — a claude runner's
  // settings.local.json must exist before the runner's client reads it
  // on startup. The harness's config is written after so a scenario
  // can never ship its own bro.config.json over the SDD gate
  if (filesDir !== undefined && filesDir !== null) {
    copyProvision(filesDir, repo, await pickFreePort())
  }
  // arm SDD — a bare repo leaves sdd.mode 'off' and a scenario that
  // describes the gate would narrate a hook that cannot fire. Committed
  // so the runner starts from a clean tree (an uncommitted config would
  // itself trip the dirty-worktree stop-gate probe)
  writeFileSync(
    join(repo, 'bro.config.json'),
    `${JSON.stringify({ sdd: { mode: 'gate' } }, null, 2)}\n`
  )
  execFileSync('git', ['-C', repo, 'add', '-A']) // NOSONAR — PATH lookup is the contract
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

/** The spawn env for a run: host config plus the scratch repo's own
 *  provider entries. A payload's bro.config.local.json providers
 *  (CODEX_HOME/token wiring) must win over host layers — resolving
 *  providers from `dir` alone silently ignores the scenario's spawn
 *  template and the client falls back to ambient user setup. Only the
 *  scratch's own files count: the global layer inside a scratch load
 *  would shadow the host's project-level providers with user-global
 *  ones even when the payload defines nothing (greptile PRRT_…tr4Wn).
 *  The registry/`dir` side stays host-rooted so agentView keeps
 *  finding the spawned ids. */
function runEnv(dir: string, scratch: string): AgentConnectorEnv {
  const env = loadAgentEnv(dir)
  const providers = { ...(env.providers ?? {}) }
  let touched = false
  for (const l of loadConfigLayers(scratch).layers) {
    if (l.layer === 'global') continue
    const p = l.raw.providers
    if (typeof p !== 'object' || p === null) continue
    // per-field overlay onto the RESOLVED entry — a payload that sets
    // only `command` must not drop the `type` a global/host layer
    // supplied (greptile: raw copies break partial overrides)
    for (const [name, raw] of Object.entries(p)) {
      if (typeof raw !== 'object' || raw === null) continue
      providers[name] = { ...providers[name], ...raw } as ProviderEntry
      touched = true
    }
  }
  return touched ? { ...env, providers } : env
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
  // a null view means the registry pruned the entry — terminal for our
  // purposes: the runner cannot un-exit, so the run must not sit
  // 'running' forever on a dead lookup
  if (runner !== null && !TERMINAL.has(runner.state)) {
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
  // `<rdir>/advance.lock` serializes the check→spawn→write critical
  // section: two concurrent status calls would each pass the terminal
  // probe and spawn their OWN analyst — distinct bead ids, so registry
  // dedup never sees the collision. A held lock means another advancer
  // owns this run's outcome; return the record as-is.
  let release: () => void
  try {
    release = acquireFileLock(join(rdir, 'advance.lock'), {
      waitMs: 10_000,
      label: 'dogfood advance',
    })
  } catch (err) {
    if (err instanceof LockTimeout) {
      return state
    }
    throw err
  }
  try {
    // re-read inside the hold — a racing advancer may have closed it
    const fresh = readRun(rdir)
    if (fresh === null || fresh.phase !== 'running') {
      return fresh ?? state
    }
    const scenarioFile = join(rdir, 'scenario.md')
    const prompt = analystPrompt(scenarioFile, rdir, fresh.repo, fresh.runnerAgent)
    const promptFile = join(rdir, 'analyst.prompt.md')
    writeFileSync(promptFile, prompt)
    // 'same' means the runner's lane when recorded; an absent pin (a
    // pre-field run record) falls through to the default connector probe,
    // which names its own resolution failure — never a silent mystery
    const backend = fresh.analyst === 'same' ? fresh.runnerBackend : fresh.analyst
    try {
      // a step of its own — registry dedup keys on molStep, and the
      // runner's entry (dead or alive) must not collide with the
      // analyst's claim; both beads live in the scratch store
      const beads = join(fresh.repo, '.beads')
      const analystBead = taskStoreAt(beads).create({
        title: `dogfood analyst ${fresh.scenario} ${basename(rdir)}`,
        description: `Analyst pass of ${basename(rdir)} — verdict writer.`,
        // chore = harness bookkeeping — `bro spec check` exempts it;
        // task-type scaffolding beads turn every verdict ISSUES
        type: 'chore',
        priority: 2,
      })
      const info = await spawnStepAgent(dir, runEnv(dir, fresh.repo), {
        molStep: analystBead.id,
        worktree: fresh.repo,
        promptFile,
        connector: backend,
        beadsDir: beads,
        provider: fresh.provider,
      })
      fresh.analystAgent = info.id
      fresh.analystBackend = info.backend
      fresh.phase = 'analyzing'
    } catch (err) {
      fresh.phase = 'failed'
      writeRun(rdir, fresh)
      die(
        `analyst spawn failed for ${basename(rdir)}: ` +
          (err instanceof Error ? err.message : String(err))
      )
    }
    writeRun(rdir, fresh)
    return fresh
  } finally {
    release()
  }
}

// --- verbs ------------------------------------------------------------------

async function cmdRun(dir: string, argv: string[]): Promise<void> {
  const pos = positionals(argv, new Set(['--backend', '--analyst', '--provider']), {
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
  const provider = flag(argv, '--provider')
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

  // state.json fills in as provisioning lands — a failure at ANY stage
  // writes 'failed' so the run is discoverable (`status`/`report` can
  // name what died, cleanup can find `state.repo`) instead of leaving
  // an orphan run dir + scratch repo nobody records
  const state: RunState = {
    scenario: name,
    phase: 'failed',
    bead: '',
    repo: '',
    analyst,
    provider,
    createdAt: new Date().toISOString(),
  }
  let initErr: string | null = null
  let stage = 'provision'
  try {
    const prov = await provisionRepo(scenarioFilesDir(dir, name))
    initErr = prov.initErr
    state.repo = prov.repo

    // the step bead lives in the scratch store — the runner's claims
    // stay inside the disposable repo
    stage = 'bead'
    const bead = taskStoreAt(prov.beads).create({
      title: `dogfood ${name} ${runId}`,
      description: `Dogfood run ${runId} of scenario ${name} — runner claim.`,
      type: 'chore',
      priority: 2,
    })
    state.bead = bead.id

    stage = 'prompt'
    const promptFile = join(rdir, 'runner.prompt.md')
    writeFileSync(promptFile, runnerPrompt(prov.repo, readFileSync(src, 'utf8')))

    stage = 'spawn'
    state.phase = 'running'
    const info = await spawnStepAgent(dir, runEnv(dir, prov.repo), {
      molStep: bead.id,
      worktree: prov.repo,
      promptFile,
      connector: backend ?? undefined,
      provider,
      beadsDir: prov.beads,
      env: keep ? { BRO_DOGFOOD_KEEP: '1' } : undefined,
    })
    state.runnerAgent = info.id
    state.runnerBackend = info.backend
  } catch (err) {
    state.phase = 'failed'
    writeRun(rdir, state)
    die(
      `dogfood run ${stage} failed` +
        (initErr === null ? '' : ` (bd init also failed: ${initErr})`) +
        `: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  writeRun(rdir, state)
  console.log(
    `dogfood run ${runId} — runner ${state.runnerAgent} (${state.runnerBackend}) on ${state.repo}` +
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

/** A terminal run's scratch serve is litter — kill the recorded pid
 *  (serve.json is the same-UID credential that spawned it). Idempotent:
 *  status-driven, and the state file is retired so a repeated call can
 *  never re-signal a pid the OS has since recycled. */
function reapScratchServe(repo: string): void {
  // a run that failed before provisioning recorded '' — join('', …)
  // would resolve the CALLER's serve.json and kill its serve
  if (repo === '') return
  try {
    const statePath = join(repo, '.git', 'bro', 'serve.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pid?: number
      dir?: string
      url?: string
    }
    const pid = state.pid
    if (
      typeof pid === 'number' &&
      pid > 0 &&
      isRecordedServe(pid, repo, state)
    ) {
      try {
        process.kill(pid)
      } catch {
        /* raced the exit — the reap is done anyway */
      }
    }
    rmSync(statePath, { force: true })
  } catch {
    /* no serve.json — nothing was ever spawned */
  }
}

/** Identity before signaling: serve.json's pid may name a recycled,
 *  unrelated process. The spawned serve runs with cwd=repo, so the
 *  kernel's /proc link is the evidence; where /proc does not exist
 *  (macOS), the argv snapshot must carry this serve's own port. */
function isRecordedServe(
  pid: number,
  repo: string,
  state: { dir?: string; url?: string }
): boolean {
  if (
    state.dir !== undefined &&
    realpathSync(state.dir) !== realpathSync(repo)
  ) {
    return false
  }
  try {
    // a readable /proc answer is authoritative — a pid whose cwd names
    // another directory is not this scratch's serve, whatever argv says
    return readlinkSync(`/proc/${pid}/cwd`) === realpathSync(repo)
  } catch {
    /* /proc absent (macOS) or the pid is gone — try argv evidence */
  }
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { // NOSONAR — PATH lookup is the contract
      encoding: 'utf8',
    })
    const port = state.url?.match(/:(\d+)/)?.[1]
    return /\bserve\b/.test(args) && (port === undefined || args.includes(port))
  } catch {
    return false
  }
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
  // a settled run's listener is litter — reap by its own serve.json
  if (state.phase === 'done' || state.phase === 'failed') {
    reapScratchServe(state.repo)
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
