/**
 * `bro goal` — session-scoped completion goals (spec:
 * specs/goal/bro-6vcll.md). Codex's "persisted thread objective" +
 * Claude's `/goal` lifecycle, keyed to bro's session state instead of a
 * vendor runtime.
 *
 *   bro goal <condition…>   set/replace — [--session <id>] [--turns N]
 *   bro goal                status — condition, status, age, evals, verdict
 *   bro goal pause|resume   suspend / reactivate (resume resets evals)
 *   bro goal clear          resolve (aliases: stop, off, reset, none, cancel)
 *                           [--json] everywhere
 *
 * State: `<git-common-dir>/bro/hooks/goal/<session>.json` — a `goal/`
 * SUBDIR of the hooks state dir, never flat: readArmed scans
 * `<session>.*` files as gate aspects, so a flat `<session>.goal` would
 * arm a phantom aspect on every goal write (same rule as hinted/,
 * trace/, perf/).
 *
 * Session resolution: `--session` > env (BRO_SESSION_ID, DEVIN_SESSION_ID,
 * CLAUDE_SESSION_ID, CODEX_SESSION_ID, OPENCODE_SESSION_ID) > the repo
 * seed `_default` — what a bare-shell `bro goal` writes, materialized as
 * the NEXT session's goal when its hook first evaluates it.
 *
 * Verdicts are advisory — the stop hook injects context, never
 * `decision: block` (judge shadow contract; gates not loops).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { JudgeAnswer } from '@broject/core'
import { appendRow, judgeConfig, judgeFacade } from '@broject/judge'
import { loadBroConfig } from '../plugins.ts'
import type { GoalConfig } from './goal-config.ts'

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'achieved'
  | 'impossible'
  | 'budget'
  | 'cleared'

export interface GoalRecord {
  condition: string
  status: GoalStatus
  createdAt: number
  /** Stop-hook evaluations run against this goal (judged turns only). */
  evals: number
  /** Turn budget — 0 = no cap. */
  maxTurns: number
  lastVerdict?: 'met' | 'not_met' | 'impossible'
  lastReason?: string
  resolvedAt?: number
}

/** The repo-level seed — `bro goal` on a bare shell writes here; the
 *  next session's hook materializes it as that session's goal. */
const SEED = '_default'

const SESSION_ENV = [
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const

/** `<git-common-dir>/bro/hooks/goal` — sibling of the arming markers,
 *  shared across linked worktrees so a goal set in one worktree is
 *  visible to the session running in another. Null outside a git dir. */
function goalDir(dir: string): string | null {
  try {
    const gd = execFileSync('git', ['rev-parse', '--git-common-dir'], { // NOSONAR
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // rev-parse answers relative to the CWD it ran in — resolve against
    // `dir` so callers (tests, hooks in worktrees) get an absolute path
    return gd ? join(isAbsolute(gd) ? gd : resolve(dir, gd), 'bro', 'hooks', 'goal') : null
  } catch {
    return null
  }
}

const safe = (id: string): string => id.replace(/[^\w.-]/g, '_')

function goalPath(dir: string, session: string): string | null {
  const d = goalDir(dir)
  return d ? join(d, `${safe(session)}.json`) : null
}

export function readGoal(dir: string, session: string): GoalRecord | null {
  const path = goalPath(dir, session)
  if (path === null || !existsSync(path)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoalRecord>
    if (typeof raw.condition !== 'string' || raw.condition === '') {
      return null
    }
    return {
      condition: raw.condition,
      status: (typeof raw.status === 'string' ? raw.status : 'active') as GoalStatus,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      evals: typeof raw.evals === 'number' ? raw.evals : 0,
      maxTurns: typeof raw.maxTurns === 'number' ? raw.maxTurns : 0,
      ...(raw.lastVerdict !== undefined ? { lastVerdict: raw.lastVerdict } : {}),
      ...(raw.lastReason !== undefined ? { lastReason: raw.lastReason } : {}),
      ...(raw.resolvedAt !== undefined ? { resolvedAt: raw.resolvedAt } : {}),
    }
  } catch {
    return null
  }
}

function writeGoal(dir: string, session: string, goal: GoalRecord): void {
  const path = goalPath(dir, session)
  if (path === null) {
    throw new Error('not inside a git worktree — goal state needs the common git dir')
  }
  mkdirSync(goalDir(dir)!, { recursive: true }) // NOSONAR — goalPath proved non-null
  writeFileSync(path, `${JSON.stringify(goal, null, 2)}\n`, 'utf8')
}

/** This session's goal — materializing the repo seed when no session
 *  record exists yet (the seed is a template, not shared mutable state:
 *  every session gets its own eval counter). */
export function sessionGoal(dir: string, sessionId: string): GoalRecord | null {
  const own = readGoal(dir, sessionId)
  if (own !== null || sessionId === SEED) {
    return own
  }
  const seed = readGoal(dir, SEED)
  if (seed !== null && sessionId !== '') {
    try {
      writeGoal(dir, sessionId, {
        ...seed,
        evals: 0,
        lastVerdict: undefined,
        lastReason: undefined,
        resolvedAt: undefined,
      })
      rmSync(goalPath(dir, SEED)!, { force: true }) // NOSONAR — writeGoal proved non-null
      return sessionGoal(dir, sessionId)
    } catch {
      // a failed materialization still serves the seed read-only —
      // the next session retries the copy
      return seed
    }
  }
  return seed
}

function goalConfig(dir: string): GoalConfig {
  try {
    return (loadBroConfig(dir) as Record<string, unknown>).goal as GoalConfig
  } catch {
    return { maxTurns: 25, judge: true }
  }
}

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) {
    return 'just now'
  }
  if (m < 60) {
    return `${m}m`
  }
  return `${Math.round(m / 60)}h`
}

/** One-line status — the CLI's `bro goal` readout and the hook's
 *  session-start rehydration share it. */
export function goalStatusLine(goal: GoalRecord): string {
  const budget = goal.maxTurns > 0 ? `${goal.evals}/${goal.maxTurns}` : `${goal.evals}`
  const tail =
    goal.lastVerdict !== undefined && goal.status === 'active'
      ? ` · last: ${goal.lastVerdict}${goal.lastReason ? ` — ${goal.lastReason}` : ''}`
      : ''
  return `goal [${goal.status} · ${fmtAge(Date.now() - goal.createdAt)} · turns ${budget}]: "${goal.condition}"${tail}`
}

/** The stop-hook evaluation — returns context lines, never a block.
 *  With the judge resolvable it asks once per stop: met clears the
 *  goal, impossible clears it, not_met spends a turn of the budget.
 *  Anything unverifiable degrades to the plain reminder — a wedged
 *  judge must never stall a session. */
export async function goalStopLines(
  dir: string,
  sessionId: string,
  evidence: { trace: string; context?: string | Promise<string | undefined> }
): Promise<string[]> {
  const goal = sessionGoal(dir, sessionId)
  if (goal === null) {
    return []
  }
  if (goal.status === 'paused') {
    return [`paused goal: "${goal.condition}" — \`bro goal resume\` reactivates`]
  }
  if (goal.status !== 'active') {
    return []
  }
  const cfg = goalConfig(dir)
  const jcfg = judgeConfig(dir).judge
  // provider-mode AND legacy connector-mode judge configs both resolve
  // through judgeFacade — a facade that cannot actually serve throws in
  // decide() and lands in the fail-open reminder below
  const judged = cfg.judge && jcfg.mode !== 'off' && sessionId !== ''
  if (!judged) {
    return [
      `goal: "${goal.condition}" — verify it before reporting done ` +
        '(`bro goal` shows status · `bro goal clear` resolves)',
    ]
  }
  try {
    const res = await judgeFacade(dir).decide(
      {
        goal: goal.condition,
        // the trace journal is metadata (tool/command/paths/ok), not
        // output — the session context text carries the checkable
        // surface (bd state, gate, tree) the verdict needs
        trace: evidence.trace.slice(-8000),
        context: (await evidence.context)?.slice(-8000),
      },
      {
        verdict: {
          type: 'choice',
          instructions:
            'An agent session is working toward this completion condition. Judge the ' +
            'conversation evidence (tool trace) against it. "met" = the condition is ' +
            'demonstrably satisfied by surfaced evidence (test output, clean tree, landed ' +
            'artifact) — belief is not evidence. "not_met" = still reachable, work ' +
            'continues. "impossible" = no defensible path remains under current limits.',
          criteria: {
            met: 'condition satisfied by concrete evidence in the trace',
            not_met: 'evidence absent or incomplete but the path is still open',
            impossible: 'the condition can never be satisfied — blocker named',
          },
        },
      }
    )
    const answer = res.answers.verdict as JudgeAnswer | undefined
    if (answer === undefined || answer.type !== 'choice' || res.lowConfidence.includes('verdict')) {
      throw new Error('no confident verdict')
    }
    // the decide() round-trip is async — re-read before writing so a
    // `bro goal clear`/replace landing mid-eval is not clobbered by the
    // stale snapshot's verdict
    const fresh = sessionGoal(dir, sessionId)
    if (fresh === null || fresh.createdAt !== goal.createdAt || fresh.status !== 'active') {
      return []
    }
    goal.lastVerdict = answer.choice as GoalRecord['lastVerdict']
    goal.evals += 1
    try {
      appendRow(dir, {
        ts: new Date().toISOString(),
        kind: 'goal-verdict',
        subject: { threadId: sessionId || undefined },
        questions: {},
        answers: res.answers,
        model: res.model,
        latencyMs: res.latencyMs,
        ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
      })
    } catch {
      // the journal is a nicety, not the verdict
    }
    if (answer.choice === 'met') {
      goal.status = 'achieved'
      goal.resolvedAt = Date.now()
      writeGoal(dir, sessionId, goal)
      return [`◎ goal met: "${goal.condition}" (${goal.evals} turns) — cleared`]
    }
    if (answer.choice === 'impossible') {
      goal.status = 'impossible'
      goal.resolvedAt = Date.now()
      writeGoal(dir, sessionId, goal)
      return [
        `goal judged impossible: "${goal.condition}" — cleared; ` +
          'report the blocker or set a new goal',
      ]
    }
    if (goal.maxTurns > 0 && goal.evals >= goal.maxTurns) {
      goal.status = 'budget'
      goal.resolvedAt = Date.now()
      writeGoal(dir, sessionId, goal)
      return [
        `goal turn budget reached (${goal.evals}/${goal.maxTurns}): "${goal.condition}" ` +
          '— paused; `bro goal resume` continues, `bro goal clear` drops it',
      ]
    }
    writeGoal(dir, sessionId, goal)
    return [
      `goal turn ${goal.evals}${goal.maxTurns > 0 ? `/${goal.maxTurns}` : ''} — not yet met: ` +
        `"${goal.condition}" — keep going (\`bro goal clear\` resolves it)`,
    ]
  } catch {
    return [
      `goal: "${goal.condition}" — verify it before reporting done ` +
        '(`bro goal` shows status · `bro goal clear` resolves)',
    ]
  }
}

/** Session-start/post-compaction line — Claude's resume-restores-goal,
 *  from a file so it survives compaction and session death alike. */
export function goalContextLines(dir: string, sessionId: string): string[] {
  const goal = sessionId !== '' ? sessionGoal(dir, sessionId) : readGoal(dir, SEED)
  if (goal === null || (goal.status !== 'active' && goal.status !== 'paused')) {
    return []
  }
  return [goalStatusLine(goal)]
}

// --- CLI -----------------------------------------------------------------------

function sessionFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const k of SESSION_ENV) {
    const v = env[k]?.trim()
    if (v) {
      return v
    }
  }
  return undefined
}

const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

interface GoalArgs {
  /** --session > env > undefined (repo seed target). */
  session?: string
  /** --turns override — undefined keeps the config default. */
  turns?: number
  asJson: boolean
  /** Non-flag argv after consuming --session/--turns values. */
  positional: string[]
}

function parseGoalArgs(argv: string[]): GoalArgs {
  const si = argv.indexOf('--session')
  const ti = argv.indexOf('--turns')
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`error: ${flag} requires a value`)
      process.exit(2)
    }
    return v
  }
  let turns: number | undefined
  if (ti >= 0) {
    const n = Number(valueOf(ti, '--turns'))
    if (!Number.isInteger(n) || n < 0) {
      console.error(`error: --turns expects a non-negative integer — got ${JSON.stringify(argv[ti + 1])}`)
      process.exit(2)
    }
    turns = n
  }
  const valueIdx = new Set([si, ti].filter((i) => i >= 0).map((i) => i + 1))
  return {
    session: si >= 0 ? valueOf(si, '--session') : sessionFromEnv(process.env),
    turns,
    asJson: argv.includes('--json'),
    positional: argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i)),
  }
}

function printStatus(goal: GoalRecord | null, session: string, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ session, goal }, null, 2))
    return
  }
  console.log(goal === null ? 'no goal set' : goalStatusLine(goal))
}

function report(target: string, goal: GoalRecord, asJson: boolean, text: string): void {
  if (asJson) {
    console.log(JSON.stringify({ session: target, goal }, null, 2))
    return
  }
  console.log(text)
}

export function runGoalCommand(argv: string[]): void {
  const dir = process.cwd()
  const { session, turns, asJson, positional } = parseGoalArgs(argv)
  const target = session ?? SEED
  const verb = positional[0]
  // a session-scoped verb binds the session's materialized goal — the
  // seed is consumed, not left behind to re-seed the next session
  const verbGoal = () => (session === undefined ? readGoal(dir, SEED) : sessionGoal(dir, target))

  if (verb !== undefined && CLEAR_ALIASES.has(verb)) {
    const goal = verbGoal()
    if (goal === null) {
      console.log('No goal set')
      return
    }
    goal.status = 'cleared'
    goal.resolvedAt = Date.now()
    writeGoal(dir, target, goal)
    report(target, goal, asJson, `Goal cleared: ${goal.condition}`)
    return
  }
  if (verb === 'pause' || verb === 'resume') {
    const goal = verbGoal()
    if (goal === null) {
      console.log('No goal set')
      return
    }
    goal.status = verb === 'pause' ? 'paused' : 'active'
    if (verb === 'resume') {
      goal.evals = 0
      goal.resolvedAt = undefined
    }
    writeGoal(dir, target, goal)
    report(target, goal, asJson, `goal ${verb}d: "${goal.condition}"`)
    return
  }
  if (verb === 'status' || verb === undefined) {
    printStatus(verbGoal(), target, asJson)
    return
  }

  const condition = positional.join(' ')
  if (condition.length > 4000) {
    console.error('error: goal condition is capped at 4000 characters')
    process.exit(2)
  }
  const goal: GoalRecord = {
    condition,
    status: 'active',
    createdAt: Date.now(),
    evals: 0,
    maxTurns: turns ?? goalConfig(dir).maxTurns,
  }
  writeGoal(dir, target, goal)
  report(
    target,
    goal,
    asJson,
    `goal set (${target === SEED ? 'repo — binds to next session' : `session ${target.slice(0, 12)}`}): ` +
      `"${condition}"${goal.maxTurns > 0 ? ` · ${goal.maxTurns} turns` : ''}`
  )
}
