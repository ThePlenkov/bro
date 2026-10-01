/** `bro stack` e2e — push/list/sync against real git repos via the built
 *  CLI. The fake host's per-branch `prs` map scripts the merge cascade:
 *  a merged bottom member retargets the open child PR and rebases its
 *  branch. A bare origin exists so the post-rebase force-push is real. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FAKE_BEAD,
  bead,
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
  run: (args: string[], cwd?: string) => CliResult
}

/** Repo + bare origin + fake bd + fake host wiring. */
function stackFixture(rows: Array<Record<string, unknown>> = []): Fixture {
  const { root, main } = initRepo('bro-stack-e2e-')
  const { binDir, db } = installFakeBd(root, rows)
  const host = installFakeHost(main)
  git(['init', '-q', '--bare', join(root, 'origin.git')], root)
  git(['remote', 'add', 'origin', join(root, 'origin.git')], main)
  git(['push', '-q', '-u', 'origin', 'main'], main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({ plugins: ['./fakehost.ts'], connectors: { reviews: 'fakehost' } })
  )
  const env = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_BD_DB: db,
    FAKE_HOST_STATE: host.state,
  }
  return {
    root,
    main,
    db,
    hostState: host.state,
    run: (args, cwd = main) => runCli(['stack', ...args], { cwd, env }),
  }
}

/** A stack member + one commit in its worktree, so sync has something to rebase. */
function commitIn(dir: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`)
  git(['add', '-A'], dir)
  git(['commit', '-qm', `add ${file}`], dir)
}

describe('bro stack e2e', () => {
  test('push creates stack/<name>/<n>-<slug> worktrees off the tip and claims beads', () => {
    const f = stackFixture([
      { ...FAKE_BEAD, id: 'fx-a', title: 'first' },
      { ...FAKE_BEAD, id: 'fx-b', title: 'second' },
    ])
    inside(f.main, f.root, () => {
      const one = f.run(['push', 'fx-a', '--name', 's'])
      assert.equal(one.code, 0, one.stderr)
      assert.match(one.stdout, /stack\/s\/1-fx-a/)
      assert.match(one.stdout, /based on main/)
      assert.equal(bead(f.db, 'fx-a')?.status, 'in_progress')

      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')

      const two = f.run(['push', 'fx-b', '--name', 's'])
      assert.equal(two.code, 0, two.stderr)
      assert.match(two.stdout, /stack\/s\/2-fx-b/)
      assert.match(two.stdout, /based on stack\/s\/1-fx-a/)
      // the fork point is member 1's tip, not main
      assert.equal(
        git(['merge-base', 'stack/s/1-fx-a', 'stack/s/2-fx-b'], f.main).trim(),
        git(['rev-parse', 'stack/s/1-fx-a'], f.main).trim()
      )
      // the edge is recorded in the common git dir
      assert.match(
        git(
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          f.main
        ).trim(),
        /.+/
      )
      const edges = join(
        git(['rev-parse', '--path-format=absolute', '--git-common-dir'], f.main).trim(),
        'bro',
        'stack',
        encodeURIComponent('stack/s/2-fx-b')
      )
      assert.equal(existsSync(edges), true)
    })
  })

  test('push inside a stack worktree infers the stack name', () => {
    const f = stackFixture([{ ...FAKE_BEAD, id: 'fx-b', title: 'second' }])
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      const r = f.run(['push', 'fx-b'], wa)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/2-fx-b/)
    })
  })

  test('push without a stack context fails with the remedy', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['push', 'fx-a'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /--name <stack>/)
    })
  })

  test('list renders members with base, worktree state, and PR', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'OPEN', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
      })
      const r = f.run(['list', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack s {2}\(2 members\)/)
      assert.match(r.stdout, /1 {2}fx-a {2}stack\/s\/1-fx-a {2}base main {2}main--fx-a clean {2}\[#11\].*OPEN→main/)
      assert.match(r.stdout, /2 {2}fx-b {2}.*base stack\/s\/1-fx-a.*\[#12\].*OPEN→stack\/s\/1-fx-a/)
    })
  })

  test('sync after a bottom merge retargets and rebases the child', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')
      git(['push', '-q', 'origin', 'stack/s/1-fx-a'], wa)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      const wb = join(f.root, 'main--fx-b')
      commitIn(wb, 'b.txt')
      git(['push', '-q', 'origin', 'stack/s/2-fx-b'], wb)
      // the squash merge: member 1's change lands on main as a new commit
      commitIn(f.main, 'a.txt')
      git(['push', '-q', 'origin', 'main'], f.main)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
      })
      const r = f.run(['sync', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/1-fx-a merged/)
      assert.match(r.stdout, /stack\/s\/2-fx-b rebased onto main/)
      assert.match(r.stdout, /\[#12\].*retargeted → main/)
      // the rebase moved member 2 onto main — a.txt content is squashed
      // away (fake merge) so only b.txt remains as member-unique work
      assert.equal(
        git(['merge-base', 'main', 'stack/s/2-fx-b'], f.main).trim(),
        git(['rev-parse', 'main'], f.main).trim()
      )
      // the host recorded the retarget
      assert.deepEqual(readHostState(f.hostState).retargets, [{ pr: 12, base: 'main' }])
    })
  })

  test('sync skips a dirty member worktree — PR stays untargeted', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      commitIn(join(f.root, 'main--fx-a'), 'a.txt')
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      const wb = join(f.root, 'main--fx-b')
      commitIn(wb, 'b.txt')
      writeFileSync(join(wb, 'dirty.txt'), 'uncommitted\n')
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
      })
      const r = f.run(['sync', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/2-fx-b skipped — dirty worktree/)
      assert.equal(readHostState(f.hostState).retargets, undefined)
    })
  })

  test('sync with no stacks is a quiet no-op', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['sync'])
      assert.equal(r.code, 0)
      assert.match(r.stdout, /no stacks/)
    })
  })
})
