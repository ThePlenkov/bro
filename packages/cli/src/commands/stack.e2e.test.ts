/** `bro stack` e2e — push/list/sync against real git repos via the built
 *  CLI. The fake host's per-branch `prs` map scripts the merge cascade:
 *  a merged bottom member retargets the open child PR and rebases its
 *  branch. A bare origin exists so the post-rebase force-push is real. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  env: Record<string, string>
  run: (args: string[], cwd?: string) => CliResult
}

/** Repo + bare origin + fake bd + fake host wiring. `connectors` extras
 *  merge into bro.config.json — e.g. `{stacks: 'fakehost'}` pins the
 *  stacks facade to the scripted one instead of the git dir-match. */
function stackFixture(
  rows: Array<Record<string, unknown>> = [],
  opts: { connectors?: Record<string, string> } = {}
): Fixture {
  const { root, main } = initRepo('bro-stack-e2e-')
  const { binDir, db } = installFakeBd(root, rows)
  const host = installFakeHost(main)
  git(['init', '-q', '--bare', join(root, 'origin.git')], root)
  git(['remote', 'add', 'origin', join(root, 'origin.git')], main)
  git(['push', '-q', '-u', 'origin', 'main'], main)
  writeFileSync(
    join(main, 'bro.config.json'),
    JSON.stringify({
      plugins: ['./fakehost.ts'],
      connectors: { reviews: 'fakehost', ...opts.connectors },
    })
  )
  git(['add', 'bro.config.json'], main)
  git(['commit', '-qm', 'bro config'], main)
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
    env,
    run: (args, cwd = main) => runCli(['stack', ...args], { cwd, env }),
  }
}

/** Forge-less variant — no review host at all. `reviews` resolves to a
 *  connector that can't answer (repo view fails on a file remote), so
 *  stack ops run through the git connector's local cascade. */
function gitStackFixture(rows: Array<Record<string, unknown>> = []): Fixture {
  const { root, main } = initRepo('bro-stack-e2e-')
  const { binDir, db } = installFakeBd(root, rows)
  git(['init', '-q', '--bare', join(root, 'origin.git')], root)
  git(['remote', 'add', 'origin', join(root, 'origin.git')], main)
  git(['push', '-q', '-u', 'origin', 'main'], main)
  writeFileSync(join(main, 'bro.config.json'), '{}')
  // the merge cascade's dirty-worktree guard reads this checkout — keep it clean
  git(['add', 'bro.config.json'], main)
  git(['commit', '-qm', 'bro config'], main)
  git(['push', '-q', 'origin', 'main'], main)
  const env = { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db }
  return {
    root,
    main,
    db,
    hostState: join(root, 'host.json'),
    env,
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

  test('re-push of an existing member re-enters — no duplicate position', () => {
    const f = stackFixture([{ ...FAKE_BEAD, id: 'fx-a', title: 'first' }])
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const r = f.run(['push', 'fx-a', '--name', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/1-fx-a/)
      // still one member — the second push reused the worktree+branch
      assert.deepEqual(
        git(['worktree', 'list', '--porcelain'], f.main)
          .split('\n')
          .filter((l) => l.includes('fx-a')).length,
        2 // worktree + branch lines
      )
    })
  })

  test('a merged tip is skipped — next push bases on the default branch', () => {
    const f = stackFixture([{ ...FAKE_BEAD, id: 'fx-b', title: 'second' }])
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      writeHostState(f.hostState, {
        prs: { 'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' } },
      })
      const r = f.run(['push', 'fx-b', '--name', 's'])
      assert.equal(r.code, 0, r.stderr)
      // position 2 is still taken (merged slots are never reused), but
      // the base is the default branch, not the merged member
      assert.match(r.stdout, /stack\/s\/2-fx-b/)
      assert.match(r.stdout, /based on main/)
    })
  })

  test('a push blocked on the push lock recomputes the position — no duplicate n', async () => {
    const f = stackFixture([{ ...FAKE_BEAD, id: 'fx-b', title: 'second' }])
    try {
      // hold the lock the way a racing push would — the file IS the lock
      const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], f.main).trim()
      const lock = join(common, 'bro', `stack-${encodeURIComponent('s')}.lock`)
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, `${process.pid}:racer`)
      assert.equal(existsSync(CLI_DIST), true, 'packages/cli/dist is missing — run `npm run build`')
      const proc = spawn(process.execPath, [CLI_DIST, 'stack', 'push', 'fx-b', '--name', 's'], {
        cwd: f.main,
        env: e2eEnv(f.env),
      })
      const done = new Promise<CliResult>((resolvePromise, rejectPromise) => {
        let stdout = ''
        let stderr = ''
        const kill = setTimeout(() => {
          proc.kill()
          rejectPromise(new Error(`push never finished — lock still held?\n${stderr}`))
        }, 30_000)
        proc.stdout.on('data', (d: Buffer) => (stdout += d))
        proc.stderr.on('data', (d: Buffer) => (stderr += d))
        proc.on('error', (err) => {
          clearTimeout(kill)
          rejectPromise(err)
        })
        proc.on('close', (code) => {
          clearTimeout(kill)
          resolvePromise({ code, stdout, stderr })
        })
      })
      // the "racer" lands member 1 while our push still waits on the lock —
      // the push must re-read members inside the lock and mint position 2
      git(['branch', 'stack/s/1-fx-a', 'main'], f.main)
      rmSync(lock)
      const r = await done
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/2-fx-b/)
      assert.match(r.stdout, /based on stack\/s\/1-fx-a/)
      assert.equal(existsSync(lock), false)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test('a push that exits mid-section still releases the lock — exit-hook cleanup', () => {
    const f = stackFixture([{ ...FAKE_BEAD, id: 'fx-c', title: 'third' }])
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      // enterWorktree exits(1) on an existing target dir — inside the held lock
      mkdirSync(join(f.root, 'main--fx-b'))
      const r = f.run(['push', 'fx-b', '--name', 's'])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /already exists/)
      const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], f.main).trim()
      assert.equal(existsSync(join(common, 'bro', `stack-${encodeURIComponent('s')}.lock`)), false)
      // the next push isn't blocked by the stranded hold
      rmSync(join(f.root, 'main--fx-b'), { recursive: true })
      assert.equal(f.run(['push', 'fx-c', '--name', 's']).code, 0)
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

  test('a merged member with no worktree loses its branch on sync', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      commitIn(join(f.root, 'main--fx-a'), 'a.txt')
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      // member 1's worktree is gone — nothing anchors the branch
      git(['worktree', 'remove', '--force', join(f.root, 'main--fx-a')], f.main)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
      })
      const r = f.run(['sync', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/1-fx-a merged — edge \+ branch removed/)
      assert.equal(
        git(['branch', '--list', 'stack/s/1-fx-a'], f.main).trim(),
        ''
      )
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

  test('merge lands the OPEN-PR prefix bottom→top through the reviews facade', () => {
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
      const r = f.run(['merge', 's'])
      assert.equal(r.code, 0, r.stderr)
      const s = readHostState(f.hostState)
      // members carry PRs, so git's local mergeChain declined — the
      // per-layer path drove the reviews facade, bottom member first
      assert.deepEqual(s.mergeLog, [11, 12])
      // member 2 was retargeted onto the trunk before its own merge
      assert.deepEqual(s.retargets, [{ pr: 12, base: 'main' }])
      // merged members retired; their worktrees keep the branches
      assert.match(r.stdout, /stack\/s\/1-fx-a merged — leaves the chain/)
      assert.match(r.stdout, /stack\/s\/2-fx-b merged — leaves the chain/)
    })
  })

  test('merge rejects conflicting strategy flags instead of picking one', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      const r = f.run(['merge', 's', '--merge', '--rebase'])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /exclusive/)
    })
  })

  test('merge refuses while any member gate is BLOCKED — nothing lands', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'OPEN', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
        threads: [
          {
            id: 't1',
            resolved: false,
            outdated: false,
            comment: { author: 'reviewer', bot: false, path: 'b.txt', line: 1, body: 'fix first', createdAt: '2026-01-01' },
          },
        ],
      })
      const r = f.run(['merge', 's'])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /exit_gate=BLOCKED/)
      // the pre-merge gate held the whole chain — no merge call at all
      assert.equal(readHostState(f.hostState).mergeLog, undefined)
    })
  })

  test('merge stops below a member with no OPEN PR — the prefix still lands', () => {
    const f = stackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'OPEN', baseRef: 'main' },
        },
      })
      const r = f.run(['merge', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /stack\/s\/2-fx-b has no OPEN PR — merge stops below it/)
      assert.deepEqual(readHostState(f.hostState).mergeLog, [11])
    })
  })

  test('forge-less merge lands the chain locally in the primary worktree', () => {
    const f = gitStackFixture()
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')
      const two = f.run(['push', 'fx-b', '--name', 's'])
      assert.equal(two.code, 0, two.stderr)
      // no review surface — the hint line is the connector's absence
      assert.doesNotMatch(two.stdout, /open the PR against/)
      commitIn(join(f.root, 'main--fx-b'), 'b.txt')
      const r = f.run(['merge', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /merged stack\/s\/1-fx-a into main/)
      assert.match(r.stdout, /merged stack\/s\/2-fx-b into main/)
      // both members' work landed on the trunk
      assert.equal(git(['show', 'main:a.txt'], f.main).trim(), 'a.txt')
      assert.equal(git(['show', 'main:b.txt'], f.main).trim(), 'b.txt')
      // PR-less members retire inline — sync can't detect their merge
      assert.match(r.stdout, /stack\/s\/1-fx-a merged — leaves the chain/)
    })
  })

  test('sync follows a platform-rewritten remote — local-only commits replayed', () => {
    const f = stackFixture([], { connectors: { stacks: 'fakehost' } })
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')
      git(['push', '-q', 'origin', 'stack/s/1-fx-a'], wa)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      const wb = join(f.root, 'main--fx-b')
      commitIn(wb, 'b.txt')
      git(['push', '-q', 'origin', 'stack/s/2-fx-b'], wb)
      // local-only work on top — the platform can't have replayed it
      commitIn(wb, 'local.txt')
      // the platform "merged" member 1: a.txt lands on main...
      commitIn(f.main, 'a.txt')
      git(['push', '-q', 'origin', 'main'], f.main)
      // ...and rewrote member 2's remote — a rebase of its pushed
      // commits onto the new trunk, from a second clone
      const clone = join(f.root, 'clone')
      git(['clone', '-q', join(f.root, 'origin.git'), clone], f.root)
      git(['config', 'user.email', 't@t'], clone)
      git(['config', 'user.name', 't'], clone)
      git(['checkout', '-q', 'stack/s/2-fx-b'], clone)
      git(['rebase', '-q', '--onto', 'origin/main', 'origin/stack/s/1-fx-a'], clone)
      git(['push', '-q', '--force', 'origin', 'stack/s/2-fx-b'], clone)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          // the platform's retarget hadn't landed in this read yet —
          // prBase still names the merged member
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
        cascade: { retarget: true, rebase: true },
      })
      const r = f.run(['sync', 's'])
      assert.equal(r.code, 0, r.stderr)
      // the retarget is the platform's — no API call was made
      assert.equal(readHostState(f.hostState).retargets, undefined)
      assert.match(r.stdout, /stack\/s\/2-fx-b PR retarget → main \(platform\)/)
      // the worktree followed the rewritten remote AND kept local work
      assert.equal(existsSync(join(wb, 'local.txt')), true)
      assert.equal(existsSync(join(wb, 'b.txt')), true)
      assert.equal(existsSync(join(wb, 'a.txt')), true)
      assert.match(r.stdout, /stack\/s\/2-fx-b moved to origin\/stack\/s\/2-fx-b/)
    })
  })

  test('retarget-only platform cascade still rebases the branch locally', () => {
    const f = stackFixture([], { connectors: { stacks: 'fakehost' } })
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')
      git(['push', '-q', 'origin', 'stack/s/1-fx-a'], wa)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      const wb = join(f.root, 'main--fx-b')
      commitIn(wb, 'b.txt')
      git(['push', '-q', 'origin', 'stack/s/2-fx-b'], wb)
      commitIn(f.main, 'a.txt')
      git(['push', '-q', 'origin', 'main'], f.main)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
        // GitLab shape — the platform retargets, local rebase stays ours
        cascade: { retarget: true, rebase: false },
      })
      const r = f.run(['sync', 's'])
      assert.equal(r.code, 0, r.stderr)
      assert.equal(readHostState(f.hostState).retargets, undefined)
      assert.match(r.stdout, /stack\/s\/2-fx-b PR retarget → main \(platform\)/)
      assert.match(r.stdout, /stack\/s\/2-fx-b rebased onto main/)
      assert.equal(
        git(['merge-base', 'main', 'stack/s/2-fx-b'], f.main).trim(),
        git(['rev-parse', 'main'], f.main).trim()
      )
    })
  })

  test('a failed platform follow keeps the edge stale — the next sync retries it', () => {
    const f = stackFixture([], { connectors: { stacks: 'fakehost' } })
    inside(f.main, f.root, () => {
      assert.equal(f.run(['push', 'fx-a', '--name', 's']).code, 0)
      const wa = join(f.root, 'main--fx-a')
      commitIn(wa, 'a.txt')
      git(['push', '-q', 'origin', 'stack/s/1-fx-a'], wa)
      assert.equal(f.run(['push', 'fx-b', '--name', 's']).code, 0)
      const wb = join(f.root, 'main--fx-b')
      commitIn(wb, 'b.txt')
      git(['push', '-q', 'origin', 'stack/s/2-fx-b'], wb)
      commitIn(f.main, 'a.txt')
      git(['push', '-q', 'origin', 'main'], f.main)
      writeHostState(f.hostState, {
        prs: {
          'stack/s/1-fx-a': { number: 11, state: 'MERGED', baseRef: 'main' },
          'stack/s/2-fx-b': { number: 12, state: 'OPEN', baseRef: 'stack/s/1-fx-a' },
        },
        // the platform claims the rewrite — but the remote branch is gone
        cascade: { retarget: true, rebase: true },
      })
      git(['push', '-q', 'origin', '--delete', 'stack/s/2-fx-b'], f.main)
      const r1 = f.run(['sync', 's'])
      assert.equal(r1.code, 0, r1.stderr)
      assert.match(r1.stdout, /stack\/s\/2-fx-b remote gone/)
      // the edge must not have moved — the next sync retries the follow
      // instead of reading the member as synced
      const r2 = f.run(['sync', 's'])
      assert.equal(r2.code, 0, r2.stderr)
      assert.match(r2.stdout, /stack\/s\/2-fx-b remote gone/)
    })
  })
})
