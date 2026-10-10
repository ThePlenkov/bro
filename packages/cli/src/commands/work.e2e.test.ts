/** Worktree lifecycle e2e — `bro work enter|leave|list|prune` as spawned
 *  CLI calls on real repos. The assertion target is fs + refs + exit
 *  codes: refusal paths are data-loss guardrails (a dirty or locked tree
 *  must not vanish) and spawn/cleanup symmetry is what keeps `bro work`
 *  sessions from leaking worktrees. process.exit paths can't run
 *  in-process — spawning is the only honest coverage. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { procStat } from '@broject/core'
import {
  FAKE_BEAD,
  bead,
  git,
  initRepo,
  inside,
  installFakeBd,
  installFakeHost,
  runCli,
  writeHostState,
} from './testrepo.ts'

function workFixture(): { root: string; main: string } {
  return initRepo('bro-work-e2e-')
}

const worktreeOf = (root: string, slug: string): string => join(root, `main--${slug}`)

describe('bro work e2e — enter', () => {
  test('enter creates a sibling worktree on work/<slug>; re-enter fails', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const r = runCli(['work', 'enter', 'fix-x'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /worktree ready/)
      const wt = worktreeOf(root, 'fix-x')
      assert.equal(existsSync(wt), true)
      assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt).trim(), 'work/fix-x')

      const again = runCli(['work', 'enter', 'fix-x'], { cwd: main })
      assert.equal(again.code, 1)
      assert.match(again.stderr, /already exists/)
    })
  })

  test('enter on a bead slug claims it — the work/task seam', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-w', title: 'claimable' },
    ])
    inside(main, root, () => {
      const r = runCli(['work', 'enter', 'fx-w'], {
        cwd: main,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db },
      })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /claimed bead fx-w/)
      const row = bead(db, 'fx-w')
      assert.equal(row?.status, 'in_progress')
      assert.equal(row?.assignee, 'tester')
    })
  })
})

describe('bro work e2e — leave', () => {
  /** Fixture with a linked worktree already entered. */
  const entered = (root: string, main: string, slug = 'fix-x'): string => {
    const r = runCli(['work', 'enter', slug], { cwd: main })
    assert.equal(r.code, 0, r.stderr)
    return worktreeOf(root, slug)
  }

  test('leave removes a clean tree and keeps the branch by default', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = entered(root, main)
      const r = runCli(['work', 'leave', 'fix-x'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /removed worktree/)
      assert.equal(existsSync(wt), false)
      assert.equal(git(['branch', '--list', 'work/fix-x'], main).trim(), 'work/fix-x')
    })
  })

  test('leave --delete-branch retires the merged branch', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      entered(root, main)
      const r = runCli(['work', 'leave', 'fix-x', '--delete-branch'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /deleted branch work\/fix-x/)
      assert.equal(git(['branch', '--list', 'work/fix-x'], main).trim(), '')
    })
  })

  test('leave refuses a dirty tree; --force removes it', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = entered(root, main)
      writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n')
      const refused = runCli(['work', 'leave', 'fix-x'], { cwd: main })
      assert.equal(refused.code, 1)
      assert.match(refused.stderr, /uncommitted changes/)
      assert.equal(existsSync(wt), true)
      const forced = runCli(['work', 'leave', 'fix-x', '--force'], { cwd: main })
      assert.equal(forced.code, 0, forced.stderr)
      assert.equal(existsSync(wt), false)
    })
  })

  test('leave refuses the main worktree', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const r = runCli(['work', 'leave'], { cwd: main })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /refusing to remove the main worktree/)
    })
  })

  test('leave refuses a locked worktree — unlock is explicit human intent', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = entered(root, main)
      git(['worktree', 'lock', wt], main)
      const r = runCli(['work', 'leave', 'fix-x', '--force'], { cwd: main })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /is locked/)
      assert.equal(existsSync(wt), true)
    })
  })

  test('leave from inside the worktree removes it and says where to go', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = entered(root, main)
      const r = runCli(['work', 'leave'], { cwd: wt })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /this directory is gone/)
      assert.equal(existsSync(wt), false)
    })
  })
})

describe('bro work e2e — list + prune', () => {
  test('list reports main + linked with dirty state', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = worktreeOf(root, 'fix-x')
      assert.equal(runCli(['work', 'enter', 'fix-x'], { cwd: main }).code, 0)
      writeFileSync(join(wt, 'dirty.txt'), 'x\n')
      const r = runCli(['work', 'list'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`main\\s+${main.replaceAll('/', '\\/')}`))
      assert.match(r.stdout, /linked\s+\S*main--fix-x\s+work\/fix-x\s+dirty\(1\)/)
    })
  })

  test('prune drops the admin entry for a worktree deleted by hand', () => {
    const { root, main } = workFixture()
    inside(main, root, () => {
      const wt = worktreeOf(root, 'fix-x')
      assert.equal(runCli(['work', 'enter', 'fix-x'], { cwd: main }).code, 0)
      rmSync(wt, { recursive: true, force: true }) // out-of-band delete
      const r = runCli(['work', 'prune'], { cwd: main })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /pruned 1 stale entr/)
      // and the second prune finds nothing stale
      const again = runCli(['work', 'prune'], { cwd: main })
      assert.match(again.stdout, /nothing stale/)
    })
  })
})

describe('bro work e2e — prune --loop', () => {
  /** loop/* litter made by hand — the sweep treats a closed bead as the
   *  verdict record: clean trees whose bead is done get reaped, anything
   *  else keeps. */
  const litter = (root: string, main: string, slug: string, commit = false): string => {
    const wt = join(root, `main--${slug}`)
    git(['worktree', 'add', '-b', `loop/${slug}`, wt], main)
    if (commit) {
      git(['commit', '-q', '--allow-empty', '-m', 'wip'], wt)
    }
    return wt
  }
  const envOf = (binDir: string, db: string) => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
  })
  /** fake review host wired via bro.config.json — the PR-veto/land
   *  evidence plane the sweep consults. */
  const hostFixture = (main: string) => {
    const host = installFakeHost(main)
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ plugins: ['./fakehost.ts'], connectors: { reviews: 'fakehost' } })
    )
    return host
  }

  test('reaps a clean closed-bead worktree and retires its branch', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-z', status: 'closed' }])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-z')
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /reaped .*main--fx-z \[loop\/fx-z\]/)
      assert.match(r.stdout, /deleted branch loop\/fx-z/)
      assert.equal(existsSync(wt), false)
      assert.equal(git(['branch', '--list', 'loop/fx-z'], main).trim(), '')
    })
  })

  test('keeps open-bead, dirty, and locked litter — with the reason named', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-open', title: 'still cooking' },
      { ...FAKE_BEAD, id: 'fx-dirty', status: 'closed' },
      { ...FAKE_BEAD, id: 'fx-locked', status: 'closed' },
    ])
    inside(main, root, () => {
      const openWt = litter(root, main, 'fx-open')
      const dirtyWt = litter(root, main, 'fx-dirty')
      writeFileSync(join(dirtyWt, 'wip.txt'), 'uncommitted\n')
      const lockedWt = litter(root, main, 'fx-locked')
      git(['worktree', 'lock', lockedWt], main)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      for (const wt of [openWt, dirtyWt, lockedWt]) {
        assert.equal(existsSync(wt), true, wt)
      }
      assert.match(r.stdout, /kept .*fx-open \(bead open\)/)
      assert.match(r.stdout, /kept .*fx-dirty \(dirty\)/)
      assert.match(r.stdout, /kept .*fx-locked \(locked/)
      // the branches survive with the trees — a kept tree's branch is
      // still checked out and must not be deleted under it
      for (const b of ['loop/fx-open', 'loop/fx-dirty', 'loop/fx-locked']) {
        // --format: bare `branch --list` marks worktree'd branches with '+ '
        assert.equal(git(['branch', '--list', b, '--format=%(refname:short)'], main).trim(), b)
      }
    })
  })

  test('retires a bare closed-bead loop branch — no worktree needed', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-bare', status: 'closed' }])
    inside(main, root, () => {
      git(['branch', 'loop/fx-bare'], main)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /deleted branch loop\/fx-bare/)
      assert.equal(git(['branch', '--list', 'loop/fx-bare'], main).trim(), '')
    })
  })

  test('an open PR vetoes the reap even with the bead closed', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-o', status: 'closed' }])
    const host = hostFixture(main)
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-o', true)
      writeHostState(host.state, {
        prs: { 'loop/fx-o': { number: 9, state: 'OPEN', headRef: 'loop/fx-o' } },
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-o \(open PR — unmerged\)/)
      assert.equal(existsSync(wt), true)
      assert.equal(
        git(['branch', '--list', 'loop/fx-o', '--format=%(refname:short)'], main).trim(),
        'loop/fx-o'
      )
    })
  })

  test('a merged PR pins the branch delete past a squash-blind tip', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-m', status: 'closed' }])
    const host = hostFixture(main)
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-m', true)
      // the squash-merge shape: the branch tip is nowhere in main's
      // history, so `branch -d` would refuse — only the host's merged
      // head can prove the landing
      const tip = git(['rev-parse', 'loop/fx-m'], main).trim()
      writeHostState(host.state, {
        prs: { 'loop/fx-m': { number: 9, state: 'MERGED', headSha: tip, headRef: 'loop/fx-m' } },
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(existsSync(wt), false)
      assert.equal(git(['branch', '--list', 'loop/fx-m'], main).trim(), '')
    })
  })

  test('--dry-run reports the verdict and touches nothing', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-z', status: 'closed' }])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-z')
      const r = runCli(['work', 'prune', '--loop', '--dry-run'], {
        cwd: main,
        env: envOf(binDir, db),
      })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /would reap .*main--fx-z/)
      assert.match(r.stdout, /would delete branch loop\/fx-z/)
      assert.equal(existsSync(wt), true)
      assert.equal(
        git(['branch', '--list', 'loop/fx-z', '--format=%(refname:short)'], main).trim(),
        'loop/fx-z'
      )
    })
  })

  test('closed bead + commits never landed → tree reaps, branch keeps', () => {
    // the closed-bead verdict retires the scratch dir but git's own
    // merged check refuses the branch — 'closed' is a verdict, not a
    // landing proof; unlanded commits keep their ref
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-u', status: 'closed' }])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-u', true)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /reaped .*main--fx-u \[loop\/fx-u\]/)
      assert.match(r.stdout, /kept loop\/fx-u \(unlanded commits\)/)
      assert.equal(existsSync(wt), false)
      assert.equal(
        git(['branch', '--list', 'loop/fx-u', '--format=%(refname:short)'], main).trim(),
        'loop/fx-u'
      )
    })
  })

  test('an unreadable agent registry keeps every tree — occupancy unknowable', () => {
    // readAgentRegistry deliberately throws on corruption rather than
    // report an empty world — the sweep must keep what it cannot verify
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-r', status: 'closed' }])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-r')
      mkdirSync(join(main, '.git', 'bro'), { recursive: true })
      writeFileSync(join(main, '.git', 'bro', 'agents.json'), '{ not json')
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-r \(agent registry unreadable\)/)
      assert.equal(existsSync(wt), true)
    })
  })
})

describe('bro work e2e — prune --loop dead-worker claims (bro-ho09d)', () => {
  const litter = (root: string, main: string, slug: string): string => {
    const wt = join(root, `main--${slug}`)
    git(['worktree', 'add', '-b', `loop/${slug}`, wt], main)
    return wt
  }
  const envOf = (binDir: string, db: string) => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
  })
  /** a pid that was real and is now gone — a worker's corpse. */
  const deadPid = (): number => spawnSync('sh', ['-c', 'exit 0']).pid ?? 0
  const writeRun = (main: string, slug: string, rec: Record<string, unknown>): void => {
    const dir = join(main, '.git', 'bro', 'loop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${slug}.json`), `${JSON.stringify(rec)}\n`)
  }
  const writeRegistry = (main: string, entries: Record<string, unknown>): void => {
    mkdirSync(join(main, '.git', 'bro'), { recursive: true })
    writeFileSync(join(main, '.git', 'bro', 'agents.json'), JSON.stringify(entries))
  }

  test('in_progress under a dead worker releases the claim and parks the tree', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-dead', status: 'in_progress', assignee: 'gone' },
    ])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-dead')
      writeRun(main, 'fx-dead', {
        beadId: 'fx-dead',
        slug: 'fx-dead',
        pid: deadPid(),
        startedAt: new Date().toISOString(),
        worktree: wt,
        log: '',
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /released claim fx-dead/)
      assert.match(r.stdout, /kept .*fx-dead \(bead open\)/)
      assert.equal(bead(db, 'fx-dead')?.status, 'open')
      assert.match(String(bead(db, 'fx-dead')?.notes), /released orphaned claim/)
      // the released bead's tree is resume cache — kept under the cap,
      // branch survives either way
      assert.equal(existsSync(wt), true)
    })
  })

  test('in_progress with a live loop worker keeps the claim and tree', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-live', status: 'in_progress', assignee: 'me' },
    ])
    inside(main, root, () => {
      const wt = litter(root, main, 'fx-live')
      writeRun(main, 'fx-live', {
        beadId: 'fx-live',
        slug: 'fx-live',
        // this very test process is a live pid for the spawned CLI's
        // whole lifetime — the record reads 'running'
        pid: process.pid,
        startedAt: new Date().toISOString(),
        worktree: wt,
        log: '',
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-live \(bead in_progress — loop worker pid \d+ live\)/)
      assert.equal(bead(db, 'fx-live')?.status, 'in_progress')
      assert.equal(existsSync(wt), true)
    })
  })

  test('a live registry agent keeps the claim — the respawn case', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-reg', status: 'in_progress', assignee: 'drive' },
    ])
    inside(main, root, () => {
      litter(root, main, 'fx-reg')
      writeRegistry(main, {
        'fx-reg': {
          agentId: 'a-live',
          backend: 'native',
          pid: process.pid,
          spawnedAt: new Date().toISOString(),
        },
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-reg \(bead in_progress — agent a-live live\)/)
      assert.equal(bead(db, 'fx-reg')?.status, 'in_progress')
    })
  })

  test('a reused pid with a foreign start time still releases', () => {
    // pidAlive's pid+start identity — the pid is alive (this test
    // process) but the recorded starttime is not ours: it proves the
    // recorded worker is gone and the pid was recycled
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-reuse', status: 'in_progress', assignee: 'gone' },
    ])
    inside(main, root, () => {
      litter(root, main, 'fx-reuse')
      writeRun(main, 'fx-reuse', {
        beadId: 'fx-reuse',
        slug: 'fx-reuse',
        pid: process.pid,
        pidStart: '1',
        startedAt: new Date().toISOString(),
        worktree: join(root, 'main--fx-reuse'),
        log: '',
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /released claim fx-reuse/)
      assert.equal(bead(db, 'fx-reuse')?.status, 'open')
    })
  })

  test('a live session marker keeps the claim', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-sess', status: 'in_progress', assignee: 'me' },
    ])
    inside(main, root, () => {
      litter(root, main, 'fx-sess')
      const hooks = join(main, '.git', 'bro', 'hooks')
      mkdirSync(hooks, { recursive: true })
      // `<millis> <owner-pid> <start>` + detail lines — the owner pair
      // makes the marker live while this test process lives
      const start = procStat(process.pid)?.start ?? ''
      writeFileSync(join(hooks, 's-1.task'), `${Date.now()} ${process.pid} ${start}\nfx-sess\n`)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-sess \(bead in_progress — session armed fx-sess\)/)
      assert.equal(bead(db, 'fx-sess')?.status, 'in_progress')
    })
  })

  test('dead run record with no litter still releases the claim', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-gone', status: 'in_progress', assignee: 'gone' },
    ])
    inside(main, root, () => {
      writeRun(main, 'fx-gone', {
        beadId: 'fx-gone',
        slug: 'fx-gone',
        pid: deadPid(),
        startedAt: new Date().toISOString(),
        worktree: join(root, 'main--fx-gone'),
        log: '',
      })
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /released claim fx-gone/)
      assert.equal(bead(db, 'fx-gone')?.status, 'open')
    })
  })

  test('dry-run reports the release without touching the claim', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-dry', status: 'in_progress', assignee: 'gone' },
    ])
    inside(main, root, () => {
      litter(root, main, 'fx-dry')
      writeRun(main, 'fx-dry', {
        beadId: 'fx-dry',
        slug: 'fx-dry',
        pid: deadPid(),
        startedAt: new Date().toISOString(),
        worktree: join(root, 'main--fx-dry'),
        log: '',
      })
      const r = runCli(['work', 'prune', '--loop', '--dry-run'], {
        cwd: main,
        env: envOf(binDir, db),
      })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /would release claim fx-dry/)
      assert.equal(bead(db, 'fx-dry')?.status, 'in_progress')
      assert.equal(existsSync(join(root, 'main--fx-dry')), true)
    })
  })
})

describe('bro work e2e — prune --loop parked pool (bro-ho09d)', () => {
  const litter = (root: string, main: string, slug: string): string => {
    const wt = join(root, `main--${slug}`)
    git(['worktree', 'add', '-b', `loop/${slug}`, wt], main)
    return wt
  }
  const envOf = (binDir: string, db: string) => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
  })
  /** Back-date a parked tree — dir mtime plus the gitdir activity files
   *  the idle clock reads. */
  const ageTree = (main: string, wt: string, days: number): void => {
    const t = new Date(Date.now() - days * 86_400_000)
    const gd = join(main, '.git', 'worktrees', basename(wt))
    for (const p of [wt, gd, join(gd, 'index'), join(gd, 'HEAD'), join(gd, 'logs', 'HEAD')]) {
      try {
        utimesSync(p, t, t)
      } catch {
        // a file that doesn't exist (e.g. no index) doesn't age
      }
    }
  }

  test('parkedKeep caps the resume cache — newest survive, extras reap', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-a' },
      { ...FAKE_BEAD, id: 'fx-b' },
      { ...FAKE_BEAD, id: 'fx-c' },
    ])
    inside(main, root, () => {
      // TTL off — the cap alone must order this test's verdicts
      writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ loop: { parkedKeep: 1, parkedTtlDays: 0 } }))
      const old = litter(root, main, 'fx-a')
      const mid = litter(root, main, 'fx-b')
      const fresh = litter(root, main, 'fx-c')
      ageTree(main, old, 30)
      ageTree(main, mid, 10)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-c \(bead open\)/)
      assert.match(r.stdout, /reaped .*fx-a .*over cap 1/)
      assert.match(r.stdout, /reaped .*fx-b .*over cap 1/)
      assert.equal(existsSync(old), false)
      assert.equal(existsSync(mid), false)
      assert.equal(existsSync(fresh), true)
    })
  })

  test('parkedTtlDays reaps stale trees regardless of the cap', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-old' }, { ...FAKE_BEAD, id: 'fx-new' }])
    inside(main, root, () => {
      writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ loop: { parkedTtlDays: 7 } }))
      const old = litter(root, main, 'fx-old')
      const fresh = litter(root, main, 'fx-new')
      ageTree(main, old, 30)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /reaped .*fx-old .*idle past TTL/)
      assert.match(r.stdout, /kept .*fx-new \(bead open\)/)
      assert.equal(existsSync(old), false)
      assert.equal(existsSync(fresh), true)
    })
  })

  test('a dirty parked tree keeps its data and spends no pool slot', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [
      { ...FAKE_BEAD, id: 'fx-dirty' },
      { ...FAKE_BEAD, id: 'fx-p1' },
      { ...FAKE_BEAD, id: 'fx-p2' },
    ])
    inside(main, root, () => {
      writeFileSync(join(main, 'bro.config.json'), JSON.stringify({ loop: { parkedKeep: 1, parkedTtlDays: 0 } }))
      const dirty = litter(root, main, 'fx-dirty')
      writeFileSync(join(dirty, 'wip.txt'), 'uncommitted\n')
      const p1 = litter(root, main, 'fx-p1')
      const p2 = litter(root, main, 'fx-p2')
      // the dirty tree is the OLDEST — it must not consume the one
      // pool slot, only the two clean parked trees compete for it
      ageTree(main, dirty, 30)
      ageTree(main, p1, 20)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*fx-dirty \(dirty\)/)
      assert.match(r.stdout, /kept .*fx-p2 \(bead open\)/)
      assert.match(r.stdout, /reaped .*fx-p1 .*over cap 1/)
      assert.equal(existsSync(dirty), true)
      assert.equal(existsSync(p1), false)
      assert.equal(existsSync(p2), true)
    })
  })
})

describe('bro work e2e — prune --loop ghost dirs (bro-ho09d)', () => {
  const envOf = (binDir: string, db: string) => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
  })
  /** Delete the worktree's admin entry, leaving the dir + .git file —
   *  the registered-dir-gone ghost shape (bro-oam4). */
  const unRegister = (main: string, wt: string): void => {
    rmSync(join(main, '.git', 'worktrees', basename(wt)), { recursive: true, force: true })
  }

  test('a ghost with a live branch re-registers and joins the verdicts', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-g', status: 'closed' }])
    inside(main, root, () => {
      const wt = join(root, 'main--fx-g')
      git(['worktree', 'add', '-b', 'loop/fx-g', wt], main)
      unRegister(main, wt)
      const listed = git(['worktree', 'list', '--porcelain'], main)
      assert.equal(listed.includes('main--fx-g'), false)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /re-registered .*main--fx-g \[loop\/fx-g\]/)
      // closed bead + clean → the recovered ghost reaps through the
      // normal verdicts
      assert.match(r.stdout, /reaped .*main--fx-g \[loop\/fx-g\]/)
      assert.equal(existsSync(wt), false)
    })
  })

  test('an open-bead ghost re-registers and parks — nothing is lost', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [{ ...FAKE_BEAD, id: 'fx-go' }])
    inside(main, root, () => {
      const wt = join(root, 'main--fx-go')
      git(['worktree', 'add', '-b', 'loop/fx-go', wt], main)
      git(['commit', '-q', '--allow-empty', '-m', 'wip'], wt)
      unRegister(main, wt)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /re-registered .*main--fx-go \[loop\/fx-go\]/)
      assert.match(r.stdout, /kept .*fx-go \(bead open\)/)
      assert.equal(existsSync(wt), true)
      assert.equal(git(['worktree', 'list', '--porcelain'], main).includes('main--fx-go'), true)
    })
  })

  test('a ghost with no matching branch is kept and reported', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [])
    inside(main, root, () => {
      const wt = join(root, 'main--fx-nobranch')
      git(['worktree', 'add', '-b', 'loop/fx-nobranch', wt], main)
      unRegister(main, wt)
      git(['branch', '-D', 'loop/fx-nobranch'], main)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*main--fx-nobranch \(ghost — no branch to bind\)/)
      assert.equal(existsSync(wt), true)
    })
  })

  test('a dir with no .git keeps; an empty one reaps', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [])
    inside(main, root, () => {
      const stray = join(root, 'main--stray')
      mkdirSync(join(stray, 'src'), { recursive: true })
      writeFileSync(join(stray, 'src', 'x.ts'), 'x\n')
      const empty = join(root, 'main--empty')
      mkdirSync(empty)
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*main--stray \(ghost — no \.git/)
      assert.match(r.stdout, /reaped .*main--empty \(empty ghost dir\)/)
      assert.equal(existsSync(stray), true)
      assert.equal(existsSync(empty), false)
    })
  })

  test('a foreign clone sibling is never touched', () => {
    const { root, main } = workFixture()
    const { binDir, db } = installFakeBd(root, [])
    inside(main, root, () => {
      const clone = join(root, 'main--foreign')
      mkdirSync(join(clone, '.git'), { recursive: true })
      writeFileSync(join(clone, 'README'), 'x\n')
      const r = runCli(['work', 'prune', '--loop'], { cwd: main, env: envOf(binDir, db) })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /kept .*main--foreign \(ghost — separate clone\)/)
      assert.equal(existsSync(join(clone, '.git')), true)
    })
  })
})
