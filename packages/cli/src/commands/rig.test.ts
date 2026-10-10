/** `bro rig` unit tests — real git on tmpdirs (initRepo/testrepo), the
 *  refresh and done-sha injected so no npm/build runs. `rigSync` itself
 *  shells only to git: remote drift is staged through a bare remote and
 *  a second clone, never by editing refs by hand. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, initRepo } from './testrepo.ts'
import {
  resolveRigRepo,
  rigStatus,
  rigSync,
  RIG_SPEC,
} from './rig.ts'
import { rigSection, type RigConfig } from './rig-config.ts'
import { cronTag, schedState, unitName } from './sched.ts'

const tmp = (p = 'bro-rig-'): string => mkdtempSync(join(tmpdir(), p))

/** A repo with `main` tracking a bare `origin` — plus a second clone
 *  to push remote-side commits with. `node: true` (default) seeds the
 *  bootstrap gate (committed package.json + .gitignore'd node_modules)
 *  so the refresh path runs. */
function initTracked(
  prefix: string,
  opts: { node?: boolean } = {}
): { root: string; main: string; remote: string; other: string } {
  const node = opts.node !== false
  const { root, main } = initRepo(prefix, (m) => {
    if (!node) {
      return
    }
    writeFileSync(join(m, 'package.json'), '{"name":"x","scripts":{"build":"true"}}')
    writeFileSync(join(m, '.gitignore'), 'node_modules\n')
  })
  if (node) {
    mkdirSync(join(main, 'node_modules'), { recursive: true })
  }
  const remote = join(root, 'remote.git')
  // -b main: a bare remote's HEAD symref names the clone's checkout —
  // without it the clone lands on master and pushes the wrong branch
  git(['init', '--bare', '-q', '-b', 'main', remote], root)
  git(['remote', 'add', 'origin', remote], main)
  git(['push', '-q', '-u', 'origin', 'main'], main)
  const other = join(root, 'other')
  git(['clone', '-q', remote, other], root)
  git(['config', 'user.email', 't@t'], other)
  git(['config', 'user.name', 't'], other)
  return { root, main, remote, other }
}

/** One commit on the remote — `main` falls a commit behind. */
function pushRemote(other: string, name = 'f'): string {
  writeFileSync(join(other, name), name)
  git(['add', '-A'], other)
  git(['commit', '-qm', name], other)
  git(['push', '-q'], other)
  return git(['rev-parse', 'HEAD'], other).trim()
}

const headOf = (repo: string): string => git(['rev-parse', 'HEAD'], repo).trim()

/** refresh stub: record the call, no npm. doneSha stub answers the
 *  current head — the "refresh completed" verdict. */
const okDeps = () => {
  const calls: string[] = []
  const notes: string[] = []
  return {
    calls,
    notes,
    deps: {
      refresh: (cwd: string) => calls.push(cwd),
      notify: (t: string) => notes.push(t),
      doneSha: (cwd: string) => headOf(cwd),
    },
  }
}

describe('resolveRigRepo', () => {
  const cfg: RigConfig = { intervalSec: 600 }

  test('flag > config > main worktree; ~ and relative expand', () => {
    const { root, main } = initRepo('bro-rig-res-')
    try {
      const flag = resolveRigRepo(main, cfg, '~/x')
      assert.deepEqual(flag, { repo: join(process.env.HOME!, 'x'), via: 'flag' })
      assert.deepEqual(resolveRigRepo(main, cfg, 'rel'), {
        repo: join(main, 'rel'),
        via: 'flag',
      })
      const conf = resolveRigRepo(main, { ...cfg, repo: '/abs/cfg' })
      assert.deepEqual(conf, { repo: '/abs/cfg', via: 'config' })
      assert.deepEqual(resolveRigRepo(main, cfg), { repo: main, via: 'worktree' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('auto-resolution lands on the MAIN worktree, not a linked one', () => {
    const { root, main } = initRepo('bro-rig-res-wt-')
    try {
      const linked = join(root, 'linked')
      git(['worktree', 'add', '-q', linked, '-b', 'loop/x'], main)
      // cwd inside the linked worktree still resolves the main checkout
      assert.deepEqual(resolveRigRepo(linked, cfg), { repo: main, via: 'worktree' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('not a repo → error naming the override paths', () => {
    const d = tmp()
    try {
      const r = resolveRigRepo(d, cfg)
      assert.ok('error' in r)
      assert.match(r.error, /--repo|rig\.repo/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('rigSync', () => {
  test('non-worktree → error', () => {
    const d = tmp()
    try {
      const r = rigSync(d)
      assert.equal(r.state, 'error')
      assert.match(r.detail, /not a git worktree/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test('dirty tree → skipped, never fetched into', () => {
    const { root, main } = initTracked('bro-rig-dirty-')
    try {
      writeFileSync(join(main, 'wip'), 'wip')
      const r = rigSync(main, okDeps().deps)
      assert.equal(r.state, 'skipped')
      assert.match(r.detail, /dirty/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no upstream → error', () => {
    const { root, main } = initRepo('bro-rig-noup-')
    try {
      const r = rigSync(main, okDeps().deps)
      assert.equal(r.state, 'error')
      assert.match(r.detail, /no upstream/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('behind → ff-pull, notify drop, refresh call, synced', () => {
    const { root, main, other } = initTracked('bro-rig-pull-')
    try {
      const remoteHead = pushRemote(other)
      const before = headOf(main)
      const { deps, calls, notes } = okDeps()
      const r = rigSync(main, deps)
      assert.equal(r.state, 'synced')
      assert.equal(headOf(main), remoteHead)
      assert.deepEqual(r.pulled, { from: before, to: remoteHead })
      assert.equal(r.upstream, 'origin/main')
      assert.deepEqual(calls, [main])
      assert.equal(notes.length, 1)
      assert.match(notes[0]!, /pulled .*\.\./)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('current → refresh still runs (heals a frozen done-sha)', () => {
    const { root, main } = initTracked('bro-rig-cur-')
    try {
      const { deps, calls, notes } = okDeps()
      const r = rigSync(main, deps)
      assert.equal(r.state, 'current')
      assert.deepEqual(calls, [main])
      assert.equal(notes.length, 0)
      assert.equal(r.pulled, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('diverged → error, tree untouched', () => {
    const { root, main, other } = initTracked('bro-rig-div-')
    try {
      pushRemote(other)
      writeFileSync(join(main, 'local'), 'local')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'local'], main)
      const head = headOf(main)
      const r = rigSync(main, okDeps().deps)
      assert.equal(r.state, 'error')
      assert.match(r.detail, /diverged/)
      assert.equal(headOf(main), head) // merge never attempted
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ahead-only → current, no pull', () => {
    const { root, main } = initTracked('bro-rig-ahead-')
    try {
      writeFileSync(join(main, 'local'), 'local')
      git(['add', '-A'], main)
      git(['commit', '-qm', 'local'], main)
      const r = rigSync(main, okDeps().deps)
      assert.equal(r.state, 'current')
      assert.match(r.detail, /ahead/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('not bootstrapped → pull lands, refresh skipped with the note', () => {
    const { root, main, other } = initTracked('bro-rig-noboot-', { node: false })
    try {
      pushRemote(other)
      const { deps, calls } = okDeps()
      const r = rigSync(main, deps)
      assert.equal(r.state, 'synced')
      assert.match(r.detail, /not bootstrapped/)
      assert.deepEqual(calls, []) // no npm on a repo that never installed
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('done-sha behind HEAD after refresh → incomplete', () => {
    const { root, main, other } = initTracked('bro-rig-inc-')
    try {
      pushRemote(other)
      const r = rigSync(main, {
        refresh: () => {},
        notify: () => {},
        doneSha: () => 'deadbeef'.padEnd(40, '0'),
      })
      assert.equal(r.state, 'incomplete')
      assert.match(r.detail, /done-sha/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('rigStatus', () => {
  test('reports branch, upstream, drift, freshness, steps', () => {
    const { root, main, other } = initTracked('bro-rig-stat-')
    const xdg = tmp('bro-rig-xdg-')
    try {
      // a deterministic patch slot: XDG_DATA_HOME/bro/hotpatch.sh, executable
      mkdirSync(join(xdg, 'bro'), { recursive: true })
      const hp = join(xdg, 'bro', 'hotpatch.sh')
      writeFileSync(hp, '#!/bin/sh\nexit 0\n')
      chmodSync(hp, 0o755)
      const prev = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = xdg
      try {
        pushRemote(other)
        // stored ref only — status never fetches, so "behind" needs the
        // remote-tracking ref moved first
        git(['fetch', '-q'], main)
        writeFileSync(join(main, 'local'), 'local')
        git(['add', '-A'], main)
        git(['commit', '-qm', 'local'], main)
        const s = rigStatus(main, 'test')
        assert.equal(s.branch, 'main')
        assert.equal(s.upstream, 'origin/main')
        assert.equal(s.behind, 1)
        assert.equal(s.ahead, 1)
        assert.equal(s.dirty, 0)
        assert.equal(s.bootstrapped, true)
        assert.equal(s.fresh, false) // never refreshed → done-sha ≠ HEAD
        assert.ok(s.steps!.some((x) => x.includes('install')))
        assert.ok(s.steps!.some((x) => x.includes('build')))
        assert.ok(s.steps!.some((x) => x.includes('hotpatch.sh')))
        assert.match(s.scheduler!, /none|unknown|systemd|cron|both/)
      } finally {
        if (prev === undefined) {
          delete process.env.XDG_DATA_HOME
        } else {
          process.env.XDG_DATA_HOME = prev
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  test('non-worktree → error field', () => {
    const d = tmp()
    try {
      const s = rigStatus(d, 'test')
      assert.match(s.error!, /not a git worktree/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('rig config section', () => {
  test('defaults — repo unset, 600s cadence', () => {
    assert.deepEqual(rigSection(undefined), { repo: undefined, intervalSec: 600 })
    assert.deepEqual(rigSection({}), { repo: undefined, intervalSec: 600 })
  })

  test('repo string keeps, bad intervalSec falls back to 600', () => {
    assert.deepEqual(rigSection({ repo: ' /x ', intervalSec: 42 }), {
      repo: '/x',
      intervalSec: 42,
    })
    assert.equal(rigSection({ intervalSec: 0 }).intervalSec, 600)
    assert.equal(rigSection({ intervalSec: 'x' as unknown as number }).intervalSec, 600)
  })
})

describe('rig scheduler spec', () => {
  test('units/tag hash the repo common dir under bro-rig-*', () => {
    const { root, main } = initRepo('bro-rig-sched-')
    try {
      const common = join(main, '.git')
      assert.match(unitName(RIG_SPEC, common), /^bro-rig-[0-9a-f]{8}$/)
      assert.match(cronTag(RIG_SPEC, common), /^# bro-rig-[0-9a-f]{8}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('schedState — none without units/cron, cron when tag present', () => {
    const { root, main } = initRepo('bro-rig-schedst-')
    const home = tmp('bro-rig-home-')
    try {
      const common = join(main, '.git')
      const tag = cronTag(RIG_SPEC, common)
      // no crontab binary → 'none'
      const missing = schedState(RIG_SPEC, main, {
        run: () => ({ code: 127, out: '', err: 'missing' }),
        home,
      })
      assert.equal(missing.state, 'none')
      // tagged line in the table → 'cron'
      const cron = schedState(RIG_SPEC, main, {
        run: (cmd, args) =>
          args[0] === '-l' ? { code: 0, out: `* * * * * x ${tag}\n`, err: '' } : { code: 127, out: '', err: '' },
        home,
      })
      assert.equal(cron.state, 'cron')
      assert.match(cron.unit, /^bro-rig-/)
      // unit files under the injected HOME → 'systemd'
      const unitDir = join(home, '.config', 'systemd', 'user')
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(unitDir, `${cron.unit}.timer`), 'x')
      const systemd = schedState(RIG_SPEC, main, {
        run: () => ({ code: 127, out: '', err: 'missing' }),
        home,
      })
      assert.equal(systemd.state, 'systemd')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
