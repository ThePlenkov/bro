/** Loop auto-merge e2e — the claim → worktree → agent → gate → merge →
 *  close → cleanup pipeline run against the built CLI. A node shim plays
 *  bd (JSON-file store via FAKE_BD_DB) and an external connector plugin
 *  plays the review host (host.json state file), so the real merge path
 *  is exercised with no bd/gh/network. The regression cost here is a PR
 *  merged without a gate or a bead stranded claimed — the assertions
 *  check store state, refs, and the worktree, not just output. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FAKE_BEAD,
  bead,
  initRepo,
  inside,
  installFakeBd,
  installFakeHost,
  runCli,
  writeHostState,
  type CliResult,
} from './testrepo.ts'

interface Fixture {
  root: string
  main: string
  db: string
  hostState: string
  worktree: string
  run: (extra?: string[]) => CliResult
}

/** Repo + fake bd + fake host + bro.config wiring. `rows` are the ready
 *  queue; `loopCfg` merges into the loop section (fixRounds etc.). */
function loopFixture(
  rows: Array<Record<string, unknown>>,
  loopCfg: Record<string, unknown> = {},
  scenario = 'land'
): Fixture {
  const { root, main } = initRepo('bro-loop-e2e-')
  const { binDir, db } = installFakeBd(root, rows)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      loop: { agent: `node ${host.agent}`, ...loopCfg },
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
    E2E_SCENARIO: scenario,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    worktree: join(root, 'main--fx-a'),
    run: (extra = []) => runCli(['loop', ...extra], { cwd: main, env }),
  }
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
    const f = loopFixture(
      [{ ...FAKE_BEAD, id: 'fx-a', title: 'doomed' }],
      {},
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
