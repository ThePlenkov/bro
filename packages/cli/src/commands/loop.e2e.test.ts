/** Loop auto-merge e2e — the claim → worktree → agent → gate → merge →
 *  close → cleanup pipeline run against the built CLI. A node shim plays
 *  bd (JSON-file store via FAKE_BD_DB) and an external connector plugin
 *  plays the review host (host.json state file), so the real merge path
 *  is exercised with no bd/gh/network. The regression cost here is a PR
 *  merged without a gate or a bead stranded claimed — the assertions
 *  check store state, refs, and the worktree, not just output. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_DIST,
  FAKE_BEAD,
  bead,
  e2eEnv,
  git,
  initRepo,
  inside,
  installFakeBd,
  installFakeHost,
  readHostState,
  runCli,
  writeHostState,
  type CliResult,
} from './testrepo.ts'

interface Fixture {
  root: string
  main: string
  db: string
  hostState: string
  /** The fake agent script's path — provider commands reference it. */
  agent: string
  worktree: string
  run: (extra?: string[]) => CliResult
}

/** Repo + fake bd + fake host + bro.config wiring. `rows` are the ready
 *  queue; `loopCfg` merges into the loop section (fixRounds etc.);
 *  `extra` merges more top-level config (providers, fleet) built from
 *  the installed host paths. HOME points at the fixture root so an
 *  operator's ~/.config/bro providers can't hijack a bare run now that
 *  the loop resolves the provider lane. */
function loopFixture(
  rows: Array<Record<string, unknown>>,
  loopCfg: Record<string, unknown> = {},
  scenario = 'land',
  extra: (host: { state: string; agent: string }) => Record<string, unknown> = () => ({})
): Fixture {
  const { root, main } = initRepo('bro-loop-e2e-')
  const { binDir, db } = installFakeBd(root, rows)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      ...extra(host),
      loop: { agent: `node ${host.agent}`, ...loopCfg },
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
    E2E_SCENARIO: scenario,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    agent: host.agent,
    worktree: join(root, 'main--fx-a'),
    run: (extra = []) => runCli(['loop', ...extra], { cwd: main, env }),
  }
}

/** Fake `bro` binary — wins `broSpawnArgv`'s PATH scan ahead of any real
 *  install, so an acp provider's `bro acp-worker …` argv lands here.
 *  Plays the driver: records argv + provenance env, then does the land
 *  scenario (the real driver would serve an ACP session instead). */
const FAKE_BRO = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const pf = args[args.length - 1]
const STATE = process.env.FAKE_HOST_STATE
const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'))
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s))
fs.appendFileSync(
  path.join(path.dirname(STATE), 'acpworker.log'),
  JSON.stringify({
    args,
    promptFile: pf,
    promptOk: fs.existsSync(pf),
    bead: process.env.BRO_BEAD_ID || null,
    provider: process.env.BRO_AGENT_PROVIDER || null,
    agent: process.env.BRO_AGENT || null,
    model: process.env.BRO_AGENT_MODEL || null,
  }) + '\\n'
)
if (fs.readFileSync(pf, 'utf8').includes('review-threads')) {
  const s = load(); s.threads = []; save(s); process.exit(0)
}
fs.writeFileSync('work.txt', 'did the thing\\n')
execFileSync('git', ['add', '-A'])
execFileSync('git', ['commit', '-qm', 'feat: the thing'])
const s = load()
s.prOpened = true
save(s)
`

/** Install the fake `bro` beside the fake `bd` — same dir, first on
 *  the fixture PATH. */
function installFakeBro(root: string): void {
  const bro = join(root, 'bin', 'bro')
  writeFileSync(bro, FAKE_BRO)
  chmodSync(bro, 0o755)
}

const spawns = (f: Fixture): string =>
  existsSync(join(f.main, 'spawns.log'))
    ? readFileSync(join(f.main, 'spawns.log'), 'utf8')
    : ''

describe('bro loop e2e', () => {
  test('land: claim → agent → green gate → merge → close → cleanup', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }])
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.match(r.stdout, /1 landed, 0 closed, 0 parked, 0 failed/)
      // the bead is closed in the shared store, the worktree and its
      // branch are gone, and the audit reports no tails
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed')
      assert.equal(existsSync(f.worktree), false)
      assert.match(r.stdout, /clean — no loop tails/)
      assert.match(spawns(f), /work opened pr/)
      // the liveness guard stays quiet on a clean run — no phantom
      // heartbeats, no mid-run audit on a normal exit
      assert.doesNotMatch(r.stderr, /loop: alive —/)
      assert.doesNotMatch(r.stderr, /exiting mid-run/)
    })
  })

  test('the gate wait arms a rearmable watch marker (bro-z0k2u)', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }])
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /loop: fx-a landed/)
      // the marker is retired when the wait settles — the fake host
      // snapshots the watches dir mid-poll so the arm stays observable
      const peeks = (readHostState(f.hostState).watchPeeks ?? []) as Array<{
        file: string
        marker: {
          pr: number
          pid: number
          merge: boolean
          cleanup?: boolean
          workdir?: string
          bead?: string
          timeoutMin: number
        }
      }>
      const hit = peeks.find((p) => p.marker.pr === 7)
      assert.ok(hit, 'gate wait never armed a watch marker')
      // the act-wait shape <pr>-<pid>-<nonce>.json — what `act rearm`
      // recognizes as a resurrectable wait
      assert.match(hit.file, /^7-\d+-[0-9a-f]+\.json$/)
      assert.equal(hit.marker.merge, true)
      assert.equal(hit.marker.cleanup, true)
      assert.equal(hit.marker.workdir, f.worktree)
      // the bead rides the marker — a resurrected wait runs the
      // finalizeMerge close the dead loop never reached (bro-q6ppv)
      assert.equal(hit.marker.bead, 'fx-a')
    })
  })

  test('dry-run prints the plan and claims nothing', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }])
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run'])
      assert.match(r.stdout, /would claim fx-a/)
      assert.match(r.stdout, /loop\/fx-a/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'open')
      assert.equal(existsSync(f.worktree), false)
    })
  })

  test('agent exit != 0 without a PR → bead reopened + noted, worktree kept', () => {
    // crashExitMs:0 disables the crash-park guard — this tests the
    // legacy reopen path for a genuine mid-work failure
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }],
      { crashExitMs: 0 },
      'fail'
    )
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 failed/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'open')
      assert.match(String(row?.notes), /exited 3 without a PR/)
      assert.equal(existsSync(f.worktree), true)
      assert.match(r.stdout, /worktrees: .*main--fx-a/)
    })
  })

  test('agent gone in <crashExitMs → parked, never reopened (bro-sovl3)', () => {
    // the exit-3-instantly shape that burned the supervisor: reopening
    // reclaims the bead into the same broken spawn — park instead
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }],
      {},
      'fail'
    )
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      assert.match(r.stdout, /parked \(crash, not work\)/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /environment crash, not a verdict; parked/)
      assert.equal(existsSync(f.worktree), true)
    })
  })

  test('agent verdict: bd close without a PR → closed, never reopened', () => {
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'nothing to ship' }],
      {},
      'verdict'
    )
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /closed by the agent — verdict/)
      assert.match(r.stdout, /1 closed/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'closed')
      assert.equal(row?.close_reason, 'nothing to ship')
    })
  })

  test('open threads with fixRounds=0 → parked, claim + worktree kept', () => {
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'contested' }],
      { fixRounds: 0 }
    )
    writeHostState(f.hostState, {
      threads: [
        {
          id: 't1',
          resolved: false,
          outdated: false,
          comment: {
            author: 'reviewer',
            bot: false,
            path: 'work.txt',
            line: 1,
            body: 'fix this first',
            createdAt: '2026-01-01',
          },
        },
      ],
    })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /blocked: 1 unresolved/)
      assert.equal(existsSync(f.worktree), true)
    })
  })

  test('fix round: threads → agent respawn → resolved → landed', () => {
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'iterate' }],
      { fixRounds: 2 }
    )
    writeHostState(f.hostState, {
      threads: [
        {
          id: 't1',
          resolved: false,
          outdated: false,
          comment: {
            author: 'reviewer',
            bot: false,
            path: 'work.txt',
            line: 1,
            body: 'fix this first',
            createdAt: '2026-01-01',
          },
        },
      ],
    })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /fix round 1/)
      assert.match(r.stdout, /loop: fx-a landed/)
      const log = spawns(f)
      assert.match(log, /work opened pr/)
      assert.match(log, /fix resolved threads/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed')
    })
  })

  test('merge accepted but not landed (queue hold) → parked, not failed', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'queued' }])
    writeHostState(f.hostState, { mergeResult: 'OPEN' })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /did not land \(state=OPEN\)/)
      assert.equal(existsSync(f.worktree), true)
    })
  })

  test('PR closed unmerged while the gate polls → parked, bead kept', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'rejected' }])
    writeHostState(f.hostState, { prState: 'CLOSED' })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /closed unmerged/)
    })
  })

  test('PR lookup failure → parked — never reopens a bead whose PR may exist', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'flaky host' }])
    writeHostState(f.hostState, { prLookupFails: true })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /1 parked/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /PR lookup failed/)
      assert.equal(existsSync(f.worktree), true)
    })
  })

  test('empty queue → done with a clean audit', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /0 landed, 0 closed, 0 parked, 0 failed/)
      assert.match(r.stdout, /clean — no loop tails/)
    })
  })

  test('close-out reaps leftover loop litter — clean closed-bead trees, keeps dirty', () => {
    // the incident shape: earlier runs left loop worktrees behind and
    // the audit listed them without removing them
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'ship it' },
      { ...FAKE_BEAD, id: 'fx-z', title: 'landed earlier', status: 'closed' },
      { ...FAKE_BEAD, id: 'fx-y', title: 'closed but dirty', status: 'closed' },
    ])
    // a clean orphan on a closed bead — must be reaped …
    const orphan = join(f.root, 'main--fx-z')
    git(['worktree', 'add', '-b', 'loop/fx-z', orphan], f.main)
    // … and a dirty one — must be kept and still named as a tail
    const dirty = join(f.root, 'main--fx-y')
    git(['worktree', 'add', '-b', 'loop/fx-y', dirty], f.main)
    writeFileSync(join(dirty, 'wip.txt'), 'uncommitted\n')
    // a per-branch PR map makes fx-a's lookup land while the orphans
    // read as PR-less — the map is authoritative in the fake host
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { number: 7, state: 'OPEN', headRef: 'loop/fx-a', baseRef: 'main' } },
    })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.match(r.stdout, /reaped: .*main--fx-z \[loop\/fx-z\]/)
      assert.match(r.stdout, /deleted branch: loop\/fx-z/)
      assert.equal(existsSync(orphan), false)
      assert.equal(git(['branch', '--list', 'loop/fx-z'], f.main).trim(), '')
      // the dirty tree stays — a surviving tail, not a silent sweep
      assert.equal(existsSync(dirty), true)
      assert.match(r.stdout, /worktrees: .*main--fx-y \[loop\/fx-y\]/)
    })
  })
})

/** The liveness contract (spec bro-snga4) — verified against a running
 *  loop, not spawnSync's finished result: a hung agent must stall the
 *  loop visibly (heartbeat lines name the stage), and a mid-run exit
 *  must audit itself. `inside` isn't used — it reaps the fixture root
 *  synchronously while the spawned CLI still runs. */
describe('bro loop liveness', () => {
  const spawnLoop = (f: Fixture, extra: string[] = []) =>
    spawn(process.execPath, [CLI_DIST, 'loop', ...extra], {
      cwd: f.main,
      env: e2eEnv({
        PATH: `${join(f.root, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: f.root,
        FAKE_BD_DB: f.db,
        FAKE_HOST_STATE: f.hostState,
        E2E_SCENARIO: 'hang',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const until = async (fn: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!fn()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  test('a hung agent stalls visibly — heartbeat names the stage, SIGTERM exits audited', async () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'hangs' }], {}, 'hang')
    const proc = spawnLoop(f, ['--interval', '1'])
    let stderr = ''
    proc.stderr!.on('data', (d: Buffer) => (stderr += d))
    let workerPid = 0
    try {
      // the heartbeat holds the event loop open — a drain-shaped death
      // would have ended the process before any `alive` line; the line
      // names the suspension point the silent deaths hid
      await until(
        () => /loop: alive — worker pid=\d+ on fx-a/.test(stderr),
        'a worker-stage heartbeat'
      )
      assert.equal(proc.exitCode, null, 'the loop died awaiting the hung agent')
      workerPid = Number(/worker pid=(\d+)/.exec(stderr)![1])
      proc.kill('SIGTERM')
      // the audit re-raises — the parent still sees a real signal
      // death, not a clean exit code
      const [code, signal] = await new Promise<[number | null, string | null]>((r) =>
        proc.once('exit', (c, s) => r([c, s]))
      )
      assert.equal(signal, 'SIGTERM')
      assert.equal(code, null)
      // the signal handler audits before re-raising — stage + bead
      // named, the note landed, exactly what the silent deaths denied
      assert.match(stderr, /exiting mid-run — worker pid=\d+ on fx-a/)
      assert.match(String(bead(f.db, 'fx-a')?.notes), /process exited mid-run/)
    } finally {
      // a failed wait must not leave the loop or the detached agent
      // group running — reap both before the fixture goes, or the
      // child's open pipes hang the test run
      proc.kill('SIGKILL')
      const pid = workerPid || Number(/worker pid=(\d+)/.exec(stderr)?.[1] ?? 0)
      if (pid !== 0) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

/** Fixture presets for the provider-lane tests — `agent: 'false'` in
 *  loopCfg proves the provider's command ran, not the template. */
const SHIP_IT = [{ ...FAKE_BEAD, id: 'fx-a', title: 'ship it' }]

const cliLane = (loopCfg: Record<string, unknown> = {}): Fixture =>
  loopFixture(SHIP_IT, { agent: 'false', ...loopCfg }, 'land', (host) => ({
    providers: { fakecli: { type: 'cli', command: `node ${host.agent}` } },
  }))

const acpLane = (
  loopCfg: Record<string, unknown>,
  devin: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Fixture =>
  loopFixture(SHIP_IT, loopCfg, 'land', () => ({
    providers: { devin: { type: 'acp', command: 'devin acp', ...devin } },
    ...extra,
  }))

describe('bro loop provider lane', () => {
  test('loop.provider config routes the spawn — loop.agent is not consulted', () => {
    // loop.agent would fail (`false`) — the provider's command must win
    const f = cliLane({ provider: 'fakecli' })
    inside(f.main, f.root, () => {
      const r = f.run()
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.match(spawns(f), /work opened pr/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed')
    })
  })

  test('--provider <name> routes the spawn through the registry', () => {
    const f = cliLane()
    inside(f.main, f.root, () => {
      const r = f.run(['--provider', 'fakecli'])
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.match(spawns(f), /work opened pr/)
    })
  })

  test('--agent <provider-name> names the provider, not a template', () => {
    const f = cliLane()
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'fakecli'])
      assert.match(r.stdout, /loop: fx-a landed/)
    })
  })

  test('acp provider spawns the headless acp-worker argv — no shell template', () => {
    const f = acpLane({ agent: 'false' }, { model: 'swe-2', autoApprove: true })
    installFakeBro(f.root)
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin'])
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr)
      const log = readFileSync(join(f.main, 'acpworker.log'), 'utf8').trim()
      const rec = JSON.parse(log) as {
        args: string[]
        promptFile: string
        promptOk: boolean
        bead: string
        provider: string
        agent: string
        model: string
      }
      // `bro acp-worker --command <cmd> --model <m> --auto-approve <pf>`
      assert.equal(rec.args[0], 'acp-worker')
      assert.deepEqual(rec.args.slice(1, -1), [
        '--command',
        'devin acp',
        '--model',
        'swe-2',
        '--auto-approve',
      ])
      assert.equal(rec.promptOk, true, `prompt file ${rec.promptFile} missing`)
      assert.equal(rec.bead, 'fx-a')
      // provenance pins: provider lane identity, agent cli badge
      assert.equal(rec.provider, 'devin')
      assert.equal(rec.agent, 'devin')
      assert.equal(rec.model, 'swe-2')
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed')
    })
  })

  test('--profile <name> fills provider/model/autoApprove piecewise', () => {
    const f = acpLane(
      { agent: 'false' },
      {},
      { fleet: { profiles: { cheap: { provider: 'devin', model: 'swe-1.5', autoApprove: true } } } }
    )
    installFakeBro(f.root)
    inside(f.main, f.root, () => {
      const r = f.run(['--profile', 'cheap'])
      assert.match(r.stdout, /loop: fx-a landed/, r.stderr)
      const rec = JSON.parse(
        readFileSync(join(f.main, 'acpworker.log'), 'utf8').trim()
      ) as { args: string[]; model: string }
      assert.equal(rec.args.includes('--auto-approve'), true)
      assert.equal(rec.model, 'swe-1.5')
    })
  })

  test('a template --agent overrides a configured loop.provider (escape hatch)', () => {
    const f = loopFixture(SHIP_IT, { provider: 'bad' }, 'land', () => ({
      providers: { bad: { type: 'cli', command: 'false' } },
    }))
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', `node ${f.agent}`])
      assert.match(r.stderr, /bypasses the configured provider lane/)
      assert.match(r.stdout, /loop: fx-a landed/)
    })
  })

  test('an unknown --provider fails before any bead is claimed', () => {
    const f = loopFixture(SHIP_IT)
    inside(f.main, f.root, () => {
      const r = f.run(['--provider', 'nope'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /providers\.nope is not configured/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'open')
    })
  })

  test('--agent <provider> and a disagreeing --provider is a usage error', () => {
    const f = loopFixture([], {}, 'land', () => ({
      providers: {
        a: { type: 'cli', command: 'a-cmd' },
        b: { type: 'cli', command: 'b-cmd' },
      },
    }))
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'a', '--provider', 'b'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /different providers/)
    })
  })

  test('provider flags beside a template --agent are contradictory', () => {
    const f = loopFixture([], {}, 'land', () => ({
      providers: { fakecli: { type: 'cli', command: 'node x' } },
    }))
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'node x {promptFile}', '--model', 'm-1'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /raw template/)
    })
  })

  test('--model with no provider configured is refused, not dropped', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['--model', 'm-1'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /ride the provider lane/)
    })
  })

  test('--dry-run renders the resolved provider + acp-worker argv', () => {
    const f = acpLane({})
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin', '--dry-run'])
      assert.match(r.stdout, /would claim fx-a/)
      assert.match(r.stdout, /provider: devin/)
      assert.match(r.stdout, /acp-worker/)
      assert.match(r.stdout, /--command 'devin acp'/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'open')
    })
  })
})

describe('bro loop argv parse', () => {
  test('an unquoted --agent tail is rejected — never silently dropped', () => {
    // the incident shape: --agent devin -p --prompt-file {promptFile} …
    // must not degrade into a bare `devin <file>` interactive TUI
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run([
        '--agent',
        'devin',
        '-p',
        '--prompt-file',
        '{promptFile}',
        '--permission-mode',
        'dangerous',
      ])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /unknown option --prompt-file|unexpected argument/)
    })
  })

  test('a stray positional names itself and the quoting fix', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['bogus-token'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /unexpected argument 'bogus-token'/)
      assert.match(r.stderr, /--agent 'devin -p --prompt-file \{promptFile\}'/)
    })
  })

  test('an agent template without {promptFile} warns but still runs', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin'])
      assert.equal(r.code, 0)
      assert.match(r.stderr, /has no \{promptFile\}/)
      assert.match(r.stdout, /0 landed/)
    })
  })

  test('a bool flag carrying =value is refused — never a silent live run', () => {
    // --dry-run=true parses as the flag but argv.includes('--dry-run')
    // misses it — without the strict check the queue would run live
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['--dry-run=true'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /option --dry-run takes no value/)
    })
  })

  test('a value flag fed a flag token demands a real value', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', '--json'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /option --agent requires a value/)
    })
  })

  test('a quoted {promptFile} template parses clean', () => {
    const f = loopFixture([])
    inside(f.main, f.root, () => {
      const r = f.run(['--agent', 'devin -p --prompt-file {promptFile}'])
      assert.equal(r.code, 0)
      assert.match(r.stdout, /0 landed/)
      assert.doesNotMatch(r.stderr, /has no \{promptFile\}/)
    })
  })
})

/** Two-bead fixtures seed `prs: {}` so the per-branch map is
 *  authoritative — the agent registers each loop branch's PR as it
 *  "opens" it (nextPr counts up from 11). */
const events = (f: Fixture): Array<Record<string, unknown>> =>
  (readHostState(f.hostState).events ?? []) as Array<Record<string, unknown>>

describe('bro loop gate-stack round-robin', () => {
  test('a pending gate does not block the next claim — B lands while A waits', () => {
    const f = loopFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'slow gate' },
      { ...FAKE_BEAD, id: 'fx-b', title: 'fast gate' },
    ])
    // A is pending until B's PR (12 — A takes 11) merges
    writeHostState(f.hostState, {
      prs: {
        'loop/fx-a': {
          checks: [{ name: 'ci', bucket: 'pending', state: 'IN_PROGRESS' }],
          clearAfterMerge: 12,
        },
      },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['--interval', '1'])
      assert.match(r.stdout, /2 landed/, r.stderr)
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { spawn: 'fx-b', branch: 'loop/fx-b' },
        // B's gate settles first — the whole point: A's pending window
        // is claimed work, not orchestrator idle
        { merge: 12 },
        { merge: 11 },
      ])
      assert.equal(bead(f.db, 'fx-a')?.status, 'closed')
      assert.equal(bead(f.db, 'fx-b')?.status, 'closed')
    })
  })

  test('--max-open 1 bounds the open-PR set — B spawns only after A lands', () => {
    const f = loopFixture(
      [
        { ...FAKE_BEAD, id: 'fx-a', title: 'first' },
        { ...FAKE_BEAD, id: 'fx-b', title: 'second' },
      ],
      { maxOpen: 1 }
    )
    writeHostState(f.hostState, { prs: {} })
    inside(f.main, f.root, () => {
      const r = f.run(['--interval', '1'])
      assert.match(r.stdout, /2 landed/, r.stderr)
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { merge: 11 },
        { spawn: 'fx-b', branch: 'loop/fx-b' },
        { merge: 12 },
      ])
    })
  })

  test('CONFLICTING respawns the agent with a rebase order, then lands', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'conflicted' }])
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { mergeable: 'CONFLICTING' } },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['--interval', '1'])
      assert.match(r.stdout, /rebase round 1 onto main/, r.stderr)
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { rebase: 'fx-a', branch: 'loop/fx-a' },
        { merge: 11 },
      ])
      assert.match(spawns(f), /rebase rebased onto base/)
    })
  })

  test('BEHIND sole blocker pushes update-branch, then lands', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'behind' }])
    writeHostState(f.hostState, {
      prs: { 'loop/fx-a': { mergeState: 'BEHIND' } },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['--interval', '1'])
      assert.match(r.stdout, /loop: fx-a landed/)
      assert.deepEqual(events(f), [
        { spawn: 'fx-a', branch: 'loop/fx-a' },
        { update: 11 },
        { merge: 11 },
      ])
    })
  })

  test('a parked member keeps its claim — worktree + note survive the run', () => {
    const f = loopFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'red ci' }])
    writeHostState(f.hostState, {
      prs: {
        'loop/fx-a': {
          checks: [{ name: 'ci', bucket: 'fail', state: 'FAILURE' }],
        },
      },
    })
    inside(f.main, f.root, () => {
      const r = f.run(['--interval', '1'])
      assert.match(r.stdout, /1 parked/)
      const row = bead(f.db, 'fx-a')
      assert.equal(row?.status, 'in_progress')
      assert.match(String(row?.notes), /blocked: 1 failing check\(s\)/)
    })
  })
})
