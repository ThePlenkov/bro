/** `bro goal` + hook-side evaluation (spec: specs/goal/bro-6vcll.md). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  goalContextLines,
  goalStatusLine,
  goalStopLines,
  readGoal,
  sessionGoal,
  runGoalCommand,
  type GoalRecord,
} from './goal.ts'

/** A bare `git init` worktree — goal state lands in its .git dir. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-goal-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function goalFile(dir: string, session: string): string {
  return join(dir, '.git', 'bro', 'hooks', 'goal', `${session}.json`)
}

function writeRaw(dir: string, session: string, rec: unknown): void {
  mkdirSync(join(dir, '.git', 'bro', 'hooks', 'goal'), { recursive: true })
  writeFileSync(goalFile(dir, session), JSON.stringify(rec))
}

const ACTIVE: GoalRecord = {
  condition: 'tests pass',
  status: 'active',
  createdAt: Date.now(),
  evals: 0,
  maxTurns: 5,
}

describe('readGoal/sessionGoal', () => {
  test('round-trip: written record reads back', () => {
    const dir = repo()
    writeRaw(dir, 's1', ACTIVE)
    const g = readGoal(dir, 's1')
    assert.equal(g?.condition, 'tests pass')
    assert.equal(g?.status, 'active')
    assert.equal(g?.maxTurns, 5)
  })

  test('no record → null; garbage record → null', () => {
    const dir = repo()
    assert.equal(readGoal(dir, 's1'), null)
    mkdirSync(join(dir, '.git', 'bro', 'hooks', 'goal'), { recursive: true })
    writeFileSync(goalFile(dir, 's1'), '{"condition":""}')
    assert.equal(readGoal(dir, 's1'), null)
  })

  test('seed materializes into the first session that evaluates it', () => {
    const dir = repo()
    writeRaw(dir, '_default', { ...ACTIVE, condition: 'empty bd ready' })
    const g = sessionGoal(dir, 'sess-A')
    assert.equal(g?.condition, 'empty bd ready')
    // materialized as the session's own copy — the seed is consumed
    assert.ok(existsSync(goalFile(dir, 'sess-A')))
    assert.equal(existsSync(goalFile(dir, '_default')), false)
    // a second session does NOT inherit it
    assert.equal(sessionGoal(dir, 'sess-B'), null)
  })

  test('session record wins over the seed', () => {
    const dir = repo()
    writeRaw(dir, 's1', { ...ACTIVE, condition: 'mine' })
    writeRaw(dir, '_default', { ...ACTIVE, condition: 'seed' })
    assert.equal(sessionGoal(dir, 's1')?.condition, 'mine')
  })
})

describe('goalStopLines', () => {
  test('no goal → no lines', async () => {
    const dir = repo()
    assert.deepEqual(await goalStopLines(dir, 's1', 'trace'), [])
  })

  test('active goal without judge → plain reminder', async () => {
    const dir = repo()
    writeRaw(dir, 's1', ACTIVE)
    const lines = await goalStopLines(dir, 's1', 'trace')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /goal: "tests pass"/)
    assert.match(lines[0]!, /bro goal clear/)
  })

  test('paused goal → resume hint; resolved goal → silence', async () => {
    const dir = repo()
    writeRaw(dir, 's1', { ...ACTIVE, status: 'paused' })
    assert.match((await goalStopLines(dir, 's1', 't'))[0]!, /paused goal/)
    writeRaw(dir, 's1', { ...ACTIVE, status: 'achieved' })
    assert.deepEqual(await goalStopLines(dir, 's1', 't'), [])
  })

  test('no session id → reminder only, never a judge call or a write', async () => {
    const dir = repo()
    writeRaw(dir, '_default', ACTIVE)
    const lines = await goalStopLines(dir, '', 'trace')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /goal: "tests pass"/)
  })
})

describe('goalContextLines', () => {
  test('active goal rehydrates; cleared does not', () => {
    const dir = repo()
    writeRaw(dir, 's1', ACTIVE)
    assert.match(goalContextLines(dir, 's1')[0]!, /goal \[active/)
    writeRaw(dir, 's1', { ...ACTIVE, status: 'cleared' })
    assert.deepEqual(goalContextLines(dir, 's1'), [])
  })

  test('no session → the repo seed still surfaces', () => {
    const dir = repo()
    writeRaw(dir, '_default', ACTIVE)
    assert.match(goalContextLines(dir, '')[0]!, /tests pass/)
  })
})

describe('runGoalCommand', () => {
  function inRepo(fn: () => void): void {
    const dir = repo()
    const prev = process.cwd()
    process.chdir(dir)
    try {
      fn()
    } finally {
      process.chdir(prev)
    }
  }

  function capture(fn: () => void): string {
    const out: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => out.push(a.join(' '))
    try {
      fn()
    } finally {
      console.log = orig
    }
    return out.join('\n')
  }

  test('set → status → clear lifecycle on the repo seed', () => {
    inRepo(() => {
      const env = { ...process.env }
      for (const k of ['BRO_SESSION_ID', 'DEVIN_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'OPENCODE_SESSION_ID']) {
        delete env[k]
      }
      process.env = env
      capture(() => runGoalCommand(['make', 'it', 'green', '--turns', '10']))
      const g = readGoal(process.cwd(), '_default')
      assert.equal(g?.condition, 'make it green')
      assert.equal(g?.maxTurns, 10)
      const st = capture(() => runGoalCommand([]))
      assert.match(st, /make it green/)
      capture(() => runGoalCommand(['clear']))
      assert.equal(readGoal(process.cwd(), '_default')?.status, 'cleared')
    })
  })

  test('--session pins the record to that session', () => {
    inRepo(() => {
      capture(() => runGoalCommand(['ship', 'it', '--session', 'abc123']))
      assert.equal(readGoal(process.cwd(), 'abc123')?.condition, 'ship it')
      assert.equal(readGoal(process.cwd(), '_default'), null)
    })
  })

  test('pause then resume resets evals', () => {
    inRepo(() => {
      capture(() => runGoalCommand(['work', '--session', 's9']))
      writeRaw(process.cwd(), 's9', { ...readGoal(process.cwd(), 's9'), evals: 7 })
      capture(() => runGoalCommand(['pause', '--session', 's9']))
      assert.equal(readGoal(process.cwd(), 's9')?.status, 'paused')
      capture(() => runGoalCommand(['resume', '--session', 's9']))
      const g = readGoal(process.cwd(), 's9')
      assert.equal(g?.status, 'active')
      assert.equal(g?.evals, 0)
    })
  })

  test('status on empty repo reports no goal', () => {
    inRepo(() => {
      assert.match(capture(() => runGoalCommand([])), /no goal set/)
    })
  })
})

describe('goalStatusLine', () => {
  test('renders status, budget, and last verdict', () => {
    const line = goalStatusLine({
      ...ACTIVE,
      evals: 3,
      lastVerdict: 'not_met',
      lastReason: 'keep going',
    })
    assert.match(line, /\[active/)
    assert.match(line, /turns 3\/5/)
    assert.match(line, /last: not_met — keep going/)
  })
})
