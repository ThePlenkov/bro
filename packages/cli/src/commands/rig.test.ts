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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, initRepo } from './testrepo.ts'
import {
  resolveRigRepo,
  rigStatus,
  rigSync,
} from './rig.ts'
import { rigSection, type RigConfig } from './rig-config.ts'
import {
  armRigPulse,
  disarmRigPulse,
  readRigPulseMarker,
  rigPulseLive,
  rigPulseLockPath,
  rigPulseMarkerPath,
  rigPulseRearm,
  rigPulseState,
  readRigPulseSpawn,
  writeRigPulseSpawn,
} from './rig-pulse.ts'

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
  const cfg: RigConfig = { intervalSec: 600, pulseSec: 900 }

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
        assert.match(s.pulse!, /absent|armed/)
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
  test('defaults — repo unset, 600s cadence, 900s window', () => {
    const d = { repo: undefined, intervalSec: 600, pulseSec: 900 }
    assert.deepEqual(rigSection(undefined), d)
    assert.deepEqual(rigSection({}), d)
  })

  test('repo string keeps, bad intervalSec/pulseSec fall back', () => {
    assert.deepEqual(rigSection({ repo: ' /x ', intervalSec: 42, pulseSec: 1200 }), {
      repo: '/x',
      intervalSec: 42,
      pulseSec: 1200,
    })
    assert.equal(rigSection({ intervalSec: 0 }).intervalSec, 600)
    assert.equal(rigSection({ intervalSec: 'x' as unknown as number }).intervalSec, 600)
    assert.equal(rigSection({ pulseSec: 0 }).pulseSec, 900)
    assert.equal(rigSection({ pulseSec: 'x' as unknown as number }).pulseSec, 900)
  })
})

const rigLock = (main: string, content: string, mtimeAgoMs = 0): void => {
  const p = rigPulseLockPath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  if (mtimeAgoMs > 0) {
    const t = new Date(Date.now() - mtimeAgoMs)
    utimesSync(p, t, t)
  }
}

describe('rig pulse (session-pulse model, bro-killn)', () => {
  test('marker + lock resolve under <git-common>/bro', () => {
    const { root, main } = initRepo('bro-rig-ppath-')
    try {
      assert.equal(rigPulseMarkerPath(main), join(main, '.git', 'bro', 'rig-pulse.json'))
      assert.equal(rigPulseLockPath(main), join(main, '.git', 'bro', 'rig-pulse.lock'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('arm → already → updated; disarm → disarmed → absent; repo is required', () => {
    const { root, main } = initRepo('bro-rig-parm-')
    try {
      const a = armRigPulse(main, main, 120)
      assert.equal(a.state, 'armed')
      assert.deepEqual(readRigPulseMarker(main)?.repo, main)
      assert.equal(armRigPulse(main, main, 120).state, 'already')
      assert.equal(armRigPulse(main, main, 60).state, 'updated')
      assert.equal(readRigPulseMarker(main)?.everySec, 60)
      assert.equal(disarmRigPulse(main), 'disarmed')
      assert.equal(readRigPulseMarker(main), null)
      assert.equal(disarmRigPulse(main), 'absent')
      // a torn marker (no repo) reads as absent — never a half-shape rearm
      const file = rigPulseMarkerPath(main)!
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ everySec: 60, armedAt: 'x' }))
      assert.equal(readRigPulseMarker(main), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pulseLive — dead holder and garbage are not live; live pid is', () => {
    const { root, main } = initRepo('bro-rig-plive-')
    try {
      assert.deepEqual(rigPulseLive(main), { live: false })
      rigLock(main, `${1 << 30}:tok`)
      assert.deepEqual(rigPulseLive(main), { live: false })
      rigLock(main, 'garbage')
      assert.deepEqual(rigPulseLive(main), { live: false })
      rigLock(main, `${process.pid}:tok`)
      assert.deepEqual(rigPulseLive(main), { live: true, pid: process.pid })
      // a live pid on a heartbeat-dead lock is reuse, not a pulse —
      // older than LOCK_ABANDONED_MS (15m) the steal rule calls it stale
      rigLock(main, `${process.pid}:tok`, 20 * 60_000)
      assert.deepEqual(rigPulseLive(main), { live: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rigPulseState reports absent / armed-dead / armed-live', () => {
    const { root, main } = initRepo('bro-rig-pstate-')
    try {
      assert.match(rigPulseState(main), /absent/)
      armRigPulse(main, main, 600)
      assert.match(rigPulseState(main), /armed every 600s — dead/)
      rigLock(main, `${process.pid}:tok`)
      assert.match(rigPulseState(main), new RegExp(`armed every 600s — live \\(pid ${process.pid}\\)`))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rearm — armed + dead + orchestrator → rearm with --for floored at --every', () => {
    const { root, main } = initRepo('bro-rig-prm-')
    try {
      assert.deepEqual(rigPulseRearm(main, 900, {}), { kind: 'quiet' }) // unarmed
      armRigPulse(main, main, 120)
      assert.deepEqual(rigPulseRearm(main, 900, {}), {
        kind: 'rearm',
        repo: main,
        everySec: 120,
        forSec: 900,
      })
      armRigPulse(main, main, 1200)
      assert.deepEqual(rigPulseRearm(main, 900, {}), {
        kind: 'rearm',
        repo: main,
        everySec: 1200,
        forSec: 1200,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rearm — live lock, live recorded spawn, and BRO_AGENT_ID all stay quiet', () => {
    const { root, main } = initRepo('bro-rig-prq-')
    try {
      armRigPulse(main, main, 120)
      rigLock(main, `${process.pid}:tok`)
      assert.deepEqual(rigPulseRearm(main, 900, {}), { kind: 'quiet' })
      rmSync(rigPulseLockPath(main)!)
      writeRigPulseSpawn(main, { pid: process.pid, spawnedAt: 'x' })
      assert.deepEqual(rigPulseRearm(main, 900, {}), { kind: 'quiet' })
      writeRigPulseSpawn(main, { pid: 1 << 30, spawnedAt: 'x' })
      assert.deepEqual(rigPulseRearm(main, 900, { BRO_AGENT_ID: 'native-x' }), { kind: 'quiet' })
      assert.equal(readRigPulseSpawn(main)?.pid, 1 << 30)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
