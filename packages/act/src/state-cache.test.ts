import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { CheckInfo, PrMeta, PrTarget, ReviewFacade, ReviewThread } from '@broject/core'
import { fetchPrActState } from './state.ts'
import { prStateCache } from './state-cache.ts'
import { tmpDir } from './testtmp.ts'
import type { PrActState } from './types.ts'
import { scrubEnv, testGit } from '@broject/core'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

const target: PrTarget = { repo: 'o/r', pr: 7 }

/** A real repo in a tmp dir — prStateCache resolves through git's
 *  --git-common-dir, so the fixture is a `git init`, not a bare dir. */
function repo(): string {
  const dir = tmpDir('bro-actstate-')
  testGit(['init', '-q', dir])
  return dir
}

const stateFor = (pr: number, headSha = 'a'.repeat(40)): PrActState => ({
  pr,
  url: `https://github.com/o/r/pull/${pr}`,
  headSha,
  headRef: 'feat/x',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  openThreads: 0,
  threads: [],
  reopenedThreads: [],
  ciPending: 0,
  ciFailing: 0,
  reviewersPending: 0,
  reviewersFailing: 0,
  sastPending: 0,
  sastUnknown: 0,
  fixRounds: 0,
  maxRounds: 0,
  docsOnly: false,
  alerts: [],
})

describe('prStateCache', () => {
  test('null outside a repository — every read is a miss', () => {
    assert.equal(prStateCache(tmpDir('bro-actstate-')), null)
  })

  test('write → read round trip inside the ttl', () => {
    const cache = prStateCache(repo())!
    cache.write(target, stateFor(7))
    assert.deepEqual(cache.read(target), stateFor(7))
  })

  test('an expired entry reads as a miss and is dropped', () => {
    const dir = repo()
    const cache = prStateCache(dir)!
    const file = join(dir, '.git', 'bro', 'act-state', 'o%2Fr-7.json')
    mkdirSync(join(dir, '.git', 'bro', 'act-state'), { recursive: true })
    writeFileSync(file, JSON.stringify({ fetchedAt: Date.now() - 60_000, state: stateFor(7) }))
    assert.equal(cache.read(target), null)
  })

  test('a corrupt file reads as a miss, never a throw', () => {
    const dir = repo()
    const cache = prStateCache(dir)!
    mkdirSync(join(dir, '.git', 'bro', 'act-state'), { recursive: true })
    writeFileSync(join(dir, '.git', 'bro', 'act-state', 'o%2Fr-7.json'), '{oops')
    assert.equal(cache.read(target), null)
  })

  test('distinct repo names that sanitize to the same slug do not collide', () => {
    const cache = prStateCache(repo())!
    cache.write({ repo: 'a-b/c', pr: 1 }, stateFor(1))
    assert.equal(cache.read({ repo: 'a/b-c', pr: 1 }), null)
    assert.deepEqual(cache.read({ repo: 'a-b/c', pr: 1 }), stateFor(1))
  })

  test('an entry for another pr is a miss', () => {
    const cache = prStateCache(repo())!
    cache.write({ repo: 'o/r', pr: 8 }, stateFor(8))
    assert.equal(cache.read(target), null)
    assert.deepEqual(cache.read({ repo: 'o/r', pr: 8 }), stateFor(8))
  })

  test('invalidate drops the entry', () => {
    const cache = prStateCache(repo())!
    cache.write(target, stateFor(7))
    cache.invalidate(target)
    assert.equal(cache.read(target), null)
  })

  test('invalidateAll drops every entry', () => {
    const cache = prStateCache(repo())!
    cache.write({ repo: 'o/r', pr: 7 }, stateFor(7))
    cache.write({ repo: 'o/r', pr: 8 }, stateFor(8))
    cache.invalidateAll()
    assert.equal(cache.read({ repo: 'o/r', pr: 7 }), null)
    assert.equal(cache.read({ repo: 'o/r', pr: 8 }), null)
  })

  test('acquire is re-entrant per path in-process; release frees it', () => {
    const cache = prStateCache(repo())!
    const release = cache.acquire(target)
    assert.ok(release !== null)
    // filelock re-entrancy: a nested acquire on the held path is a
    // no-op release, never a self-deadlock — cross-process exclusion
    // is the filelock's own test suite's contract
    const nested = cache.acquire(target, 0)
    assert.ok(nested !== null)
    nested()
    release()
    const again = cache.acquire(target, 0)
    assert.ok(again !== null)
    again()
  })
})

// --- fetchPrActState over the feed -------------------------------------------------

const SHA = 'a'.repeat(40)

const meta: PrMeta = {
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/7',
  headSha: SHA,
  headRef: 'feat/x',
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
}

const check = (name: string, bucket: string): CheckInfo => ({
  name,
  state: bucket === 'fail' ? 'FAILURE' : bucket === 'pending' ? 'PENDING' : 'SUCCESS',
  bucket,
})

const thread = (author: string): ReviewThread => ({
  id: `t-${author}`,
  resolved: false,
  outdated: false,
  comment: { author, bot: true, path: 'x.ts', line: 1, body: 'n', createdAt: new Date().toISOString() },
})

function countingRev(checks: CheckInfo[] = [], threads: ReviewThread[] = []): {
  rev: ReviewFacade
  calls: () => number
} {
  let n = 0
  const rev = {
    prMeta: () => {
      n += 1
      return meta
    },
    reviewThreads: async () => threads,
    checks: () => checks,
    checkAnnotations: () => new Map(),
    reviewedShas: () => [SHA],
  } as unknown as ReviewFacade
  return { rev, calls: () => n }
}

describe('fetchPrActState — shared feed', () => {
  test('a second fetch inside the ttl pays zero facade calls', async () => {
    const cache = prStateCache(repo())!
    const { rev, calls } = countingRev([check('build', 'pass')])
    await fetchPrActState(rev, target, { stateCache: cache })
    assert.equal(calls(), 1)
    const s = await fetchPrActState(rev, target, { stateCache: cache })
    assert.equal(calls(), 1)
    assert.equal(s.headSha, SHA)
  })

  test('concurrent same-target fetches share the in-flight one', async () => {
    const cache = prStateCache(repo())!
    const { rev, calls } = countingRev()
    const [a, b] = await Promise.all([
      fetchPrActState(rev, target, { stateCache: cache }),
      fetchPrActState(rev, target, { stateCache: cache }),
    ])
    assert.equal(calls(), 1)
    assert.equal(a.headSha, b.headSha)
  })

  test('invalidate forces the next fetch through the facade', async () => {
    const cache = prStateCache(repo())!
    const { rev, calls } = countingRev()
    await fetchPrActState(rev, target, { stateCache: cache })
    cache.invalidate(target)
    await fetchPrActState(rev, target, { stateCache: cache })
    assert.equal(calls(), 2)
  })

  test('a cached state serves thread data to the next reader', async () => {
    const cache = prStateCache(repo())!
    const { rev, calls } = countingRev([], [thread('greptile-apps[bot]')])
    await fetchPrActState(rev, target, { stateCache: cache })
    const s = await fetchPrActState(rev, target, { stateCache: cache })
    assert.equal(calls(), 1)
    assert.equal(s.openThreads, 1)
    assert.equal(s.threads[0]!.comment!.author, 'greptile-apps[bot]')
  })

  test('a fetch while the same process holds the lock cannot deadlock', async () => {
    const cache = prStateCache(repo())!
    const { rev, calls } = countingRev()
    // the filelock's per-path re-entrancy makes the nested acquire a
    // no-op — a caller already inside the section still fetches +
    // publishes rather than waiting on itself
    const release = cache.acquire(target)!
    try {
      const s = await fetchPrActState(rev, target, { stateCache: cache })
      assert.equal(calls(), 1)
      assert.equal(s.headSha, SHA)
    } finally {
      release()
    }
    assert.deepEqual(cache.read(target)?.headSha, SHA)
  })

  test('a lock held past the wait bound degrades to an uncached fetch', async () => {
    const dir = repo()
    const cache = prStateCache(dir, { lockWaitMs: 40 })!
    const { rev, calls } = countingRev()
    // a foreign LIVE holder: this pid is alive but the token is not a
    // lock this process owns — unstealable until the wait bound, so
    // the contender gives up at lockWaitMs and fetches itself
    const lockDir = join(dir, '.git', 'bro', 'act-state')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'o%2Fr-7.json.lock'), `${process.pid}:foreign`)
    const s = await fetchPrActState(rev, target, { stateCache: cache })
    assert.equal(calls(), 1)
    assert.equal(s.headSha, SHA)
  })

  test('a cache-less fetch is untouched — always the caller’s own', async () => {
    const { rev, calls } = countingRev()
    await fetchPrActState(rev, target)
    await fetchPrActState(rev, target)
    assert.equal(calls(), 2)
  })
})
