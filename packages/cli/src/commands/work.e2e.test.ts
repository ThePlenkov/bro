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
  runCli,
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
