import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mergeQueueHost, registerConnector } from '@broject/core'
import { graphiteConnector, graphiteQueue, mergifyConnector, mergifyQueue } from './merge-queue.ts'

const WIN32 = process.platform === 'win32'

/** Scripted gh + gt on PATH for the external queue connectors. gh
 *  answers `pr view` by the requested field (--json state | comments),
 *  swallows `pr comment`/`pr edit`, logs every call; gt logs to its own
 *  file and can be failed via FAKE_GT_FAIL. */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
if [ -z "$FAKE_GH_STATE" ]; then FAKE_GH_STATE='OPEN'; fi
if [ -z "$FAKE_GH_HEAD" ]; then FAKE_GH_HEAD='sha-1'; fi
if [ -z "$FAKE_GH_COMMENTS" ]; then FAKE_GH_COMMENTS='{"comments":[]}'; fi
case "$1 $2" in
  "pr view") case "$@" in
      *"--json state,headRefOid"*) echo '{"state":"'"$FAKE_GH_STATE"'","headRefOid":"'"$FAKE_GH_HEAD"'"}' ;;
      *"--json state"*) echo '{"state":"'"$FAKE_GH_STATE"'"}' ;;
      *"--json comments"*) echo "$FAKE_GH_COMMENTS" ;;
      *) echo '{}' ;;
    esac ;;
  "pr comment") : ;;
  "pr edit") : ;;
  "auth status") exit 0 ;;
esac
`

const FAKE_GT = `#!/bin/sh
echo "$@" >> "$FAKE_GT_LOG"
case "$1" in
  --version) echo '1.6.0' ;;
  merge) if [ "$FAKE_GT_FAIL" = "1" ]; then echo 'gt: the current branch is not tracked' >&2; exit 1; fi
      echo 'Merged 1 pull request' ;;
esac
`

interface FakeTools {
  dir: string
  ghLog: string
  gtLog: string
  ghCalls(): string
  gtCalls(): string
}

/** tmpdir with a real git repo (graphite's headRef check runs real git)
 *  and fake gh/gt first on PATH. `env` drives the FAKE_* knobs; `config`
 *  lands as the dir's bro.config.json. */
function fakeTools(
  env: Record<string, string>,
  opts: { branch?: string; config?: Record<string, unknown> },
  fn: (tools: FakeTools) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-queue-'))
  const bin = join(dir, 'bin')
  const ghLog = join(dir, 'gh.log')
  const gtLog = join(dir, 'gt.log')
  spawnSync('mkdir', ['-p', bin])
  spawnSync('git', ['-C', dir, 'init', '-b', opts.branch ?? 'feature-x'])
  writeFileSync(ghLog, '')
  writeFileSync(gtLog, '')
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  writeFileSync(join(bin, 'gt'), FAKE_GT)
  chmodSync(join(bin, 'gh'), 0o755)
  chmodSync(join(bin, 'gt'), 0o755)
  if (opts.config !== undefined) {
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify(opts.config))
  }
  const prevPath = process.env.PATH
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  process.env.PATH = `${bin}:${prevPath}`
  Object.assign(process.env, { FAKE_GH_LOG: ghLog, FAKE_GT_LOG: gtLog, ...env })
  try {
    fn({
      dir,
      ghLog,
      gtLog,
      ghCalls: () => readFileSync(ghLog, 'utf8'),
      gtCalls: () => readFileSync(gtLog, 'utf8'),
    })
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete process.env.FAKE_GH_LOG
    delete process.env.FAKE_GT_LOG
    delete process.env.FAKE_GH_HEAD
    rmSync(dir, { recursive: true, force: true })
  }
}

const target = { repo: 'acme/widgets', pr: 42 }

/** First commit so `git rev-parse HEAD` resolves — returns its sha. */
function initCommit(dir: string): string {
  spawnSync('git', [
    '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-qm', 'init', '--allow-empty',
  ])
  return String(spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout ?? '').trim()
}

describe('mergifyQueue', { skip: WIN32 }, () => {
  test('zero-config enqueue posts the default queue command', () => {
    fakeTools({}, { branch: 'feature-x' }, (t) => {
      assert.equal(mergifyQueue(t.dir).enqueue(target, { dir: t.dir }), 'enqueued')
      const calls = t.ghCalls()
      assert.match(calls, /pr comment 42 --repo acme\/widgets --body @mergifyio queue/)
      assert.doesNotMatch(calls, /--add-label/)
    })
  })

  test('act.mergeQueue.label carries the signal alone — no comment spam', () => {
    fakeTools(
      {},
      { branch: 'feature-x', config: { act: { mergeQueue: { label: 'mq' } } } },
      (t) => {
        assert.equal(mergifyQueue(t.dir).enqueue(target, { dir: t.dir }), 'enqueued')
        const calls = t.ghCalls()
        assert.match(calls, /pr edit 42 --repo acme\/widgets --add-label mq/)
        assert.doesNotMatch(calls, /pr comment/)
      }
    )
  })

  test('label + command posts both', () => {
    fakeTools(
      {},
      { branch: 'feature-x', config: { act: { mergeQueue: { label: 'mq', comment: '@mergifyio queue --priority=high' } } } },
      (t) => {
        mergifyQueue(t.dir).enqueue(target, { dir: t.dir })
        const calls = t.ghCalls()
        assert.match(calls, /--add-label mq/)
        assert.match(calls, /--body @mergifyio queue --priority=high/)
      }
    )
  })

  test('a command already on the PR is not posted twice', () => {
    fakeTools(
      { FAKE_GH_COMMENTS: '{"comments":[{"body":"@mergifyio queue"}]}' },
      { branch: 'feature-x' },
      (t) => {
        mergifyQueue(t.dir).enqueue(target, { dir: t.dir })
        assert.doesNotMatch(t.ghCalls(), /pr comment/)
      }
    )
  })

  test('an already-merged PR answers merged and gets no queue signal', () => {
    fakeTools({ FAKE_GH_STATE: 'MERGED' }, { branch: 'feature-x' }, (t) => {
      assert.equal(mergifyQueue(t.dir).enqueue(target, { dir: t.dir }), 'merged')
      const calls = t.ghCalls()
      assert.doesNotMatch(calls, /pr comment/)
      assert.doesNotMatch(calls, /pr edit/)
    })
  })

  test('a closed PR refuses — a queue signal on it is noise', () => {
    fakeTools({ FAKE_GH_STATE: 'CLOSED' }, { branch: 'feature-x' }, (t) => {
      assert.throws(
        () => mergifyQueue(t.dir).enqueue(target, { dir: t.dir }),
        /is CLOSED — nothing to enqueue/
      )
      assert.doesNotMatch(t.ghCalls(), /pr comment/)
    })
  })

  test('a head that moved since the gate refuses — the queue would park an ungated commit', () => {
    fakeTools({ FAKE_GH_HEAD: 'sha-new' }, { branch: 'feature-x' }, (t) => {
      assert.throws(
        () =>
          mergifyQueue(t.dir).enqueue(target, { dir: t.dir, expectedHeadSha: 'sha-gated' }),
        /remote head is sha-new, the gate saw sha-gated/
      )
      assert.doesNotMatch(t.ghCalls(), /pr comment|pr edit/)
    })
  })

  test('the gated head passes the pin and enqueues', () => {
    fakeTools({ FAKE_GH_HEAD: 'sha-gated' }, { branch: 'feature-x' }, (t) => {
      assert.equal(
        mergifyQueue(t.dir).enqueue(target, { dir: t.dir, expectedHeadSha: 'sha-gated' }),
        'enqueued'
      )
      assert.match(t.ghCalls(), /--body @mergifyio queue/)
    })
  })
})

describe('graphiteQueue', { skip: WIN32 }, () => {
  test('runs gt merge in the checkout and parks an OPEN PR', () => {
    fakeTools({}, { branch: 'feature-x' }, (t) => {
      assert.equal(
        graphiteQueue(t.dir).enqueue(target, { dir: t.dir, headRef: 'feature-x' }),
        'enqueued'
      )
      assert.match(t.gtCalls(), /^merge$/m)
    })
  })

  test('reports a merge gt landed outright', () => {
    fakeTools({ FAKE_GH_STATE: 'MERGED' }, { branch: 'feature-x' }, (t) => {
      assert.equal(
        graphiteQueue(t.dir).enqueue(target, { dir: t.dir, headRef: 'feature-x' }),
        'merged'
      )
    })
  })

  test('refuses a checkout that is not the PR head — gt would queue the wrong stack', () => {
    fakeTools({}, { branch: 'other-branch' }, (t) => {
      assert.throws(
        () => graphiteQueue(t.dir).enqueue(target, { dir: t.dir, headRef: 'feature-x' }),
        /on 'other-branch', expected the PR head 'feature-x'/
      )
      assert.equal(t.gtCalls().trim(), '')
    })
  })

  test('a failing gt merge is a failed enqueue, never a parked one', () => {
    fakeTools({ FAKE_GT_FAIL: '1' }, { branch: 'feature-x' }, (t) => {
      assert.throws(
        () => graphiteQueue(t.dir).enqueue(target, { dir: t.dir, headRef: 'feature-x' }),
        /gt merge failed: gt: the current branch is not tracked/
      )
    })
  })

  test('a checkout off the gated commit refuses before gt runs', () => {
    fakeTools({}, { branch: 'feature-x' }, (t) => {
      initCommit(t.dir)
      assert.throws(
        () =>
          graphiteQueue(t.dir).enqueue(target, {
            dir: t.dir,
            headRef: 'feature-x',
            expectedHeadSha: 'sha-gated',
          }),
        /checkout .* HEAD is [0-9a-f]{40}, the gate saw sha-gated/
      )
      assert.equal(t.gtCalls().trim(), '')
    })
  })

  test('a moved remote head refuses even when the checkout is on the gated sha', () => {
    fakeTools({ FAKE_GH_HEAD: 'sha-remote-new' }, { branch: 'feature-x' }, (t) => {
      const sha = initCommit(t.dir)
      assert.throws(
        () =>
          graphiteQueue(t.dir).enqueue(target, {
            dir: t.dir,
            headRef: 'feature-x',
            expectedHeadSha: sha,
          }),
        /remote head is sha-remote-new, the gate saw/
      )
      assert.equal(t.gtCalls().trim(), '')
    })
  })

  test('checkout and remote both on the gated sha run gt merge', () => {
    fakeTools({}, { branch: 'feature-x' }, (t) => {
      const sha = initCommit(t.dir)
      process.env.FAKE_GH_HEAD = sha
      assert.equal(
        graphiteQueue(t.dir).enqueue(target, {
          dir: t.dir,
          headRef: 'feature-x',
          expectedHeadSha: sha,
        }),
        'enqueued'
      )
      assert.match(t.gtCalls(), /^merge$/m)
    })
  })
})

describe('mergeQueue connector resolution', { skip: WIN32 }, () => {
  test('unconfigured resolves to null — no queue is a value, not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-queue-cfg-'))
    try {
      assert.equal(mergeQueueHost(dir, {}), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a configured name resolves — opt-in connectors never detect', () => {
    registerConnector(mergifyConnector)
    registerConnector(graphiteConnector)
    const dir = mkdtempSync(join(tmpdir(), 'bro-queue-cfg-'))
    try {
      const q = mergeQueueHost(dir, { mergeQueue: 'mergify' })
      assert.equal(typeof q?.enqueue, 'function')
      const g = mergeQueueHost(dir, { mergeQueue: 'graphite' })
      assert.equal(typeof g?.enqueue, 'function')
      // opt-in only — unnamed resolution must not pick them
      assert.equal(mergeQueueHost(dir, {}), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
