import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, TaskRow, TaskStore } from '@broject/core'
import {
  agentProcessesIn,
  branchSlug,
  buildFixerPrompt,
  candidateBranches,
  detailMatches,
  driveArgs,
  ensureFixerWorktree,
  fixerBeadFor,
  fixerRef,
  liveWorkDetails,
  occupied,
  worktreeClaim,
} from './drive.ts'
import { driveSection } from './drive-config.ts'
import { git, initRepo, inside } from './testrepo.ts'

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'native-aaa',
  molStep: 'bro-x',
  backend: 'native',
  state: 'running',
  ...over,
})

describe('driveArgs', () => {
  test('defaults: one pass, merge on', () => {
    assert.deepEqual(driveArgs([]), { json: false, merge: true, connector: undefined })
    assert.deepEqual(driveArgs(['--once']), { json: false, merge: true, connector: undefined })
  })

  test('flags parse', () => {
    assert.deepEqual(driveArgs(['--every', '60', '--no-merge', '--json', '--connector', 'tmux']), {
      everySec: 60,
      merge: false,
      json: true,
      connector: 'tmux',
    })
    assert.equal(driveArgs(['--every=15']).everySec, 15)
    // a bare --every takes the configured cadence
    assert.equal(driveArgs(['--every']).everySec, 300)
    assert.equal(driveArgs(['--every'], 60).everySec, 60)
    assert.equal(driveArgs(['--every', '--json']).everySec, 300)
  })

  test('a bad --every fails closed', () => {
    for (const v of ['abc', '0', '-5', 'NaN', '3000000000']) {
      assert.throws(() => driveArgs(['--every', v]), /--every/)
    }
  })
})

describe('driveSection', () => {
  test('defaults', () => {
    assert.deepEqual(driveSection(undefined), { intervalSec: 300, merge: 'auto' })
    assert.deepEqual(driveSection({}), { intervalSec: 300, merge: 'auto' })
    assert.deepEqual(driveSection('garbage'), { intervalSec: 300, merge: 'auto' })
  })

  test('values survive; junk falls back', () => {
    assert.deepEqual(driveSection({ intervalSec: 60, merge: 'never' }), {
      intervalSec: 60,
      merge: 'never',
    })
    assert.equal(driveSection({ intervalSec: -5 }).intervalSec, 300)
    assert.equal(driveSection({ merge: 'always' }).merge, 'auto')
  })
})

describe('candidateBranches', () => {
  test('worktree branches + fleet-prefixed locals, deduped', () => {
    const { root, main } = initRepo('bro-drive-cand-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      git(['branch', 'loop/bro-b'], main)
      git(['branch', 'stack/s/1-bro-c'], main)
      git(['branch', 'random/topic'], main)
      git(['worktree', 'add', '-q', join(root, 'side'), 'work/bro-a'], main)
      const branches = candidateBranches(main)
      assert.ok(branches.includes('work/bro-a'))
      assert.ok(branches.includes('loop/bro-b'))
      assert.ok(branches.includes('stack/s/1-bro-c'))
      assert.ok(!branches.includes('random/topic'))
      assert.equal(branches.filter((b) => b === 'work/bro-a').length, 1)
    })
  })
})

describe('branchSlug', () => {
  test('last path segment', () => {
    assert.equal(branchSlug('work/bro-tui8'), 'bro-tui8')
    assert.equal(branchSlug('stack/s/3-bro-x'), '3-bro-x')
    assert.equal(branchSlug('plain'), 'plain')
  })
})

describe('detailMatches', () => {
  const ctx = { branch: 'work/bro-a', slug: 'bro-a', worktree: '/repos/bro--bro-a' }

  test('bead id / slug / branch', () => {
    assert.ok(detailMatches('bro-a', ctx))
    assert.ok(detailMatches('work/bro-a', ctx))
    assert.ok(!detailMatches('bro-b', ctx))
  })

  test('worktree path and basename', () => {
    assert.ok(detailMatches('bro--bro-a', ctx))
    assert.ok(detailMatches('../bro--bro-a', ctx))
    assert.ok(detailMatches('/repos/bro--bro-a', ctx))
    assert.ok(!detailMatches('bro--bro-b', ctx))
  })

  test('no worktree still matches bead/branch', () => {
    const bare = { branch: 'work/bro-a', slug: 'bro-a' }
    assert.ok(detailMatches('bro-a', bare))
    assert.ok(!detailMatches('../bro--bro-a', bare))
  })
})

describe('liveWorkDetails', () => {
  test('fresh markers yield every detail line; stale ones yield none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-drive-hooks-'))
    try {
      writeFileSync(join(dir, 's1.work'), `${Date.now()}\nbro-a\nwork/bro-b\n`)
      writeFileSync(join(dir, 's2.work'), `${Date.now()}\nbro-c\n`)
      const stale = join(dir, 'old.work')
      writeFileSync(stale, `${Date.now()}\nbro-z\n`)
      // mtime is the freshness signal — age the file past LIVE_MARKER_MS
      const old = Date.now() - 48 * 60 * 60 * 1000
      utimesSync(stale, old / 1000, old / 1000)
      writeFileSync(join(dir, 'note.task'), `${Date.now()}\nbro-q\n`) // not a .work marker
      const details = liveWorkDetails(dir)
      assert.deepEqual(details.sort(), ['bro-a', 'bro-c', 'work/bro-b'].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing dir is empty, not an error', () => {
    assert.deepEqual(liveWorkDetails('/no/such/dir'), [])
  })
})

describe('agentProcessesIn', () => {
  /** Minimal /proc tree: <pid>/cwd symlink + cmdline/environ files,
   *  plus a status file carrying PPid when the test wires ancestry. */
  function fakeProc(): {
    proc: string
    mk: (pid: number, cwd: string, cmdline: string, environ?: string, ppid?: number) => void
    rm: () => void
  } {
    const proc = mkdtempSync(join(tmpdir(), 'bro-drive-proc-'))
    return {
      proc,
      rm: () => rmSync(proc, { recursive: true, force: true }),
      mk: (pid, cwd, cmdline, environ, ppid) => {
        const dir = join(proc, String(pid))
        mkdirSync(dir)
        symlinkSync(cwd, join(dir, 'cwd'))
        writeFileSync(join(dir, 'cmdline'), cmdline)
        if (environ !== undefined) {
          writeFileSync(join(dir, 'environ'), environ)
        }
        if (ppid !== undefined) {
          writeFileSync(join(dir, 'status'), `Name:\tx\nPPid:\t${ppid}\n`)
        }
      },
    }
  }

  test('agent-shaped cmdlines inside the worktree count; others do not', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(101, wt, 'devin\0-p\0fix stuff')
      mk(102, join(wt, 'sub', 'dir'), 'claude\0-p\0x') // nested cwd counts
      mk(103, wt, 'node\0tsc\0--watch') // leftover watcher — NOT an agent
      mk(104, '/elsewhere', 'devin\0-p\0x') // right cmdline, wrong tree
      const hits = agentProcessesIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits.sort(), [101, 102])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('BRO_AGENT_ID in environ marks a bro-spawned worker whatever the cmdline', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(201, wt, 'sh\0-c\0worker', 'PATH=/bin\0BRO_AGENT_ID=native-abc\0')
      assert.deepEqual(agentProcessesIn(wt, proc).map((h) => h.pid), [201])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a tool shell inside the worktree counts via its agent ancestor (bro-pywx)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const main = mkdtempSync(join(tmpdir(), 'bro-drive-main-'))
    const { proc, mk, rm } = fakeProc()
    try {
      // the incident shape: the agent CLI sits at its launch dir while
      // its tool shell holds the worktree cwd — own-cmdline-only scans
      // see nothing agent-shaped in the tree at all
      mk(301, main, 'devin\0-p\0--permission-mode\0dangerous') // the session, cwd = launch dir
      mk(302, main, 'devin\0acp', undefined, 301) // its acp child, still outside
      mk(303, wt, 'bash', undefined, 302) // tool shell inside the worktree
      mk(304, join(wt, 'x'), 'sleep\030', undefined, 303) // its command, one hop deeper
      mk(305, wt, 'bash', undefined, 999) // a human shell — no agent ancestor
      const hits = agentProcessesIn(wt, proc).map((h) => h.pid)
      assert.deepEqual(hits.sort(), [303, 304])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
      rmSync(main, { recursive: true, force: true })
    }
  })

  test('AI_AGENT in environ badges devin-spawned descendants', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(401, wt, 'node\0server.js', 'PATH=/bin\0AI_AGENT=devin_3000-11-3_agent\0')
      mk(402, wt, 'node\0x.js', 'PATH=/bin\0NOT_AI_AGENT=yep\0') // anchored — no match
      assert.deepEqual(agentProcessesIn(wt, proc).map((h) => h.pid), [401])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a cyclic ppid chain terminates the walk instead of hanging', () => {
    const wt = mkdtempSync(join(tmpdir(), 'bro-drive-wt-'))
    const { proc, mk, rm } = fakeProc()
    try {
      mk(501, wt, 'weird', undefined, 502)
      mk(502, wt, 'weird', undefined, 501)
      assert.deepEqual(agentProcessesIn(wt, proc), [])
    } finally {
      rm()
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('a missing procDir is empty — non-Linux degrades, never blocks', () => {
    assert.deepEqual(agentProcessesIn('/tmp', '/no/such/proc'), [])
  })
})

describe('occupied', () => {
  const base = {
    agents: [] as AgentInfo[],
    branch: 'work/bro-a',
    worktree: '/repos/bro--bro-a',
    workDetails: [] as string[],
  }

  test('no signals → orphaned', () => {
    assert.equal(occupied(base), undefined)
  })

  test('a live fixer agent is reported as the fixer, not a foreign occupant', () => {
    const why = occupied({ ...base, fixerBead: 'bro-fix1', agents: [agent({ molStep: 'bro-fix1' })] })
    assert.match(why ?? '', /fixer agent live/)
  })

  test('a live agent recorded in the worktree occupies it', () => {
    const why = occupied({
      ...base,
      agents: [agent({ id: 'native-zz', worktree: '/repos/bro--bro-a' })],
    })
    assert.match(why ?? '', /native-zz.*live/)
  })

  test('exited agents do not occupy', () => {
    const why = occupied({
      ...base,
      agents: [agent({ state: 'exited', worktree: '/repos/bro--bro-a' })],
    })
    assert.equal(why, undefined)
  })

  test('a fresh marker detail naming the bead occupies', () => {
    const why = occupied({ ...base, workDetails: ['bro-a'] })
    assert.match(why ?? '', /armed work/)
  })

  test('a marker for other work does not occupy', () => {
    const why = occupied({ ...base, workDetails: ['bro-unrelated'] })
    assert.equal(why, undefined)
  })

  test('a live agent-shaped process in the worktree occupies', () => {
    const why = occupied({
      ...base,
      scanProc: () => [{ pid: 42, cmd: 'devin -p x' }],
    })
    assert.match(why ?? '', /process 42/)
  })

  test('the worktree claim marker occupies without any name matching', () => {
    const why = occupied({ ...base, scanClaim: () => 'bro-a' })
    assert.match(why ?? '', /claimed by bro-a/)
  })

  test('a claimed worktree still reports the fixer as the fixer', () => {
    const why = occupied({
      ...base,
      fixerBead: 'bro-fix1',
      agents: [agent({ molStep: 'bro-fix1' })],
      scanClaim: () => 'bro-a',
    })
    assert.match(why ?? '', /fixer agent live/)
  })
})

describe('worktreeClaim', () => {
  /** A worktree whose .git is the pointer file a linked tree gets. */
  function fakeWorktree(): { wt: string; gitdir: string; rm: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'bro-drive-claim-'))
    const wt = join(root, 'repo--x')
    const gitdir = join(root, 'repo', '.git', 'worktrees', 'repo--x')
    mkdirSync(gitdir, { recursive: true })
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    return { wt, gitdir, rm: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('fresh marker returns its detail; stale or missing reads unclaimed', () => {
    const { wt, gitdir, rm } = fakeWorktree()
    try {
      assert.equal(worktreeClaim(wt), undefined)
      mkdirSync(join(gitdir, 'bro'), { recursive: true })
      const marker = join(gitdir, 'bro', 'work')
      writeFileSync(marker, '123\nbro-x\n')
      assert.equal(worktreeClaim(wt), 'bro-x')
      const old = new Date(Date.now() - 48 * 3_600_000)
      utimesSync(marker, old, old)
      assert.equal(worktreeClaim(wt), undefined)
    } finally {
      rm()
    }
  })

  test('a main checkout reads its .git dir the same way', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-drive-claim-'))
    try {
      const gd = join(root, '.git')
      mkdirSync(join(gd, 'bro'), { recursive: true })
      writeFileSync(join(gd, 'bro', 'work'), '1\n\n')
      assert.equal(worktreeClaim(root), '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('fixerBeadFor', () => {
  const stubStore = (rows: TaskRow[]): TaskStore =>
    ({
      list: () => rows,
    }) as unknown as TaskStore

  test('finds the open fixer bead by external_ref', () => {
    const rows = [
      { id: 'b1', external_ref: fixerRef(7), status: 'open', labels: ['fixer'] },
      { id: 'b2', external_ref: 'something-else', status: 'open', labels: ['fixer'] },
    ] as TaskRow[]
    assert.equal(fixerBeadFor(stubStore(rows), 7)?.id, 'b1')
    assert.equal(fixerBeadFor(stubStore(rows), 8), undefined)
  })

  test('a closed fixer bead is not reused', () => {
    const rows = [
      { id: 'b1', external_ref: fixerRef(7), status: 'closed', labels: ['fixer'] },
    ] as TaskRow[]
    assert.equal(fixerBeadFor(stubStore(rows), 7), undefined)
  })
})

describe('buildFixerPrompt', () => {
  test('carries the PR link, branch, worktree, threads, and the no-merge rule', () => {
    const p = buildFixerPrompt({
      pr: 42,
      link: '[#42](https://github.com/o/r/pull/42)',
      branch: 'work/bro-a',
      worktree: '/repos/bro--bro-a',
      threads: [
        { path: 'src/x.ts', line: 10, author: 'greptile', body: 'unchecked null' },
        { path: 'src/y.ts', line: 5, author: 'cubic', body: 'drop the cast' },
      ],
    })
    assert.match(p, /#42.*pull\/42/)
    assert.match(p, /work\/bro-a/)
    assert.match(p, /bro--bro-a/)
    assert.match(p, /src\/x\.ts:10 \[greptile\] unchecked null/)
    assert.match(p, /NEVER merge/)
  })
})

describe('ensureFixerWorktree', () => {
  test('reuses the conventional dir on the right branch; a foreign one falls back', () => {
    const { root, main } = initRepo('bro-drive-wtx-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      git(['branch', 'work/bro-b'], main)
      git(['branch', 'work/bro-c'], main)
      const dir = join(root, 'main--bro-a')
      git(['worktree', 'add', '-q', dir, 'work/bro-a'], main)
      assert.equal(ensureFixerWorktree(main, 'work/bro-a').path, dir)
      // main--bro-c stands on a different branch — never clobbered; the
      // branch-namespaced path takes the checkout instead
      const foreign = join(root, 'main--bro-c')
      git(['worktree', 'add', '-q', foreign, 'work/bro-b'], main)
      const r = ensureFixerWorktree(main, 'work/bro-c')
      assert.equal(r.path, join(root, 'main--work-bro-c'))
      assert.equal(r.created, true)
      assert.equal(git(['-C', r.path!, 'branch', '--show-current'], main).trim(), 'work/bro-c')
      assert.equal(git(['-C', foreign, 'branch', '--show-current'], main).trim(), 'work/bro-b')
    })
  })

  test('every name held by a foreign branch is a named refusal', () => {
    const { root, main } = initRepo('bro-drive-wtf-')
    inside(main, root, () => {
      git(['branch', 'work/bro-b'], main)
      git(['branch', 'work/bro-e'], main)
      git(['worktree', 'add', '-q', join(root, 'main--bro-d'), 'work/bro-b'], main)
      git(['worktree', 'add', '-q', join(root, 'main--work-bro-d'), 'work/bro-e'], main)
      assert.match(ensureFixerWorktree(main, 'work/bro-d').err ?? '', /foreign branch/)
    })
  })

  test('creates the worktree on an existing uncheckout branch', () => {
    const { root, main } = initRepo('bro-drive-wtc-')
    inside(main, root, () => {
      git(['branch', 'work/bro-a'], main)
      const r = ensureFixerWorktree(main, 'work/bro-a')
      assert.equal(r.err, undefined)
      assert.equal(r.created, true)
      assert.equal(git(['-C', r.path!, 'branch', '--show-current'], main).trim(), 'work/bro-a')
    })
  })
})
