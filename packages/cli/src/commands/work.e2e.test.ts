/** Worktree lifecycle e2e — `bro work enter|leave|list|prune` as spawned
 *  CLI calls on real repos. The assertion target is fs + refs + exit
 *  codes: refusal paths are data-loss guardrails (a dirty or locked tree
 *  must not vanish) and spawn/cleanup symmetry is what keeps `bro work`
 *  sessions from leaking worktrees. process.exit paths can't run
 *  in-process — spawning is the only honest coverage. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
    const host = installFakeHost(main)
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ plugins: ['./fakehost.ts'], connectors: { reviews: 'fakehost' } })
    )
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
    const host = installFakeHost(main)
    writeFileSync(
      join(main, 'bro.config.json'),
      JSON.stringify({ plugins: ['./fakehost.ts'], connectors: { reviews: 'fakehost' } })
    )
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
})
