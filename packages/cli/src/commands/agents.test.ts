import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentPromptPath,
  loadAgentEnv,
  pidAlive,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import {
  readAgentRegistry,
  readLedgerWalls,
  recordWall,
  localLeaseStore,
  projectId,
  writeAgentRegistry,
  type Verdict,
} from '@broject/core'
import { readJournal, ROUTE_CLASS_KIND } from '@broject/judge'
import { fakeFetch } from '@broject/providers/testkit'
import { capture, initRepo, installFakeBd, readBeads } from './testrepo.ts'
import {
  collectDuplicateSuspects,
  discoverSessions,
  followLog,
  promptSimilar,
  runAgentsCommand,
  SpawnInputError,
  spawnStepAgent,
  tailLines,
} from './agents.ts'

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
 *  matches the fake's `tester` regardless of session env. installFakeBd
 *  also plants a healthy-empty docker stub — docker is a registered
 *  backend, and `down`/`status` claim 'gone' only on a healthy
 *  multi-backend read; an absent daemon would degrade the plane and
 *  flip every gone-verdict to 'unverified'. */
function fixture(rows: Array<Record<string, unknown>> = []): Fixture {
  const { root, main } = initRepo('bro-agents-')
  const beads = join(root, 'beads')
  mkdirSync(beads)
  // real bd treats BEADS_DIR as the store dir itself — a bare dir is an
  // empty store, so installFakeBd plants the shared db INSIDE the dir
  // --beads-dir pins (every resolution path lands on the same file)
  const { binDir, db } = installFakeBd(beads, rows)
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
      // the fleet line heads the table — empty registry, default cap 3
      assert.match(r.out[0]!, /fleet: 0\/3 agent slots occupied/)
      assert.match(r.out.join('\n'), /backend\s+supervisor\s+agent/)
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
      assert.match(table.out.join('\n'), /fleet: 1\/3 agent slots occupied/)
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
        occupancy: { occupied: number; maxConcurrent: number }
        backends: { name: string; capabilities: { supervisor: string } }[]
      }
      assert.equal(doc.backends[0]!.name, 'native')
      assert.equal(doc.backends[0]!.capabilities.supervisor, 'none')
      assert.deepEqual(doc.occupancy, { occupied: 0, maxConcurrent: 3 })

      const miss = await agents(['status', 'native-nope'])
      assert.equal(miss.code, 1)
      assert.match(miss.err.join('\n'), /no agent "native-nope"/)
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents prune', () => {
  test('reaps terminal entries; live and blocked ones stay', async () => {
    const fx = fixture()
    try {
      // spawnSync waits for the child's exit — its pid is verifiably dead
      const dead = spawnSync('true').pid!
      writeAgentRegistry(fx.main, {
        'fx-dead': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: dead,
          worktree: fx.main,
          exitStatus: 0,
        },
        'fx-live': {
          agentId: 'native-live',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
        },
        // wall-parked: rate_limited + a future resetAt reads 'blocked' —
        // respawn-able debt, prune must not touch it
        'fx-wall': {
          agentId: 'native-wall',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: dead,
          worktree: fx.main,
          exitStatus: 1,
          cause: 'rate_limited',
          resetAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
      const r = await agents(['prune'])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /reaped 1 — fx-dead/)
      assert.deepEqual(Object.keys(readAgentRegistry(fx.main)).sort(), ['fx-live', 'fx-wall'])
    } finally {
      fx.restore()
    }
  })

  test('--older-than reaps only entries past the age cutoff', async () => {
    const fx = fixture()
    try {
      const dead = spawnSync('true').pid!
      writeAgentRegistry(fx.main, {
        'fx-old': {
          agentId: 'native-old',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
          pid: dead,
          worktree: fx.main,
          exitStatus: 0,
        },
        'fx-new': {
          agentId: 'native-new',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: dead,
          worktree: fx.main,
          exitStatus: 0,
        },
      })
      const r = await agents(['prune', '--older-than', '7d'])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /reaped 1 — fx-old/)
      assert.deepEqual(Object.keys(readAgentRegistry(fx.main)), ['fx-new'])

      const bad = await agents(['prune', '--older-than', 'soon'])
      assert.equal(bad.code, 1)
      assert.match(bad.err.join('\n'), /--older-than takes <N>d/)
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

  test('spawn owns enter: no worktree → minted, claimed, spawned as one transition', async () => {
    // rig bro-oy3k1.4 — `agents up` performs enter+claim+spawn under the
    // registry lock; the old `no worktree` refusal is gone
    const fx = fixture([{ id: 'fx-1', status: 'open', title: 'step one' }])
    try {
      const r = await agents([
        'up', 'fx-1', '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      // the conventional sibling was minted on branch work/fx-1
      const wt = join(fx.root, 'main--fx-1')
      assert.ok(existsSync(wt), 'spawn minted the conventional worktree')
      assert.equal(
        spawnSync('git', ['-C', wt, 'branch', '--show-current']).stdout.toString().trim(),
        'work/fx-1'
      )
      // the claim landed and the registry pins the minted path
      assert.equal(readBeads(fx.db)[0]!.status, 'in_progress')
      assert.equal(readAgentRegistry(fx.main)['fx-1']!.worktree, wt)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('a foreign claim refuses before any worktree is minted', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'in_progress', assignee: 'other-actor' }])
    try {
      const r = await agents([
        'up', 'fx-1', '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /claimed outside the agent registry/)
      assert.equal(
        existsSync(join(fx.root, 'main--fx-1')),
        false,
        'refusal must not leave a half-entered worktree'
      )
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

// spec bro-fqen0 — the ad-hoc front door: a phantom adhoc-<hex> step,
// no bead, no claim, same spawn machinery underneath
describe('bro agents run', () => {
  test('positional prompt spawns an adhoc agent — registry row, no bead litter', async () => {
    const fx = fixture([])
    try {
      const r = await agents([
        'run', LONG_RUN, '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const m = /agent native-[0-9a-f]+ running for (adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      assert.ok(m, `expected the adhoc spawn report, got: ${r.out.join('\n')}`)
      const step = m![1]!
      const entry = readAgentRegistry(fx.main)[step]!
      assert.equal(entry.backend, 'native')
      // the literal prompt reached the worker's prompt file verbatim
      const stored = agentPromptPath(fx.main, String(entry.agentId))!
      assert.equal(readFileSync(stored, 'utf8'), LONG_RUN)
      // phantom step — the store saw nothing: no bead, no claim
      assert.equal(readBeads(fx.db).length, 0)
      const stop = await agents(['down', step])
      assert.equal(stop.code, 0)
    } finally {
      fx.restore()
    }
  })

  test('--prompt-file spawns through the same path', async () => {
    const fx = fixture([])
    try {
      const r = await agents([
        'run', '--prompt-file', fx.promptFile(LONG_RUN),
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      assert.ok(m)
      await agents(['down', m![1]!])
    } finally {
      fx.restore()
    }
  })

  test('no prompt is a usage error, not a silent spawn', async () => {
    const fx = fixture([])
    try {
      const r = await agents(['run', '--worktree', fx.main, '--beads-dir', fx.beads])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /run requires a prompt/)
      assert.equal(Object.keys(readAgentRegistry(fx.main)).length, 0)
    } finally {
      fx.restore()
    }
  })

  test('positional text and --prompt are the same channel', async () => {
    const fx = fixture([])
    try {
      const r = await agents(['run', 'x', '--prompt', 'y'])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /same channel/)
    } finally {
      fx.restore()
    }
  })

  test('prompt and --prompt-file stay mutually exclusive', async () => {
    const fx = fixture([])
    try {
      const r = await agents([
        'run', '--prompt', 'x', '--prompt-file', fx.promptFile(LONG_RUN),
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /mutually exclusive/)
    } finally {
      fx.restore()
    }
  })
})

// spec bro-7dila — the dedup guard: `--for` binds an ad-hoc spawn to a
// bead's claim (every `up` guard then applies), and a same-repo live
// agent/session with a near-identical prompt earns an advisory warning
describe('bro agents run — --for claim dedup', () => {
  test('run --for on an open bead spawns keyed by the bead and claims it', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const r = await agents([
        'run', LONG_RUN, '--for', 'fx-1',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /agent native-[0-9a-f]+ running for fx-1/)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.backend, 'native')
      assert.equal(readBeads(fx.db)[0]!.status, 'in_progress')
      const stored = agentPromptPath(fx.main, String(entry.agentId))!
      assert.equal(readFileSync(stored, 'utf8'), LONG_RUN)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('a second run --for on a live agent refuses', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      const first = await agents([
        'run', '--for', 'fx-1', '--prompt-file', fx.promptFile(LONG_RUN),
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(first.code, 0, first.err.join('\n'))
      const again = await agents([
        'run', '--for', 'fx-1', '--prompt', 'same goal again',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(again.code, 1)
      assert.match(again.err.join('\n'), /already has a live agent/)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('a bead claimed outside the registry refuses', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'in_progress', assignee: 'other-actor' }])
    try {
      const r = await agents([
        'run', '--for', 'fx-1', '--prompt', 'x',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /claimed outside the agent registry/)
    } finally {
      fx.restore()
    }
  })

  test('run --for with no prompt renders the bead text', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', title: 'my title', description: 'my desc' }])
    try {
      const r = await agents([
        'run', '--for', 'fx-1',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const entry = readAgentRegistry(fx.main)['fx-1']!
      const stored = agentPromptPath(fx.main, String(entry.agentId))!
      assert.equal(readFileSync(stored, 'utf8'), '# my title\n\nmy desc')
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('run --for on a missing bead fails — no phantom fallback', async () => {
    const fx = fixture([])
    try {
      const r = await agents([
        'run', '--for', 'fx-nope', '--prompt', 'x',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /fx-nope/)
    } finally {
      fx.restore()
    }
  })

  test('run --for on a missing adhoc-prefixed id still fails — the phantom hatch is closed', async () => {
    const fx = fixture([])
    try {
      const r = await agents([
        'run', '--for', 'adhoc-deadbeef', '--prompt', 'x',
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /adhoc-deadbeef/)
      assert.equal(r.out.filter((l) => /running for/.test(l)).length, 0)
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents run — similarity floor', () => {
  /** A fake devin session: a lock named `<name>` holding this process's
   *  pid, plus a fake /proc whose `<pid>/cwd` symlink answers the
   *  session's checkout. `agentId` pins BRO_AGENT_ID into the fake
   *  environ — the row a bro-spawned worker would produce. The
   *  fixture's config is rewritten to point agents.devin at both. */
  const fakeDevinSession = (fx: Fixture, name: string, cwd: string, agentId?: string): void => {
    const lockDir = join(fx.root, 'devin-locks')
    const procDir = join(fx.root, 'proc')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, `${name}.lock`), String(process.pid))
    const procPid = join(procDir, String(process.pid))
    mkdirSync(join(procPid, 'fd'), { recursive: true })
    symlinkSync(cwd, join(procPid, 'cwd'))
    if (agentId !== undefined) {
      writeFileSync(join(procPid, 'environ'), `PATH=/x\0BRO_AGENT_ID=${agentId}\0`)
    }
    writeFileSync(
      join(fx.main, 'bro.config.json'),
      JSON.stringify({
        agents: {
          native: { command: 'node {promptFile}' },
          devin: { lockDir, procDir },
        },
      })
    )
  }

  test('a same-repo session with a near-identical title warns; the spawn lands', async () => {
    const fx = fixture([])
    try {
      fakeDevinSession(
        fx,
        'visible-claude-background-tasks-via-devin-acp',
        fx.main
      )
      // LONG_RUN + a trailing comment: `node {promptFile}` needs runnable
      // text, the comment carries the tokens similarity compares
      const r = await agents([
        'run', `${LONG_RUN} // show visible claude background tasks via devin acp`,
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.err.join('\n'), /warning: possible duplicate — session "visible-claude-background-tasks-via-devin-acp"/)
      assert.match(r.out.join('\n'), /agent native-[0-9a-f]+ running for adhoc-/)
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      await agents(['down', m![1]!])
    } finally {
      fx.restore()
    }
  })

  test('a session in a different repo does not warn', async () => {
    const fx = fixture([])
    const other = initRepo('bro-agents-other-')
    try {
      fakeDevinSession(
        fx,
        'visible-claude-background-tasks-via-devin-acp',
        other.main
      )
      const r = await agents([
        'run', `${LONG_RUN} // show visible claude background tasks via devin acp`,
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.equal(
        r.err.filter((l) => /possible duplicate/.test(l)).length,
        0,
        `unexpected duplicate warning: ${r.err.join('\n')}`
      )
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      await agents(['down', m![1]!])
    } finally {
      rmSync(other.root, { recursive: true, force: true })
      fx.restore()
    }
  })

  test('a live registry agent with an overlapping stored prompt warns', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      writeAgentRegistry(fx.main, {
        'fx-1': {
          agentId: 'native-aa11',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
        },
      })
      const prompt = agentPromptPath(fx.main, 'native-aa11')!
      mkdirSync(dirname(prompt), { recursive: true })
      writeFileSync(prompt, 'render the devin session transcripts live')
      const r = await agents([
        'run', `${LONG_RUN} // render devin session transcripts readable live`,
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.err.join('\n'), /possible duplicate — agent native-aa11 for fx-1/)
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      await agents(['down', m![1]!])
    } finally {
      fx.restore()
    }
  })

  test('dissimilar prompts warn on nothing', async () => {
    const fx = fixture([])
    try {
      fakeDevinSession(fx, 'visible-claude-background-tasks-via-devin-acp', fx.main)
      const r = await agents([
        'run', `${LONG_RUN} // prune the stale git worktrees under tmp`,
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.equal(r.err.filter((l) => /possible duplicate/.test(l)).length, 0)
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      await agents(['down', m![1]!])
    } finally {
      fx.restore()
    }
  })

  test('a dead registry entry warns on nothing — terminal rows are not work in flight', async () => {
    const fx = fixture([])
    try {
      const dead = spawnSync('true').pid!
      writeAgentRegistry(fx.main, {
        'fx-1': {
          agentId: 'native-dead',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: dead,
          worktree: fx.main,
          exitStatus: 0,
        },
      })
      const prompt = agentPromptPath(fx.main, 'native-dead')!
      mkdirSync(dirname(prompt), { recursive: true })
      writeFileSync(prompt, 'render the devin session transcripts live')
      const suspects = collectDuplicateSuspects(fx.main, {
        agents: {},
        connectors: {},
      } as AgentConnectorEnv)
      assert.equal(suspects.length, 0)
    } finally {
      fx.restore()
    }
  })

  test('a pid-less registry row suspects only inside the spawn-handoff window', () => {
    const fx = fixture([])
    try {
      const prompt = (id: string): void => {
        const p = agentPromptPath(fx.main, id)!
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, 'render the devin session transcripts live')
      }
      prompt('native-stale')
      prompt('native-fresh')
      writeAgentRegistry(fx.main, {
        // mid-spawn — the pid lands within seconds of the entry
        'fx-fresh': {
          agentId: 'native-fresh',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          worktree: fx.main,
        },
        // hours old, no pid ever recorded — a crashed spawn's remnant
        'fx-stale': {
          agentId: 'native-stale',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 3_600_000).toISOString(),
          worktree: fx.main,
        },
      })
      const env = { agents: {}, connectors: {} } as AgentConnectorEnv
      assert.deepEqual(
        collectDuplicateSuspects(fx.main, env).map((s) => s.label),
        ['agent native-fresh for fx-fresh']
      )
      // and the --for target's own row is never its own suspect
      assert.deepEqual(
        collectDuplicateSuspects(fx.main, env, { excludeStep: 'fx-fresh' }),
        []
      )
    } finally {
      fx.restore()
    }
  })

  test('a live agent with an unreadable stored prompt still suspects via its session title', async () => {
    const fx = fixture([])
    try {
      // registry says live (our pid) but native-noprompt.prompt.md is
      // absent — the seenAgents mark must not swallow the session row
      fakeDevinSession(
        fx,
        'render-devin-session-transcripts-live',
        fx.main,
        'native-noprompt'
      )
      writeAgentRegistry(fx.main, {
        'fx-9': {
          agentId: 'native-noprompt',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
        },
      })
      const r = await agents([
        'run', `${LONG_RUN} // render devin session transcripts readable`,
        '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.err.join('\n'), /possible duplicate — session "render-devin-session-transcripts-live"/)
      const m = /(adhoc-[0-9a-f]+)/.exec(r.out.join('\n'))
      await agents(['down', m![1]!])
    } finally {
      fx.restore()
    }
  })

  test('run --for on a dead agent warns against its stored prompt, not the bead text', async () => {
    const fx = fixture([
      { id: 'fx-2', status: 'open', title: 'unrelated zeta eta theta' },
    ])
    try {
      fakeDevinSession(
        fx,
        'render-devin-session-transcripts-live',
        fx.main
      )
      // the dead agent's stored prompt is what the respawn reuses —
      // the advisory must compare THAT, not the bead's title
      writeAgentRegistry(fx.main, {
        'fx-2': {
          agentId: 'native-old',
          backend: 'native',
          spawnedAt: new Date(Date.now() - 3_600_000).toISOString(),
          exitStatus: 1,
          worktree: fx.main,
        },
      })
      const stored = agentPromptPath(fx.main, 'native-old')!
      mkdirSync(dirname(stored), { recursive: true })
      writeFileSync(stored, `${LONG_RUN} // render devin session transcripts readable`)
      const r = await agents([
        'run', '--for', 'fx-2', '--worktree', fx.main, '--beads-dir', fx.beads,
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.err.join('\n'), /possible duplicate — session "render-devin-session-transcripts-live"/)
      assert.match(r.out.join('\n'), /running for fx-2/)
      await agents(['down', 'fx-2'])
    } finally {
      fx.restore()
    }
  })

  test('promptSimilar: overlap coefficient with the shared-token floor', () => {
    assert.equal(
      promptSimilar('visible claude background tasks', 'visible claude background tasks via devin acp'),
      true
    ) // containment — the shorter set is fully shared
    assert.equal(promptSimilar('a b c d e', 'a b c f g'), true) // 3/5 = 0.6 — the boundary
    assert.equal(promptSimilar('a b c d e f', 'a b c x y z'), false) // 3/6 = 0.5 — under it
    assert.equal(promptSimilar('fix', 'fix'), false) // below the 3-shared floor
    assert.equal(promptSimilar('a b c d', 'a b e f'), false) // 2 shared — under the floor
    assert.equal(promptSimilar('ship the convoy', 'refactor the parser'), false)
  })
})

// the provider vocabulary (spec bro-5hx1.1) — --provider/--model/
// --profile resolve through config into the spawned worker's env pins
// and the registry's provenance
describe('bro agents up — provider resolution', () => {
  /** The fixture's config plus a providers registry + fleet profiles. */
  const withProviders = (fx: Fixture): void => {
    writeFileSync(
      join(fx.main, 'bro.config.json'),
      JSON.stringify({
        agents: { native: { command: 'node {promptFile}' } },
        providers: {
          // {model} — the fixture honors overrides; a verbatim cli
          // command would refuse a pin it can't consume
          local: { type: 'cli', command: 'node {promptFile} -m {model}' },
          typesafe: {
   type: 'api',
   baseUrl: 'https://api.typesafe.ai',
   apiKeyEnv: 'K',
   models: { ['jev']: 'systemone' },
 },
        },
        fleet: {
          profiles: {
            cheap: { provider: 'local', model: 'cheap-1' },
          },
        },
      })
    )
  }

  test('--provider + --model pin provenance through registry + status', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withProviders(fx)
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
        '--provider', 'local', '--model', 'm1',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /provider: local · model m1/)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.provider, 'local')
      assert.equal(entry.model, 'm1')
      const st = await agents(['status', 'fx-1'])
      assert.match(st.out.join('\n'), /provider\s+local/)
      assert.match(st.out.join('\n'), /model\s+m1/)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('--profile expands the preset; explicit flags beat it piecewise', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withProviders(fx)
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
        '--profile', 'cheap', '--model', 'm2',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.provider, 'local')
      assert.equal(entry.model, 'm2') // flag beat the preset's cheap-1
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('unknown --provider/--profile fail as input; a non-spawnable kind as config', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withProviders(fx)
      const args = (extra: string[]) => [
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
        ...extra,
      ]
      const badProvider = await agents(args(['--provider', 'nope']))
      assert.equal(badProvider.code, 1)
      assert.match(badProvider.err.join('\n'), /providers\.nope is not configured/)
      const badProfile = await agents(args(['--profile', 'nope']))
      assert.equal(badProfile.code, 1)
      assert.match(badProfile.err.join('\n'), /fleet\.profiles\.nope is not configured/)
      const wrongKind = await agents(args(['--provider', 'typesafe']))
      assert.equal(wrongKind.code, 1)
      assert.match(wrongKind.err.join('\n'), /type 'api'.*no spawn surface/)
      // nothing claimed or spawned through any of the refusals
      assert.equal(readAgentRegistry(fx.main)['fx-1'], undefined)
    } finally {
      fx.restore()
    }
  })
})

// the routing vocabulary (spec bro-1x7p M2) — fleet.routing resolves
// the class lane → chain[0] provider; the lane rides the registry as
// provenance, never a vendor field
describe('bro agents up — class routing', () => {
  /** withProviders' registry plus a routing table. */
  const withRouting = (fx: Fixture): void => {
    writeFileSync(
      join(fx.main, 'bro.config.json'),
      JSON.stringify({
        agents: { native: { command: 'node {promptFile}' } },
        providers: {
          local: {
            type: 'cli',
            command: 'node {promptFile} -m {model}',
            account: 'local-account',
          },
          alt: { type: 'cli', command: 'node {promptFile}' },
        },
        fleet: {
          routing: {
            default: { chain: ['alt'] },
            sweep: { chain: [{ provider: 'local', model: 'sweep-1' }] },
          },
        },
      })
    )
  }

  test('a `class:<name>` bead label routes to chain[0]; the registry records the lane', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', labels: ['class:sweep'] }])
    try {
      withRouting(fx)
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.match(r.out.join('\n'), /provider: local · model sweep-1/)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, 'sweep')
      assert.equal(entry.provider, 'local')
      assert.equal(entry.account, 'local-account')
      assert.equal(entry.model, 'sweep-1')
      const st = await agents(['status', 'fx-1'])
      assert.match(st.out.join('\n'), /class\s+sweep/)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('--class beats the label; an undeclared class is a config error naming it', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', labels: ['class:sweep'] }])
    try {
      withRouting(fx)
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN), '--class', 'default',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, 'default')
      assert.equal(entry.provider, 'alt') // default's chain head
      await agents(['down', 'fx-1'])

      const bad = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN), '--class', 'ghost',
      ])
      assert.equal(bad.code, 1)
      assert.match(bad.err.join('\n'), /fleet\.routing has no class "ghost"/)
    } finally {
      fx.restore()
    }
  })

  test('an explicit provider override drops the routed chain’s model pin', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      // default's chain head pins a model — --provider picks another
      // provider entirely, and its own default model applies instead
      writeFileSync(
        join(fx.main, 'bro.config.json'),
        JSON.stringify({
          agents: { native: { command: 'node {promptFile}' } },
          providers: {
            local: { type: 'cli', command: 'node {promptFile} -m {model}' },
            alt: { type: 'cli', command: 'node {promptFile} -m {model}', model: 'alt-default' },
          },
          fleet: {
            routing: { default: { chain: [{ provider: 'local', model: 'sweep-1' }] } },
          },
        })
      )
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN), '--provider', 'alt',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.provider, 'alt')
      assert.equal(entry.model, 'alt-default') // alt's own default, NOT the local lane's pin
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('declared routing + unclassed bead resolves `default`; --provider still outranks the chain head', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withRouting(fx)
      const r = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN), '--provider', 'local', '--model', 'm9',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, 'default') // lane pinned even under an explicit provider
      assert.equal(entry.provider, 'local')
      assert.equal(entry.model, 'm9')
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents up — fleet.router (spec bro-1x7p M7)', () => {
  /** Routing table + an api router provider; spawn seams inject fetch. */
  const ORCA_TYPED = {
    type: 'api',
    baseUrl: 'https://orca.test',
    apiKeyEnv: 'ORCA_TEST_KEY',
    models: { 'jev-1.0': 'systemone' },
  }
  const ORCA_PROSE = {
    type: 'api',
    baseUrl: 'https://orca.test',
    apiKeyEnv: 'ORCA_TEST_KEY',
    models: { 'qwen3-coder': 'openai-compat' },
  }

  const withRouter = (fx: Fixture, mode: string, orca: Record<string, unknown>): void => {
    writeFileSync(
      join(fx.main, 'bro.config.json'),
      JSON.stringify({
        agents: { native: { command: 'node {promptFile}' } },
        providers: {
          local: { type: 'cli', command: 'node {promptFile} -m {model}' },
          alt: { type: 'cli', command: 'node {promptFile}' },
          orca,
        },
        fleet: {
          routing: {
            default: { chain: ['alt'] },
            sweep: { chain: [{ provider: 'local', model: 'sweep-1' }] },
          },
          router: { provider: 'orca', mode },
        },
      })
    )
  }

  /** A systemone-wire typed reply picking `choice` at `confidence`. */
  const typedReply = (choice: string, confidence: number) => ({
    status: 200,
    body: {
      model: 'jev-1.0',
      answers: { class: { type: 'choice', choice, probabilities: {}, confidence } },
    },
  })

  const spawn = (
    fx: Fixture,
    req: Partial<Parameters<typeof spawnStepAgent>[2]> = {},
    opts: Parameters<typeof spawnStepAgent>[3] = {}
  ) =>
    spawnStepAgent(
      fx.main,
      loadAgentEnv(fx.main),
      {
        molStep: 'fx-1',
        worktree: fx.main,
        beadsDir: fx.beads,
        promptFile: fx.promptFile(LONG_RUN),
        ...req,
      },
      opts
    )

  const withKey = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.ORCA_TEST_KEY
    process.env.ORCA_TEST_KEY = 'test-key'
    try {
      await fn()
    } finally {
      if (prev === undefined) {
        delete process.env.ORCA_TEST_KEY
      } else {
        process.env.ORCA_TEST_KEY = prev
      }
    }
  }

  const routeRows = (fx: Fixture): Verdict[] =>
    readJournal(fx.main).filter(
      (r): r is Verdict => 'questions' in r && r.kind === ROUTE_CLASS_KIND
    )

  test('shadow journals the verdict beside the resolved class — the spawn stands on it', async () => {
    const fx = fixture([
      { id: 'fx-1', status: 'open', title: 'sweep the ledger', description: 'tidy' },
    ])
    try {
      withRouter(fx, 'shadow', ORCA_TYPED)
      await withKey(async () => {
        const { fetch, calls } = fakeFetch(typedReply('sweep', 0.95))
        await spawn(fx, {}, { fetch })
        assert.equal(calls.length, 1)
        assert.match(calls[0]!.url, /orca\.test\/v1\/systemone$/)
        const entry = readAgentRegistry(fx.main)['fx-1']!
        assert.equal(entry.class, 'default') // the pick journals, nothing else
        assert.equal(entry.provider, 'alt')
        const v = routeRows(fx)[0]!
        assert.equal(v.subject.threadId, 'fx-1')
        assert.equal(v.outcome, 'default')
        const a = v.answers['class']!
        assert.equal(a.type, 'choice')
        if (a.type === 'choice') {
          assert.equal(a.choice, 'sweep')
        }
        await agents(['down', 'fx-1'])
      })
    } finally {
      fx.restore()
    }
  })

  test('enforce re-resolves a confident declared pick — the spawn lands on ITS chain head', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', title: 'quick sweep' }])
    try {
      withRouter(fx, 'enforce', ORCA_TYPED)
      await withKey(async () => {
        const { fetch } = fakeFetch(typedReply('sweep', 0.95))
        await spawn(fx, {}, { fetch })
        const entry = readAgentRegistry(fx.main)['fx-1']!
        assert.equal(entry.class, 'sweep')
        assert.equal(entry.provider, 'local') // sweep's chain head, not default's
        assert.equal(entry.model, 'sweep-1')
        assert.equal(routeRows(fx)[0]!.outcome, 'sweep')
        await agents(['down', 'fx-1'])
      })
    } finally {
      fx.restore()
    }
  })

  test('enforce with a dimmed answer keeps the resolved class', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', title: 'x' }])
    try {
      withRouter(fx, 'enforce', ORCA_TYPED)
      await withKey(async () => {
        const { fetch } = fakeFetch(typedReply('sweep', 0.1)) // under judge.confidence (0.6)
        await spawn(fx, {}, { fetch })
        const entry = readAgentRegistry(fx.main)['fx-1']!
        assert.equal(entry.class, 'default')
        assert.equal(entry.provider, 'alt')
        assert.equal(routeRows(fx)[0]!.outcome, 'default')
        await agents(['down', 'fx-1'])
      })
    } finally {
      fx.restore()
    }
  })

  test('enforce on a prose-grade provider is a config error naming provider + mode', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withRouter(fx, 'enforce', ORCA_PROSE)
      await assert.rejects(
        () => spawn(fx),
        (e: unknown) =>
          e instanceof Error &&
          /fleet\.router\.provider "orca".*prose-grade.*enforce/.test(e.message) &&
          // rejected before any spawn — the registry stays empty
          Object.keys(readAgentRegistry(fx.main)).length === 0
      )
    } finally {
      fx.restore()
    }
  })

  test('a classed step never consults the router — no call, label wins', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open', labels: ['class:sweep'] }])
    try {
      withRouter(fx, 'enforce', ORCA_TYPED)
      const { fetch, calls } = fakeFetch(typedReply('default', 0.99))
      await spawn(fx, {}, { fetch })
      assert.equal(calls.length, 0)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, 'sweep')
      assert.equal(entry.provider, 'local')
      assert.equal(routeRows(fx).length, 0)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('an explicit --class skips the router the same way', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withRouter(fx, 'enforce', ORCA_TYPED)
      const { fetch, calls } = fakeFetch(typedReply('sweep', 0.99))
      await spawn(fx, { class: 'default' }, { fetch })
      assert.equal(calls.length, 0)
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, 'default')
      assert.equal(entry.provider, 'alt')
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })

  test('JudgeUnavailable is "no verdict" — warn and stand on the resolved class', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      withRouter(fx, 'enforce', ORCA_TYPED)
      await withKey(async () => {
        const { fetch } = fakeFetch({ status: 500, body: {} })
        const r = await capture(() => spawn(fx, {}, { fetch }))
        assert.match(r.err.join('\n'), /fleet\.router\.provider "orca".*class "default" stands/)
        const entry = readAgentRegistry(fx.main)['fx-1']!
        assert.equal(entry.class, 'default')
        assert.equal(entry.provider, 'alt')
        await agents(['down', 'fx-1'])
      })
    } finally {
      fx.restore()
    }
  })

  test('router off + absent routing: the static path is untouched', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    try {
      writeFileSync(
        join(fx.main, 'bro.config.json'),
        JSON.stringify({
          agents: { native: { command: 'node {promptFile}' } },
          providers: { orca: ORCA_TYPED },
          fleet: { router: { provider: 'orca', mode: 'enforce' } }, // no routing table
        })
      )
      const { fetch, calls } = fakeFetch(typedReply('sweep', 0.99))
      await spawn(fx, {}, { fetch })
      assert.equal(calls.length, 0) // no table → no resolution → no router
      const entry = readAgentRegistry(fx.main)['fx-1']!
      assert.equal(entry.class, undefined)
      await agents(['down', 'fx-1'])
    } finally {
      fx.restore()
    }
  })
})

describe('bro agents down <target>', () => {
  test('down updates the local entry without clearing a host ledger wall', async () => {
    const fx = fixture([{ id: 'fx-1', status: 'open' }])
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = join(fx.root, 'state')
    try {
      recordWall({
        account: 'shared-account',
        cause: 'quota',
        observedAt: new Date().toISOString(),
        provider: 'router',
        rig: 'other-repo',
        step: 'fx-1',
      })
      const up = await agents([
        'up', 'fx-1', '--worktree', fx.main, '--beads-dir', fx.beads,
        '--prompt-file', fx.promptFile(LONG_RUN),
      ])
      assert.equal(up.code, 0)
      const down = await agents(['down', 'fx-1'])
      assert.equal(down.code, 0)
      assert.equal(localLeaseStore(projectId(fx.main)).forceRelease('bead/fx-1'), false)
      assert.equal(readLedgerWalls().some((wall) => wall.account === 'shared-account'), true)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      fx.restore()
    }
  })

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

describe('discoverSessions', () => {
  const envFor = (lockDir: string): AgentConnectorEnv => ({
    agents: { devin: { lockDir } },
    connectors: {},
  })

  test('session-plane rows arrive tagged with the kind that saw them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-disc-'))
    try {
      writeFileSync(join(dir, 'sess.lock'), String(process.pid))
      const { sessions, degraded } = discoverSessions(envFor(dir))
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0]!.kind, 'devin')
      assert.equal(sessions[0]!.name, 'sess')
      assert.equal(sessions[0]!.pid, process.pid)
      assert.deepEqual(degraded, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a plane whose scan throws degrades to a note — the read stays up', () => {
    // a lockDir that is a FILE — readdirSync fails ENOTDIR, the plane's
    // fail-closed contract throws 'unavailable'
    const root = mkdtempSync(join(tmpdir(), 'bro-disc-bad-'))
    const file = join(root, 'notdir')
    try {
      writeFileSync(file, 'x')
      const { sessions, degraded } = discoverSessions(envFor(file))
      assert.deepEqual(sessions, [])
      assert.equal(degraded.length, 1)
      assert.match(degraded[0]!, /^devin: /)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('bro agents log', () => {
  /** Registry entry with a real log file — the `log` key is
   *  connector-private and rides the registry untyped into AgentInfo. */
  const seedLoggedAgent = (fx: Fixture, lines = 5) => {
    const log = join(fx.root, 'agent.log')
    writeFileSync(log, Array.from({ length: lines }, (_, i) => `line-${i + 1}`).join('\n') + '\n')
    writeAgentRegistry(fx.main, {
      'fx-1': {
        agentId: 'native-aa11',
        backend: 'native',
        spawnedAt: new Date().toISOString(),
        pid: process.pid,
        worktree: fx.main,
        log,
      },
    })
    return log
  }

  /** capture() hooks console.* — the log tail rides process.stdout.write
   *  for byte fidelity, so these tests hook stdout themselves. */
  const captureStdout = async <T>(fn: () => Promise<T>): Promise<{ ret: T; text: string }> => {
    const orig = process.stdout.write.bind(process.stdout)
    const chunks: string[] = []
    process.stdout.write = ((c: string | Uint8Array) => {
      chunks.push(String(c))
      return true
    }) as typeof process.stdout.write
    try {
      return { ret: await fn(), text: chunks.join('') }
    } finally {
      process.stdout.write = orig
    }
  }

  test('prints the tail by ref; --lines bounds the replay, --lines 0 prints nothing', async () => {
    const fx = fixture()
    try {
      const log = seedLoggedAgent(fx)
      const r = await captureStdout(() => agents(['log', 'fx-1']))
      assert.equal(r.ret.code, 0)
      assert.match(r.text, /line-1\n(.*\n)*line-5\n$/)
      assert.match(r.ret.err.join('\n'), new RegExp(`agent native-aa11 \\(running\\) — ${log}`))

      const two = await captureStdout(() => agents(['log', 'native-aa11', '--lines', '2']))
      assert.equal(two.ret.code, 0)
      assert.equal(two.text, 'line-4\nline-5\n')

      const none = await captureStdout(() => agents(['log', 'fx-1', '--lines', '0']))
      assert.equal(none.ret.code, 0)
      assert.equal(none.text, '')
    } finally {
      fx.restore()
    }
  })

  test('misses are named, never invented — unknown ref, no recorded log, reaped file', async () => {
    const fx = fixture()
    try {
      const miss = await agents(['log', 'native-nope'])
      assert.equal(miss.code, 1)
      assert.match(miss.err.join('\n'), /no agent "native-nope"/)

      writeAgentRegistry(fx.main, {
        'fx-bare': {
          agentId: 'native-bare',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
        },
      })
      const bare = await agents(['log', 'fx-bare'])
      assert.equal(bare.code, 1)
      assert.match(bare.err.join('\n'), /agent native-bare has no recorded log/)

      const gone = join(fx.root, 'gone.log')
      writeAgentRegistry(fx.main, {
        'fx-gone': {
          agentId: 'native-gone',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
          log: gone,
        },
      })
      const reaped = await agents(['log', 'fx-gone'])
      assert.equal(reaped.code, 1)
      assert.match(reaped.err.join('\n'), /log missing:.*gone\.log — reaped or never written/)

      // a remote backend's attach pointer (copilot sessionUrl) is not
      // a filesystem path — name it, never a 'reaped' misreport
      writeAgentRegistry(fx.main, {
        'fx-remote': {
          agentId: 'native-rr1',
          backend: 'native',
          spawnedAt: new Date().toISOString(),
          pid: process.pid,
          worktree: fx.main,
          log: 'https://github.com/org/repo/copilot/session/x',
        },
      })
      const remote = await agents(['log', 'fx-remote'])
      assert.equal(remote.code, 1)
      assert.match(remote.err.join('\n'), /agent native-rr1's log is remote/)
    } finally {
      fx.restore()
    }
  })

  test('tailLines keeps a trailing partial line and the n bound', () => {
    assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc\n')
    assert.equal(tailLines('a\nb\nc', 2), 'b\nc') // died mid-write — no invented newline
    assert.equal(tailLines('a\nb\n', 0), '')
    assert.equal(tailLines('', 5), '')
    assert.equal(tailLines('a\n', 50), 'a\n')
  })

  test('followLog emits appends, reports truncation, and rides remove/reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-log-follow-'))
    let handle: ReturnType<typeof followLog> | undefined
    try {
      const log = join(root, 'a.log')
      writeFileSync(log, 'one\n')
      const data: string[] = []
      const notes: string[] = []
      handle = followLog(
        log,
        { data: (s) => data.push(s), note: (s) => notes.push(s) },
        { pollMs: 15, startOffset: 4 }
      )
      const until = async (pred: () => boolean) => {
        for (let i = 0; i < 100 && !pred(); i += 1) {
          await sleep(10)
        }
        assert.ok(pred(), 'followLog never reached the expected state')
      }
      appendFileSync(log, 'two\nthree\n')
      await until(() => data.join('').includes('three'))
      assert.equal(data.join(''), 'two\nthree\n')

      // janitor tail-cap: file shrinks under the offset — marker + resync from 0
      writeFileSync(log, 'cap\n')
      await until(() => notes.some((n) => n.includes('truncated')))
      await until(() => data.join('').includes('cap'))
      assert.ok(data.join('').includes('cap\n'))

      // reaped then respawned on the same path — notes both ways, offset resets
      unlinkSync(log)
      await until(() => notes.some((n) => n.includes('removed')))
      writeFileSync(log, 'reborn\n')
      await until(() => notes.some((n) => n.includes('reopened')))
      await until(() => data.join('').includes('reborn'))

      handle?.stop()
      const drained = data.length
      appendFileSync(log, 'after-stop\n')
      await sleep(60)
      assert.equal(data.length, drained)
    } finally {
      handle?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

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
