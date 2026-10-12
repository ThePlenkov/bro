/** Drive non-thread blocker fixers e2e (spec bro-atb2g) — settled-red
 *  CI and positive SAST annotations on an orphaned PR must spawn a
 *  per-class fixer, not log-and-skip 'blocked' forever. The fake agent
 *  plays each work order (clears the checks / the annotations); the
 *  next pass merges and closes the fixer bead. The non-spawn verdicts
 *  ride along: occupied, sast_unknown (null count = unreadable, never
 *  a work order), ci-resolved (the race where the failure cleared
 *  between the gate and the spawn), the fixRounds cap, and the
 *  same-head dedup — a clean-exit fixer on an unmoved head is spent,
 *  a moved head earns a fresh round. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bead,
  git,
  initRepo,
  insideAsync,
  installFakeBd,
  installFakeHost,
  readBeads,
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
  run: (args: string[]) => CliResult
}

function fixture(): Fixture {
  const { root, main } = initRepo('bro-drive-blockers-')
  const { binDir, db } = installFakeBd(root)
  const host = installFakeHost(main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost' },
      loop: { agent: `node ${host.agent}` },
    })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    run: (args) => runCli(['drive', ...args], { cwd: main, env }),
  }
}

/** One orphaned PR whose only blocker is a settled-red check. */
const ciFailing = {
  'work/fx-a': {
    number: 7,
    state: 'OPEN',
    headRef: 'work/fx-a',
    baseRef: 'main',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: [{ name: 'build-test', state: 'FAILURE', bucket: 'fail' }],
  },
}

/** A GREEN scanner check carrying failure-level annotations — the
 *  gate counts annotations, not conclusions, so this still blocks. */
const sastFindings = {
  'work/fx-a': {
    number: 7,
    state: 'OPEN',
    headRef: 'work/fx-a',
    baseRef: 'main',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: [{ name: 'sonarcloud', state: 'SUCCESS', bucket: 'pass' }],
  },
}

const verdict = (r: CliResult): { verdict?: string; detail?: string } =>
  (JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"verdict"')) ?? '{}') ?? {}) as {
    verdict?: string
    detail?: string
  }

async function waitFor(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) {
      return true
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

const fixerRows = (db: string): Array<Record<string, unknown>> =>
  readBeads(db).filter((r) => ((r.labels as string[] | undefined) ?? []).includes('fixer'))

const exitRecorded = (main: string): boolean => {
  const agentsDir = join(main, '.git', 'bro', 'agents')
  return existsSync(agentsDir) && readdirSync(agentsDir).some((n) => n.endsWith('.exit'))
}

const spawnLog = (main: string): string =>
  existsSync(join(main, 'spawns.log')) ? readFileSync(join(main, 'spawns.log'), 'utf8') : ''

describe('bro drive — ci/sast blockers on orphaned PRs (bro-atb2g)', () => {
  test('ci_failing spawns the CI fixer; the next pass merges and closes its bead', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, { prs: ciFailing })

      const first = verdict(f.run(['--once', '--json']))
      assert.equal(first.verdict, 'spawned', first.detail)
      assert.match(first.detail ?? '', /ci fx-/)

      // the fixer is detached — wait for its exit record before the
      // next pass reads occupancy + cause off the registry
      assert.equal(await waitFor(() => exitRecorded(f.main)), true)
      assert.match(spawnLog(f.main), /ci cleared checks/)

      const fixer = fixerRows(f.db)[0]
      assert.equal(fixer?.external_ref, 'drive:pr:7')

      // checks cleared by the agent → gate green → orphan merge
      const second = verdict(f.run(['--once', '--json']))
      assert.equal(second.verdict, 'merged', second.detail)
      assert.equal(bead(f.db, String(fixer?.id))?.status, 'closed')
      assert.match(String(bead(f.db, String(fixer?.id))?.close_reason), /merged via/)
    })
  })

  test('sast_pending spawns the SAST fixer; the next pass merges', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, {
        prs: sastFindings,
        annotations: { sonarcloud: 3 },
      })

      const first = verdict(f.run(['--once', '--json']))
      assert.equal(first.verdict, 'spawned', first.detail)
      assert.match(first.detail ?? '', /sast fx-/)

      assert.equal(await waitFor(() => exitRecorded(f.main)), true)
      assert.match(spawnLog(f.main), /sast cleared annotations/)

      const fixer = fixerRows(f.db)[0]
      const second = verdict(f.run(['--once', '--json']))
      assert.equal(second.verdict, 'merged', second.detail)
      assert.equal(bead(f.db, String(fixer?.id))?.status, 'closed')
    })
  })

  test('a clean-exit fixer on an unmoved head is spent — never replayed', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // fixerNoop: the agent exits clean but clears nothing — head
      // unmoved, blocker still there. The attempt record must stop the
      // deterministic replay the pre-bug behavior burned budget on.
      writeHostState(f.hostState, { prs: ciFailing, fixerNoop: true })

      const first = verdict(f.run(['--once', '--json']))
      assert.equal(first.verdict, 'spawned', first.detail)
      assert.equal(await waitFor(() => exitRecorded(f.main)), true)
      assert.match(spawnLog(f.main), /ci left failing \(noop\)/)

      const second = verdict(f.run(['--once', '--json']))
      assert.equal(second.verdict, 'fixer-spent', second.detail)
      assert.match(second.detail ?? '', /ci fixer already exited clean/)
      // no second spawn — the noop agent would have logged again
      assert.equal(spawnLog(f.main).split('\n').filter(Boolean).length, 1)
    })
  })

  test('sast_unknown (null count) stays blocked — never a work order', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // explicit null = the annotations fetch failed — infrastructure
      // uncertainty, not a finding a fixer could clear
      writeHostState(f.hostState, { prs: sastFindings, annotations: { sonarcloud: null } })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'blocked')
      assert.match(v.detail ?? '', /SAST check\(s\) with unknown annotation status/)
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
    })
  })

  test('a red check green at the re-probe is ci-resolved — no spawn', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // readQueues scripts the mid-flight race: the gate snapshot reads
      // the red check twice (the all + required probes), the fixer's
      // own re-probe reads the now-green one
      writeHostState(f.hostState, {
        prs: ciFailing,
        readQueues: {
          checks: [
            [{ name: 'build-test', state: 'FAILURE', bucket: 'fail' }],
            [{ name: 'build-test', state: 'FAILURE', bucket: 'fail' }],
            [],
          ],
        },
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'ci-resolved', v.detail)
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
      // no fixer worktree was paid for the resolved race either
      assert.equal(existsSync(join(f.root, 'main--fx-a')), false)
    })
  })

  test('findings gone at the re-probe is sast-resolved — no spawn', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      const check = { name: 'sonarcloud', state: 'SUCCESS', bucket: 'pass' }
      writeHostState(f.hostState, {
        prs: sastFindings,
        readQueues: {
          // both gate probes + the fixer's check re-probe see the run
          checks: [[check], [check], [check]],
          // …but the annotation count it counted is gone by re-probe
          annotations: [{ sonarcloud: 3 }, {}],
        },
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'sast-resolved', v.detail)
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
    })
  })

  test('an occupied ci-failing PR stays occupied — never force-spawned', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, { prs: ciFailing })
      const hooks = join(f.main, '.git', 'bro', 'hooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(join(hooks, 's1.work'), `${Date.now()}\nwork/fx-a\n`)
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'occupied', v.detail)
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
    })
  })

  test('fixRounds past maxRounds caps the spawn — plain blocked', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, {
        prs: sastFindings,
        annotations: { sonarcloud: 2 },
        reviewedShas: ['a', 'b', 'c', 'd', 'e'],
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'blocked')
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
    })
  })

  test('a PR settled between the gate and the spawn re-probe gets no fixer', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // readQueues.meta scripts the mid-flight settle: the gate's meta
      // read is OPEN, the fixer re-probe sees MERGED — a still-visible
      // failed run must not spawn a worker for a dead PR
      writeHostState(f.hostState, {
        prs: ciFailing,
        readQueues: { meta: [{}, { state: 'MERGED' }] },
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'settled', v.detail)
      assert.equal(fixerRows(f.db).length, 0)
      assert.equal(spawnLog(f.main), '')
    })
  })

  test('a moved head is re-probed at the LIVE sha — stale annotations never gate', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // the gate snapshot reads head 'abc123'; by the fixer's re-probe
      // the head moved to 'bbb' — its annotation fetch must target bbb,
      // not the stale gate sha (the fake records every probe's sha)
      writeHostState(f.hostState, {
        prs: sastFindings,
        annotations: { sonarcloud: 3 },
        readQueues: { meta: [{}, { headSha: 'bbb' }] },
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'spawned', v.detail)
      const reads = (readHostState(f.hostState).annotationReads ?? []) as string[]
      assert.equal(reads[0], 'abc123') // the gate's own probe
      assert.equal(reads.at(-1), 'bbb') // the fixer's re-probe
    })
  })

  test('a spent ci class falls through — the sast fixer still gets its attempt', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      // both classes block the same head; the noop fixer exits clean
      // without clearing either, so the ci attempt is spent — the sast
      // class must still earn its own spawn, not stall behind 'fixer-spent'
      writeHostState(f.hostState, {
        prs: {
          'work/fx-a': {
            ...ciFailing['work/fx-a'],
            checks: [
              { name: 'build-test', state: 'FAILURE', bucket: 'fail' },
              { name: 'sonarcloud', state: 'SUCCESS', bucket: 'pass' },
            ],
          },
        },
        annotations: { sonarcloud: 3 },
        fixerNoop: true,
      })

      const first = verdict(f.run(['--once', '--json']))
      assert.equal(first.verdict, 'spawned', first.detail)
      assert.match(first.detail ?? '', /ci fx-/)
      assert.equal(await waitFor(() => exitRecorded(f.main)), true)

      const second = verdict(f.run(['--once', '--json']))
      assert.equal(second.verdict, 'spawned', second.detail)
      assert.match(second.detail ?? '', /sast fx-/)
      assert.equal(await waitFor(() => spawnLog(f.main).includes('sast')), true)
      assert.match(spawnLog(f.main), /sast left findings \(noop\)/)
    })
  })

  test('open threads preempt a red check — the thread fixer gets the spawn', async () => {
    const f = fixture()
    await insideAsync(f.main, f.root, async () => {
      git(['branch', 'work/fx-a'], f.main)
      writeHostState(f.hostState, {
        prs: ciFailing,
        threads: [
          {
            id: 't1',
            resolved: false,
            comment: {
              author: 'rev',
              bot: true,
              path: 'x.ts',
              line: 1,
              body: 'nit',
              createdAt: '2026-01-01',
            },
          },
        ],
      })
      const v = verdict(f.run(['--once', '--json']))
      assert.equal(v.verdict, 'spawned', v.detail)
      const agentsDir = join(f.main, '.git', 'bro', 'agents')
      assert.equal(
        await waitFor(
          () =>
            existsSync(agentsDir) && readdirSync(agentsDir).some((n) => n.endsWith('.prompt.md'))
        ),
        true
      )
      const pf = readdirSync(agentsDir).find((n) => n.endsWith('.prompt.md'))!
      const prompt = readFileSync(join(agentsDir, pf), 'utf8')
      assert.match(prompt, /unresolved review thread/)
      assert.doesNotMatch(prompt, /failing check/)
    })
  })
})
