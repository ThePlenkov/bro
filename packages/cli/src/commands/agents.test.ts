import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPromptPath, pidAlive, type AgentConnectorEnv } from '../agent-connectors.ts'
import { readAgentRegistry, writeAgentRegistry } from '@broject/core'
import { initRepo, installFakeBd, readBeads } from './testrepo.ts'
import { runAgentsCommand, SpawnInputError, spawnStepAgent } from './agents.ts'

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`)
  }
}

/** Capture console + intercept process.exit — die()/usage() exit 1/2. */
async function capture(
  fn: () => Promise<unknown>
): Promise<{ code: number; out: string[]; err: string[] }> {
  const origExit = process.exit
  const origLog = console.log
  const origErr = console.error
  const out: string[] = []
  const err: string[] = []
  console.log = (...a: unknown[]) => out.push(a.join(' '))
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0)
  }) as typeof process.exit
  try {
    await fn()
    return { code: 0, out, err }
  } catch (e) {
    if (e instanceof Exit) {
      return { code: e.code, out, err }
    }
    throw e
  } finally {
    process.exit = origExit
    console.log = origLog
    console.error = origErr
  }
}

interface Fixture {
  root: string
  main: string
  db: string
  beads: string
  promptFile(program: string): string
  restore(): void
}

/** Real git repo as cwd + fake bd on PATH + agents.native.command
 *  (`node {promptFile}` — the prompt IS the program). `rows` seeds the
 *  fake beads store; `--beads-dir` args point at beads/ (the fake bd
 *  keys off FAKE_BD_DB, but the dir must exist — bdActor shells out
 *  with it as cwd). BEADS_ACTOR is pinned so the rebind-actor check
 *  matches the fake's `tester` regardless of session env. */
function fixture(rows: Array<Record<string, unknown>> = []): Fixture {
  const { root, main } = initRepo('bro-agents-')
  const { binDir, db } = installFakeBd(root, rows)
  const beads = join(root, 'beads')
  mkdirSync(beads)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({ agents: { native: { command: 'node {promptFile}' } } })
  )
  const prev = {
    cwd: process.cwd(),
    PATH: process.env.PATH ?? '',
    FAKE_BD_DB: process.env.FAKE_BD_DB,
    BEADS_ACTOR: process.env.BEADS_ACTOR,
    // ambient repo/store pins from an outer agent session (GIT_DIR,
    // BEADS_DIR, BRO_*) would redirect the in-process connector's git
    // lookups into the outer repo — scrub them like testrepo's git()
    scrubbed: {} as Record<string, string | undefined>,
  }
  for (const k of Object.keys(process.env)) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|BEADS_DIR|BRO_)/.test(k)) {
      prev.scrubbed[k] = process.env[k]
      delete process.env[k]
    }
  }
  process.env.PATH = `${binDir}:${prev.PATH}`
  process.env.FAKE_BD_DB = db
  process.env.BEADS_ACTOR = 'tester'
  process.chdir(main)
  return {
    root,
    main,
    db,
    beads,
    promptFile(program: string) {
      const f = join(root, `prompt-${Math.random().toString(36).slice(2)}.js`)
      writeFileSync(f, program)
      return f
    },
    restore() {
      // detached agents outlive a failed assertion — kill whatever the
      // registry still points at before the tmpdir (and it) goes away
      try {
        for (const e of Object.values(readAgentRegistry(main))) {
          // tests register pid: process.pid to fake 'running' — if this
          // process led its own group, kill(-pid) would kill the runner
          if (typeof e.pid === 'number' && e.pid > 0 && e.pid !== process.pid && e.pid !== process.ppid) {
            try {
              process.kill(-e.pid, 'SIGKILL') // detached → own process group
            } catch {
              // already gone
            }
          }
        }
      } catch {
        // no readable registry — nothing spawned
      }
      process.chdir(prev.cwd)
      process.env.PATH = prev.PATH
      for (const [k, v] of [
        ['FAKE_BD_DB', prev.FAKE_BD_DB],
        ['BEADS_ACTOR', prev.BEADS_ACTOR],
      ] as const) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
      for (const [k, v] of Object.entries(prev.scrubbed)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) {
      return
    }
    await sleep(50)
  }
  assert.ok(fn(), 'condition did not hold within budget')
}

const agents = (argv: string[]) => capture(() => runAgentsCommand(argv))

const LONG_RUN = 'setTimeout(() => {}, 30000)'

describe('bro agents — dispatch', () => {
  test('no subcommand and unknown subcommand print usage, exit 2', async () => {
    const fx = fixture()
    try {
      const bare = await agents([])
      assert.equal(bare.code, 2)
      assert.match(bare.err.join('\n'), /usage:/)
      const bad = await agents(['bogus'])
      assert.equal(bad.code, 2)
      assert.match(bad.err.join('\n'), /unknown agents subcommand "bogus"/)
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents status', () => {
  test('empty registry renders the backend row with no agents', async () => {
    const fx = fixture()
    try {
      const r = await agents(['status'])
      assert.equal(r.code, 0)
      assert.match(r.out[0]!, /backend\s+supervisor\s+agent/)
      assert.match(r.out.join('\n'), /native\s+none/)
    } finally {
      fx.restore()
    }
  })

  test('a registered agent lists under its backend; <id> prints detail', async () => {
    const fx = fixture()
    try {
      // process.pid is verifiably alive → the entry reads 'running'
      writeAgentRegistry(fx.main, {
        'fx-1': {
          agentId: 'native-aa11',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
        },
      })
      const table = await agents(['status'])
      assert.equal(table.code, 0)
      assert.match(table.out.join('\n'), /native-aa11\s+fx-1\s+running/)

      const detail = await agents(['status', 'native-aa11'])
      assert.equal(detail.code, 0)
      assert.match(detail.out.join('\n'), /agent\s+native-aa11/)
      assert.match(detail.out.join('\n'), /state\s+running/)

      const byStep = await agents(['status', 'fx-1'])
      assert.match(byStep.out.join('\n'), /agent\s+native-aa11/)
    } finally {
      fx.restore()
    }
  })

  test('--json emits the backend plane; unknown target exits 1', async () => {
    const fx = fixture()
    try {
      const r = await agents(['status', '--json'])
      assert.equal(r.code, 0)
      const doc = JSON.parse(r.out.join('\n')) as {
        backends: { name: string; capabilities: { supervisor: string } }[]
      }
      assert.equal(doc.backends[0]!.name, 'native')
      assert.equal(doc.backends[0]!.capabilities.supervisor, 'none')

      const miss = await agents(['status', 'native-nope'])
      assert.equal(miss.code, 1)
      assert.match(miss.err.join('\n'), /no agent "native-nope"/)
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents up|down — supervisor verb', () => {
  test("native's 'none' supervisor is a reported no-op, not an error", async () => {
    const fx = fixture()
    try {
      const up = await agents(['up'])
      assert.equal(up.code, 0)
      assert.match(up.out.join('\n'), /supervisor 'none'.*nothing to up/)
      const down = await agents(['down'])
      assert.equal(down.code, 0)
      assert.match(down.out.join('\n'), /supervisor 'none'.*nothing to down/)
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents up <step>', () => {
  test('an empty prompt is bad input, not a silent spawn', async () => {
    // the HTTP API can send prompt:"" — the CLI flag parser can't — so
    // the guard lives in spawnStepAgent, not in either front door
    const env = { agents: {}, connectors: {} } as AgentConnectorEnv
    for (const prompt of ['', '   ']) {
      assert.throws(
        () => spawnStepAgent('/nonexistent', env, { molStep: 'fx-1', prompt }),
        SpawnInputError
      )
    }
  })

  test('spawns the step agent: claim lands, registry + prompt written', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /agent native-[0-9a-f]+ running for fx-1 \(native pid \d+\)/)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.backend, 'native')
      assert.equal(entry.worktree, fx.main)
      // the claim landed in the shared store
      assert.equal(readBeads(fx.db)[0]!.status, 'in_progress')
      // spawn-time prompt persisted beside the registry
      const stored = agentPromptPath(fx.main, String(entry.agentId))!
      assert.equal(readFileSync(stored, 'utf8'), LONG_RUN)
      const stop = await agents(['down', 'fx-1'])
      assert.equal(stop.code, 0)
    } finally {
      fx.restore()
    }
  })

  test('no worktree names the fix instead of guessing', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const r = await agents(['up', 'fx-1', '--beads-dir', fx.beads])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /no worktree for fx-1.*bro work enter fx-1/)
    } finally {
      fx.restore()
    }
  })

  test('a live agent on the step refuses a second spawn', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      // --prompt-file, not the bead text: `node {promptFile}` runs the
      // prompt as a program, and the rendered `# fx-1\n\n…` bead text is
      // a SyntaxError — the child would die before the dedup check
      const first = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(first.code, 0, first.err.join('\n'))
      const again = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(again.code, 1)
      assert.match(again.err.join('\n'), /already has a live agent/)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('respawn after death reuses agentId and the stored prompt', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', description: 'BEAD-TEXT' }])
    try {
      const first = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile('process.exit(0)'),
      ])
      assert.equal(first.code, 0)
      const entry1 = readAgentRegistry(fx.main)['fx-1']!
      await until(() => !pidAlive(entry1.pid as number))
      // status() lazily harvests the .exit file → the entry reads exited
      const status = await agents(['status', String(entry1.agentId)])
      assert.match(status.out.join('\n'), /state\s+exited/)

      // respawn WITHOUT --prompt-file — the stored prompt wins over the
      // bead text, and the agentId survives the process
      const second = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(second.code, 0, second.err.join('\n'))
      const entry2 = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry2.agentId, entry1.agentId)
      const stored = agentPromptPath(fx.main, String(entry1.agentId))!
      assert.equal(readFileSync(stored, 'utf8'), 'process.exit(0)')
      await until(() => !pidAlive(entry2.pid as number))
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents down <target>', () => {
  test('stops by molStep and is idempotent for gone agents', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const up = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(up.code, 0)
      const agentId = readAgentRegistry(fx.main)['fx-1']!.agentId

      const down = await agents(['down', 'fx-1'])
      assert.equal(down.code, 0)
      assert.match(down.out.join('\n'), new RegExp(`stopped ${String(agentId)}`))
      const st = await agents(['status', 'fx-1'])
      assert.match(st.out.join('\n'), /state\s+(stopped|lost)/)

      const gone = await agents(['down', 'fx-9'])
      assert.equal(gone.code, 0)
      assert.match(gone.out.join('\n'), /nothing to stop/)
    } finally {
      fx.restore()
    }
  })

  test("a status() that drops the pid renders 'unknown' in the respawn note", async () => {
    // a respawn between list() and status() reuses the agentId with a new
    // handle — but a connector can also just stop reporting a pid; the
    // note must not print "pid 4242 → undefined" (bro-8ltl)
    const { registerAgentConnector } = await import('../agent-connectors.ts')
    let stopped = ''
    const agent = {
      id: 'ag-1',
      molStep: 'fx-1',
      backend: 'flaky-pid-agents-test',
      state: 'running' as const,
      pid: 4242,
    }
    const dispose = registerAgentConnector('flaky-pid-agents-test', () => ({
      name: 'flaky-pid-agents-test',
      spawn: () => Promise.reject(new Error('unused')),
      list: () => Promise.resolve({ agents: [agent] }),
      // the handle drops out entirely — optional-field exactness means
      // an explicit `pid: undefined` isn't the shape we're testing
      status: () => {
        const { pid: _dropped, ...rest } = agent
        return Promise.resolve(rest)
      },
      stop: (id: string) => {
        stopped = id
        return Promise.resolve()
      },
      capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' as const }),
    }))
    const fx = fixture()
    try {
      const r = await agents(['down', 'ag-1', '--connector', 'flaky-pid-agents-test'])
      assert.equal(r.code, 0)
      assert.match(r.err.join('\n'), /respawned since lookup \(pid 4242 → unknown\)/)
      assert.equal(stopped, 'ag-1')
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('extra positionals are usage errors', async () => {
    const fx = fixture()
    try {
      const r = await agents(['up', 'a', 'b'])
      assert.equal(r.code, 2)
    } finally {
      fx.restore()
    }
  })
})

// registers LAST — the connector registry is module-global, so the
// throwing factory must not exist while earlier tests resolve connectors
describe('bro agents — degraded backends', () => {
  test('a degraded backend cannot confirm gone — down fails loudly', async () => {
    const { registerAgentConnector } = await import('../agent-connectors.ts')
    registerAgentConnector('explody-agents-test', () => {
      throw new Error('backend exploded')
    })
    const fx = fixture()
    try {
      const r = await agents(['down', 'fx-9'])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /backend\(s\) degraded:.*explody-agents-test.*backend exploded/)
      // and the read side still renders the healthy backend's table
      const st = await agents(['status'])
      assert.equal(st.code, 0)
      assert.match(st.out.join('\n'), /native\s+none/)
      assert.match(st.err.join('\n'), /backend degraded — explody-agents-test/)
    } finally {
      fx.restore()
    }
  })
})
