import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bridgeFetch,
  bridgePublish,
  doltSyncPlan,
  fileTargetPath,
  gitUpstream,
  listDoltRemotes,
  mirrorPathFor,
  type BdProbe,
} from './dolt-bridge.ts'

const WIN32 = process.platform === 'win32'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/** tmpdir whose lifetime is the test — mkdtemp under os.tmpdir. */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bro-dolt-bridge-'))
}

/** Scripted bd probe — routes matched on args.join(' '); unmatched
 *  calls answer exit 1 (the "can't answer" branch). */
function fakeProbe(routes: Record<string, { code?: number; out?: string; err?: string }>): {
  probe: BdProbe
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    probe: (args) => {
      calls.push(args)
      const r = routes[args.join(' ')]
      return r === undefined
        ? { code: 1, out: '', err: 'unrouted' }
        : { code: r.code ?? 0, out: r.out ?? '', err: r.err ?? '' }
    },
  }
}

describe('gitUpstream', () => {
  test('git+http(s)/ssh/git schemes strip to the real URL', () => {
    assert.equal(gitUpstream('git+https://github.com/o/r.git'), 'https://github.com/o/r.git')
    assert.equal(gitUpstream('git+ssh://git@github.com/o/r.git'), 'ssh://git@github.com/o/r.git')
    assert.equal(gitUpstream('git+git@github.com:o/r.git'), 'git@github.com:o/r.git')
    assert.equal(gitUpstream('https://github.com/o/r.git'), 'https://github.com/o/r.git')
  })

  test('file/local/native remotes need no bridge', () => {
    for (const url of [
      'git+file:///tmp/m.git',
      'file:///tmp/m.git',
      '/abs/path/store',
      'dolthub://org/db',
      'aws://b/p/db',
    ]) {
      assert.equal(gitUpstream(url), null, url)
    }
  })
})

describe('fileTargetPath', () => {
  test('file-shaped remote urls resolve to paths', () => {
    assert.equal(fileTargetPath('git+file:///tmp/m.git'), '/tmp/m.git')
    assert.equal(fileTargetPath('file:///tmp/m.git'), '/tmp/m.git')
    assert.equal(fileTargetPath('/abs/m.git'), '/abs/m.git')
    assert.equal(fileTargetPath('git+https://x/y'), null)
  })
})

describe('listDoltRemotes', () => {
  test('parses the --json rows', () => {
    const { probe } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([
          { name: 'origin', url: 'git+https://x/y', sql_url: 'git+https://x/y', status: 'ok' },
          { name: 'evac', url: 'git+file:///tmp/m.git' },
        ]),
      },
    })
    assert.deepEqual(listDoltRemotes(probe), [
      { name: 'origin', url: 'git+https://x/y' },
      { name: 'evac', url: 'git+file:///tmp/m.git' },
    ])
  })

  test('falls back to the padded text form', () => {
    const { probe } = fakeProbe({
      'dolt remote list --json': { code: 1, err: 'no json' },
      'dolt remote list': { out: 'origin               git+https://x/y\nevac                 git+file:///tmp/m.git\n' },
    })
    assert.deepEqual(listDoltRemotes(probe), [
      { name: 'origin', url: 'git+https://x/y' },
      { name: 'evac', url: 'git+file:///tmp/m.git' },
    ])
  })

  test('null when bd cannot answer at all', () => {
    const { probe } = fakeProbe({})
    assert.equal(listDoltRemotes(probe), null)
  })
})

describe('doltSyncPlan', { skip: WIN32 }, () => {
  test('remote probe failure degrades to bare bd sync', () => {
    const { probe } = fakeProbe({})
    const plan = doltSyncPlan(probe, tmp())
    assert.deepEqual(plan.args, [])
    assert.deepEqual(plan.bridges, [])
  })

  test('git+https remote is repointed at a managed mirror', () => {
    const beads = tmp()
    const { probe, calls } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([{ name: 'origin', url: 'git+https://github.com/o/r.git' }]),
      },
      'dolt remote remove origin': { out: 'Removed remote "origin"' },
      ['dolt remote add origin git+file://' + join(beads, 'dolt-mirror-origin.git')]: {},
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, ['--remote', 'origin'])
    assert.equal(plan.bridges.length, 1)
    const b = plan.bridges[0]!
    assert.equal(b.mirror, join(beads, 'dolt-mirror-origin.git'))
    assert.equal(b.upstream, 'https://github.com/o/r.git')
    // the mirror is a real bare repo pinned at the upstream
    assert.equal(git('-C', b.mirror, 'rev-parse', '--is-bare-repository'), 'true')
    assert.equal(git('-C', b.mirror, 'remote', 'get-url', 'origin'), 'https://github.com/o/r.git')
    // remote was repointed through bd, once
    const repoints = calls.filter((c) => c[2] === 'remove' || c[2] === 'add')
    assert.deepEqual(
      repoints.map((c) => c.slice(0, 4).join(' ')),
      ['dolt remote remove origin', 'dolt remote add origin']
    )
    assert.ok(plan.notes.some((n) => n.startsWith('bridge: repointed origin')))
  })

  test('a failed repoint re-adds the original remote URL', () => {
    const beads = tmp()
    const { probe, calls } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([{ name: 'origin', url: 'git+https://u:p@github.com/o/r.git' }]),
      },
      'dolt remote remove origin': {},
      ['dolt remote add origin git+file://' + join(beads, 'dolt-mirror-origin.git')]: {
        code: 1,
        err: 'remote add blew up on git+https://u:p@github.com/o/r.git',
      },
      'dolt remote add origin git+https://u:p@github.com/o/r.git': {},
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.bridges, [])
    assert.ok(
      calls.some((c) => c.join(' ') === 'dolt remote add origin git+https://u:p@github.com/o/r.git'),
      'original remote restored'
    )
    const warn = plan.notes.find((n) => n.startsWith('warning: cannot bridge origin'))
    assert.ok(warn !== undefined)
    assert.ok(warn.includes('***@'), warn)
    assert.ok(!warn.includes('u:p@'), warn)
  })

  test('a remote already at a bridged file mirror is used in place — no repoint', () => {
    const beads = tmp()
    const mirror = join(beads, 'hand-mirror.git')
    git('init', '--bare', '-q', mirror)
    git('-C', mirror, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    const { probe, calls } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([{ name: 'origin', url: `git+file://${mirror}` }]),
      },
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, ['--remote', 'origin'])
    assert.equal(plan.bridges[0]?.mirror, mirror)
    assert.equal(plan.bridges[0]?.upstream, 'https://github.com/o/r.git')
    assert.ok(!calls.some((c) => c[2] === 'remove' || c[2] === 'add'), calls.map((c) => c.join(' ')).join('\n'))
  })

  test('a file remote at a plain directory stays direct', () => {
    const beads = tmp()
    const plain = join(beads, 'not-a-repo')
    mkdirSync(plain)
    const { probe } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([{ name: 'origin', url: `git+file://${plain}` }]),
      },
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, ['--remote', 'origin'])
    assert.deepEqual(plan.bridges, [])
  })

  test('a non-origin sole remote is still the sync target', () => {
    const beads = tmp()
    const { probe } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([{ name: 'mini', url: 'git+file:///plain/dir' }]),
      },
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, ['--remote', 'mini'])
  })

  test('multiple remotes without origin — bd picks, all bridges still run', () => {
    const beads = tmp()
    const { probe } = fakeProbe({
      'dolt remote list --json': {
        out: JSON.stringify([
          { name: 'a', url: 'git+file:///plain/a' },
          { name: 'b', url: 'git+file:///plain/b' },
        ]),
      },
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, [])
  })

  test('no remotes + bridgeable git origin — adoption goes through the bridge', () => {
    const repo = tmp()
    git('init', '-q', repo)
    git('-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    const beads = join(repo, '.beads')
    mkdirSync(beads)
    const { probe, calls } = fakeProbe({
      'dolt remote list --json': { out: '[]' },
      'where --json': { out: JSON.stringify({ path: beads }) },
      'dolt remote remove origin': { code: 1 },
      ['dolt remote add origin git+file://' + join(beads, 'dolt-mirror-origin.git')]: {},
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, ['--remote', 'origin'])
    assert.equal(plan.bridges.length, 1)
    assert.ok(existsSync(join(beads, 'dolt-mirror-origin.git', 'HEAD')))
    assert.ok(calls.some((c) => c.join(' ') === 'dolt remote add origin ' + `git+file://${join(beads, 'dolt-mirror-origin.git')}`))
  })

  test('no remotes and no git origin — bare sync, nothing provisioned', () => {
    const beads = tmp()
    const { probe, calls } = fakeProbe({
      'dolt remote list --json': { out: '[]' },
    })
    const plan = doltSyncPlan(probe, beads)
    assert.deepEqual(plan.args, [])
    assert.deepEqual(plan.bridges, [])
    assert.ok(!calls.some((c) => c[2] === 'add'))
  })
})

describe('bridge legs', { skip: WIN32 }, () => {
  /** bare upstream carrying dolt refs + a mirror remote'd at it. */
  function rig(): { upstream: string; mirror: string; head: string } {
    const dir = tmp()
    const work = join(dir, 'work')
    const upstream = join(dir, 'upstream.git')
    const mirror = join(dir, 'mirror.git')
    git('init', '-q', work)
    git('-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init')
    git('clone', '--bare', '-q', work, upstream)
    const head = git('-C', upstream, 'rev-parse', 'HEAD')
    git('-C', upstream, 'update-ref', 'refs/dolt/data', head)
    git('-C', upstream, 'update-ref', 'refs/heads/__dolt_remote_info__', head)
    git('init', '--bare', '-q', mirror)
    git('-C', mirror, 'remote', 'add', 'origin', upstream)
    rmSync(work, { recursive: true, force: true })
    return { upstream, mirror, head }
  }

  test('fetch lands upstream dolt refs in the mirror', () => {
    const { mirror, head } = rig()
    const err = bridgeFetch({ remote: 'origin', mirror, upstream: 'unused-here' })
    assert.equal(err, null)
    assert.equal(git('-C', mirror, 'rev-parse', 'refs/dolt/data'), head)
    assert.equal(git('-C', mirror, 'rev-parse', 'refs/heads/__dolt_remote_info__'), head)
  })

  test('fetch force-overwrites a locally-moved mirror head', () => {
    const { mirror, head, upstream } = rig()
    bridgeFetch({ remote: 'origin', mirror, upstream })
    // simulate a local publish: move the mirror head to a new commit
    const tree = git('-C', mirror, 'rev-parse', 'refs/dolt/data^{tree}')
    const moved = git(
      '-C', mirror, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit-tree', tree, '-p', head, '-m', 'local'
    )
    git('-C', mirror, 'update-ref', 'refs/dolt/data', moved)
    const err = bridgeFetch({ remote: 'origin', mirror, upstream })
    assert.equal(err, null)
    assert.equal(git('-C', mirror, 'rev-parse', 'refs/dolt/data'), head)
  })

  test('publish pushes only existing dolt refs upstream', () => {
    const { mirror, head, upstream } = rig()
    bridgeFetch({ remote: 'origin', mirror, upstream })
    const tree = git('-C', mirror, 'rev-parse', 'refs/dolt/data^{tree}')
    const moved = git(
      '-C', mirror, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit-tree', tree, '-p', head, '-m', 'local'
    )
    git('-C', mirror, 'update-ref', 'refs/dolt/data', moved)
    const err = bridgePublish({ remote: 'origin', mirror, upstream })
    assert.equal(err, null)
    assert.equal(git('-C', upstream, 'rev-parse', 'refs/dolt/data'), moved)
  })

  test('publish with no dolt refs is a no-op, not an error', () => {
    const dir = tmp()
    const mirror = join(dir, 'empty.git')
    const upstream = join(dir, 'up.git')
    git('init', '--bare', '-q', mirror)
    git('init', '--bare', '-q', upstream)
    git('-C', mirror, 'remote', 'add', 'origin', upstream)
    assert.equal(bridgePublish({ remote: 'origin', mirror, upstream }), null)
  })

  test('fetch failure reports an error line instead of throwing', () => {
    const dir = tmp()
    const mirror = join(dir, 'm.git')
    git('init', '--bare', '-q', mirror)
    git('-C', mirror, 'remote', 'add', 'origin', join(dir, 'gone.git'))
    const err = bridgeFetch({ remote: 'origin', mirror, upstream: 'x' })
    assert.ok(typeof err === 'string' && err !== '')
  })
})

describe('mirrorPathFor', () => {
  test('names the mirror after the remote under the beads dir', () => {
    assert.equal(mirrorPathFor('/b', 'origin'), '/b/dolt-mirror-origin.git')
    assert.equal(mirrorPathFor('/b', 'we ird'), '/b/dolt-mirror-we_ird.git')
  })
})
