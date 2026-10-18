/** `bro self dogfood` — run provisioning, the lazy status-advance to
 *  the analyst, and the report surface. The runner/analyst are scripted
 *  through a registered test connector — spawnStepAgent supplies the
 *  registry/claim mechanics, the connector scripts what "running the
 *  scenario" means (the analyst writes verdict.md where its prompt
 *  points). */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { AgentNotFound, testGit } from '@broject/core'
import type { AgentInfo, SpawnSpec } from '@broject/core'
import { registerAgentConnector } from '../agent-connectors.ts'
import { listScenarios, runDogfoodCommand } from './dogfood.ts'
import { capture, initRepo, installFakeBd, scrubEnv } from './testrepo.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const dogfood = (argv: string[]) => capture(() => runDogfoodCommand(argv))

/** Scripted backend: records spawn specs (the shape spawnStepAgent
 *  hands the connector — prompt is resolved TEXT, not a file),
 *  reports a controllable agent state per id, and — when the prompt
 *  is the analyst's — writes the verdict file the prompt names. */
function dogfoodConnector() {
  const spawned: SpawnSpec[] = []
  const states = new Map<string, AgentInfo>()
  let seq = 0
  const name = 'dogfood-test'
  const conn = {
    name,
    spawn: (spec: SpawnSpec) => {
      spawned.push(spec)
      seq += 1
      const isAnalyst = spec.prompt.includes('ANALYST of a bro dogfood run')
      const info: AgentInfo = {
        id: `${name}-${seq}`,
        molStep: spec.molStep,
        backend: name,
        state: 'running',
        worktree: spec.repoRoot,
      }
      if (isAnalyst) {
        const target = /verdict to (\S+)/.exec(spec.prompt)?.[1]
        if (target !== undefined) {
          writeFileSync(target, 'verdict: PASS\n- scenario accomplished its intent\n')
        }
        info.state = 'exited'
      }
      states.set(info.id, info)
      return Promise.resolve(info)
    },
    list: () => Promise.resolve({ agents: [...states.values()] }),
    status: (id: string) => {
      const info = states.get(id)
      if (info === undefined) {
        return Promise.reject(new AgentNotFound(id))
      }
      return Promise.resolve(info)
    },
    stop: (id: string) => {
      const info = states.get(id)
      if (info !== undefined) {
        info.state = 'stopped'
      }
      return Promise.resolve()
    },
    capabilities: () => ({ attach: false, respawn: true, supervisor: 'none' as const }),
  }
  return { conn, spawned, states }
}

function fixture() {
  const { root, main } = initRepo('bro-dogfood-')
  const { binDir, db } = installFakeBd(root, [])
  const prev = {
    cwd: process.cwd(),
    PATH: process.env.PATH ?? '',
    FAKE_BD_DB: process.env.FAKE_BD_DB,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  }
  const unscrub = scrubEnv()
  process.env.PATH = `${binDir}:${prev.PATH}`
  process.env.FAKE_BD_DB = db
  // scratch repos land under $XDG_DATA_HOME/bro/dogfood — point XDG at
  // the fixture root so runs never touch the real share dir
  const xdg = join(root, 'xdg')
  process.env.XDG_DATA_HOME = xdg
  process.chdir(main)
  mkdirSync(join(main, 'dogfood'))
  writeFileSync(
    join(main, 'dogfood', 'smoke.md'),
    '# smoke scenario\n\n1. run `bro status`\n\n## Assert\n\n- nothing broke\n'
  )
  return {
    root,
    main,
    xdg,
    restore() {
      // scratch repos live under the fixture's XDG root — reaped with
      // root itself; nothing extra to clean
      process.chdir(prev.cwd)
      process.env.PATH = prev.PATH
      if (prev.FAKE_BD_DB === undefined) {
        delete process.env.FAKE_BD_DB
      } else {
        process.env.FAKE_BD_DB = prev.FAKE_BD_DB
      }
      if (prev.XDG_DATA_HOME === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME
      }
      unscrub()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function runsOf(main: string): string[] {
  const home = join(main, '.git', 'bro', 'dogfood')
  return existsSync(home) ? readdirSync(home).sort() : []
}

function rdirOf(main: string): string {
  return join(main, '.git', 'bro', 'dogfood', runsOf(main)[0]!)
}

function stateOf(rdir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rdir, 'state.json'), 'utf8')) as Record<string, unknown>
}

describe('bro self dogfood', () => {
  test('scenarios lists committed dogfood/*.md', async () => {
    const fx = fixture()
    try {
      const r = await dogfood(['scenarios'])
      assert.equal(r.code, 0)
      assert.deepEqual(r.out, ['smoke'])
      assert.deepEqual(listScenarios(fx.main), ['smoke'])
    } finally {
      fx.restore()
    }
  })

  test('run provisions a scratch repo, spawns the runner, records state', async () => {
    const fx = fixture()
    const { conn, spawned } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      const r = await dogfood(['run', 'smoke', '--backend', 'dogfood-test'])
      assert.equal(r.code, 0, r.err.join('\n'))
      const runs = runsOf(fx.main)
      assert.equal(runs.length, 1)
      const rdir = rdirOf(fx.main)
      const state = stateOf(rdir)
      assert.equal(state.phase, 'running')
      assert.equal(state.runnerBackend, 'dogfood-test')
      // the scratch repo lives OUTSIDE the host tree with its own
      // git + beads stores — host claims/marks stay untouched
      const repo = state.repo as string
      assert.ok(repo.startsWith(join(fx.xdg, 'bro', 'dogfood')))
      assert.ok(existsSync(join(repo, '.git')))
      assert.ok(existsSync(join(repo, '.beads')))
      // SDD is armed — a scenario describing the gate must not narrate
      // a hook that cannot fire; committed so the runner starts clean
      const cfg = JSON.parse(readFileSync(join(repo, 'bro.config.json'), 'utf8')) as {
        sdd?: { mode?: string }
      }
      assert.equal(cfg.sdd?.mode, 'gate')
      assert.match(testGit(['-C', repo, 'ls-files'], { encoding: 'utf8' }), /^bro\.config\.json$/m)
      // the spawn went through the registry path: repoRoot = scratch,
      // prompt text = the wrapped runner prompt, beadsDir = scratch store
      const spec = spawned[0]!
      assert.equal(spec.repoRoot, repo)
      assert.equal(spec.beadsDir, join(repo, '.beads'))
      assert.match(spec.prompt, /RUNNER of a bro dogfood scenario/)
      assert.match(spec.prompt, /run `bro status`/)
      assert.match(r.out[0]!, new RegExp(`dogfood run ${runs[0]}`))
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('run copies <name>.files/ into the scratch repo, committed', async () => {
    const fx = fixture()
    const { conn } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      // a scenario carrying client wiring — .claude/settings.local.json
      // is what a claude runner needs present before its first turn
      writeFileSync(
        join(fx.main, 'dogfood', 'seeded.md'),
        '# seeded\n\n1. check files\n\n## Assert\n\n- files exist\n'
      )
      mkdirSync(join(fx.main, 'dogfood', 'seeded.files', '.claude'), { recursive: true })
      writeFileSync(
        join(fx.main, 'dogfood', 'seeded.files', '.claude', 'settings.local.json'),
        '{"enabledPlugins":{},"apiKeyHelper":"x --port {{PORT}}"}'
      )
      const r = await dogfood(['run', 'seeded', '--backend', 'dogfood-test'])
      assert.equal(r.code, 0, r.err.join('\n'))
      const repo = stateOf(rdirOf(fx.main)).repo as string
      assert.ok(existsSync(join(repo, '.claude', 'settings.local.json')))
      // {{PORT}} lands substituted — the per-run port is what keeps a
      // stale listener from squatting the next run's slot
      const seeded = JSON.parse(
        readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')
      ) as { apiKeyHelper: string }
      assert.match(seeded.apiKeyHelper, /--port \d+$/)
      // committed, not just present — the runner starts from a clean
      // tree or the dirty-worktree stop-gate probe trips
      assert.match(
        testGit(['-C', repo, 'ls-files'], { encoding: 'utf8' }),
        /^\.claude\/settings\.local\.json$/m
      )
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('run --provider pins the worker engine on runner and analyst spawns', async () => {
    const fx = fixture()
    const { conn, spawned, states } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      writeFileSync(
        join(fx.main, 'bro.config.json'),
        JSON.stringify({ providers: { p1: { type: 'cli', command: 'p1-cmd' } } })
      )
      const r = await dogfood([
        'run',
        'smoke',
        '--backend',
        'dogfood-test',
        '--provider',
        'p1',
      ])
      assert.equal(r.code, 0, r.err.join('\n'))
      const rdir = rdirOf(fx.main)
      assert.equal(stateOf(rdir).provider, 'p1')
      assert.equal(spawned[0]!.provider, 'p1')
      // terminal runner → lazy advance: the analyst rides the same pin
      states.get('dogfood-test-1')!.state = 'exited'
      const s = await dogfood(['status'])
      assert.equal(s.code, 0)
      assert.equal(spawned.length, 2)
      assert.equal(spawned[1]!.provider, 'p1')
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('status stays running while the runner is live', async () => {
    const fx = fixture()
    const { conn } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      await dogfood(['run', 'smoke', '--backend', 'dogfood-test'])
      const r = await dogfood(['status'])
      assert.equal(r.code, 0)
      const state = stateOf(rdirOf(fx.main))
      assert.equal(state.phase, 'running')
      assert.equal(state.analystAgent, undefined)
      assert.match(r.out.join('\n'), /runner dogfood-test-1 running/)
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('status lazily spawns the analyst on a terminal runner, verdict closes the run', async () => {
    const fx = fixture()
    const { conn, spawned, states } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      await dogfood(['run', 'smoke', '--backend', 'dogfood-test'])
      states.get('dogfood-test-1')!.state = 'exited'
      const rdir = rdirOf(fx.main)
      // first status: runner reads terminal → analyst spawns (its own
      // scripted spawn writes verdict.md)
      const r = await dogfood(['status'])
      assert.equal(r.code, 0, r.err.join('\n'))
      assert.equal(spawned.length, 2)
      assert.match(spawned[1]!.prompt, /ANALYST of a bro dogfood run/)
      assert.ok(spawned[1]!.prompt.includes(rdir))
      // the verdict file landed — a second status closes the phase
      await dogfood(['status'])
      const state = stateOf(rdir)
      assert.equal(state.phase, 'done')
      assert.match(readFileSync(join(rdir, 'verdict.md'), 'utf8'), /verdict: PASS/)
      const rep = await dogfood(['report', runsOf(fx.main)[0]!])
      assert.equal(rep.code, 0)
      assert.match(rep.out.join('\n'), /verdict: PASS/)
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('--analyst none ends the run at runner exit', async () => {
    const fx = fixture()
    const { conn, spawned, states } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      await dogfood(['run', 'smoke', '--backend', 'dogfood-test', '--analyst', 'none'])
      states.get('dogfood-test-1')!.state = 'exited'
      await dogfood(['status'])
      const state = stateOf(rdirOf(fx.main))
      assert.equal(state.phase, 'done')
      assert.equal(spawned.length, 1)
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('report before the verdict points at the transcript', async () => {
    const fx = fixture()
    const { conn } = dogfoodConnector()
    const dispose = registerAgentConnector('dogfood-test', () => conn)
    try {
      await dogfood(['run', 'smoke', '--backend', 'dogfood-test'])
      const r = await dogfood(['report', runsOf(fx.main)[0]!])
      assert.equal(r.code, 0)
      assert.match(r.out.join('\n'), /no verdict yet/)
      assert.match(r.out.join('\n'), /runner: dogfood-test-1/)
    } finally {
      dispose?.()
      fx.restore()
    }
  })

  test('run refuses a worker session', async () => {
    const fx = fixture()
    try {
      process.env.BRO_AGENT_ID = 'worker-1'
      const r = await dogfood(['run', 'smoke', '--backend', 'dogfood-test'])
      assert.equal(r.code, 1)
      assert.match(r.err.join('\n'), /orchestrator-only/)
      assert.equal(runsOf(fx.main).length, 0)
    } finally {
      delete process.env.BRO_AGENT_ID
      fx.restore()
    }
  })
})
