/** stacks facade contract tests — `mergeChainPerLayer` over a scripted
 *  ReviewFacade, and the built-in git connector's local merge cascade
 *  over a real repo. No gh/glab: the facade contract is the seam. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStacks, mergeChainPerLayer } from './stacks.ts'
import type { StackChainMember } from './stacks.ts'
import type { PrMeta, PrTarget, ReviewFacade } from './review.ts'

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

const META = (over: Partial<PrMeta> = {}): PrMeta => ({
  state: 'OPEN',
  isDraft: false,
  url: 'https://example.test/o/r/pull/1',
  headSha: 'h1',
  headRef: 'stack/s/1-a',
  baseRef: 'main',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  ...over,
})

/** A ReviewFacade scripted per PR number; every call lands in `log`. */
function fakeReviews(
  metas: Record<number, Partial<PrMeta>>,
  opts: { retargetOk?: boolean } = {}
): { facade: ReviewFacade; log: string[] } {
  const log: string[] = []
  const facade = {
    prLink: (_repo: string, pr: number) => `[#${pr}]`,
    prMeta: (t: PrTarget) => META(metas[t.pr]),
    mergePr: (t: PrTarget) => {
      log.push(`merge ${t.pr}`)
      return 'MERGED'
    },
    retargetPr: (t: PrTarget, base: string) => {
      log.push(`retarget ${t.pr} → ${base}`)
      return opts.retargetOk ?? true
    },
  } as unknown as ReviewFacade
  return { facade, log }
}

const OPTS = { method: 'squash' as const }

const member = (branch: string, over: Partial<StackChainMember> = {}): StackChainMember => ({
  branch,
  base: 'main',
  ...over,
})

describe('mergeChainPerLayer', () => {
  test('merges bottom→top, retargeting a member still on the old base', () => {
    const { facade, log } = fakeReviews({
      11: { baseRef: 'main' },
      12: { baseRef: 'stack/s/1-a' },
    })
    const r = mergeChainPerLayer(facade, 'o/r', [
      member('stack/s/1-a', { pr: 11 }),
      member('stack/s/2-b', { pr: 12 }),
    ], OPTS)
    assert.deepEqual(log, ['merge 11', 'retarget 12 → main', 'merge 12'])
    assert.deepEqual(r.merged, ['stack/s/1-a', 'stack/s/2-b'])
  })

  test('stops at a member whose review is not OPEN', () => {
    const { facade, log } = fakeReviews({
      11: { baseRef: 'main' },
      12: { state: 'CLOSED' },
    })
    const r = mergeChainPerLayer(facade, 'o/r', [
      member('stack/s/1-a', { pr: 11 }),
      member('stack/s/2-b', { pr: 12 }),
    ], OPTS)
    assert.deepEqual(log, ['merge 11'])
    assert.deepEqual(r.merged, ['stack/s/1-a'])
    assert.ok(r.lines.some((l) => l.includes('CLOSED')))
  })

  test('an already-MERGED member counts and the climb continues', () => {
    const { facade, log } = fakeReviews({
      11: { state: 'MERGED' },
      12: { baseRef: 'main' },
    })
    const r = mergeChainPerLayer(facade, 'o/r', [
      member('stack/s/1-a', { pr: 11 }),
      member('stack/s/2-b', { pr: 12 }),
    ], OPTS)
    assert.deepEqual(log, ['merge 12'])
    assert.deepEqual(r.merged, ['stack/s/1-a', 'stack/s/2-b'])
    assert.ok(r.lines.some((l) => l.includes('already merged')))
  })

  test('a member without a review stops the chain', () => {
    const { facade, log } = fakeReviews({ 11: { baseRef: 'main' } })
    const r = mergeChainPerLayer(facade, 'o/r', [
      member('stack/s/1-a', { pr: 11 }),
      member('stack/s/2-b'),
      member('stack/s/3-c', { pr: 13 }),
    ], OPTS)
    assert.deepEqual(log, ['merge 11'])
    assert.deepEqual(r.merged, ['stack/s/1-a'])
    assert.ok(r.lines.some((l) => l.includes('has no open review')))
  })

  test('a refused retarget stops the merge before the call', () => {
    const { facade, log } = fakeReviews({ 11: { baseRef: 'stack/s/0-x' } }, { retargetOk: false })
    const r = mergeChainPerLayer(facade, 'o/r', [member('stack/s/1-a', { pr: 11 })], OPTS)
    assert.deepEqual(log, ['retarget 11 → main'])
    assert.deepEqual(r.merged, [])
    assert.ok(r.lines.some((l) => l.includes('refused the retarget')))
  })

  test('a non-MERGED post-merge state reports a queue hold, not a failure', () => {
    const { facade, log } = fakeReviews({ 11: { baseRef: 'main' } })
    const f = facade as unknown as { mergePr: (t: PrTarget) => string }
    const orig = f.mergePr
    f.mergePr = (t) => {
      orig(t)
      return 'OPEN'
    }
    const r = mergeChainPerLayer(facade, 'o/r', [member('stack/s/1-a', { pr: 11 })], OPTS)
    assert.deepEqual(log, ['merge 11'])
    assert.deepEqual(r.merged, [])
    assert.ok(r.lines.some((l) => l.includes('merge queue')))
  })
})

// --- gitStacks — the plain-git merge cascade over a real repo -------------------

/** A repo with a two-member stack chain: main ← stack/s/1-a ← stack/s/2-b. */
function chainRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-stacks-'))
  git(['init', '-q', '-b', 'main', dir], tmpdir())
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 't'], dir)
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(['add', 'base.txt'], dir)
  git(['commit', '-qm', 'init'], dir)
  const commitOn = (branch: string, file: string): void => {
    git(['checkout', '-q', '-b', branch], dir)
    writeFileSync(join(dir, file), `${file}\n`)
    git(['add', file], dir)
    git(['commit', '-qm', `add ${file}`], dir)
  }
  commitOn('stack/s/1-a', 'a.txt')
  commitOn('stack/s/2-b', 'b.txt')
  git(['checkout', '-q', 'main'], dir)
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CHAIN: StackChainMember[] = [
  member('stack/s/1-a'),
  member('stack/s/2-b'),
]

describe('gitStacks', () => {
  test('mergeChain declines a chain whose members carry reviews', () => {
    const { dir, cleanup } = chainRepo()
    try {
      const r = gitStacks(dir).mergeChain?.(
        [member('stack/s/1-a', { pr: 11 })],
        { method: 'squash' }
      )
      assert.equal(r, undefined)
      // nothing was merged — main still has only the base commit
      assert.equal(git(['rev-list', '--count', 'main'], dir).trim(), '1')
    } finally {
      cleanup()
    }
  })

  test('mergeChain lands the whole chain in the primary worktree', () => {
    const { dir, cleanup } = chainRepo()
    try {
      const r = gitStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
      assert.deepEqual(r?.merged, ['stack/s/1-a', 'stack/s/2-b'])
      assert.equal(git(['show', 'main:a.txt'], dir).trim(), 'a.txt')
      assert.equal(git(['show', 'main:b.txt'], dir).trim(), 'b.txt')
      // squash → each member is one commit on top of the base
      assert.equal(git(['rev-list', '--count', 'main'], dir).trim(), '3')
    } finally {
      cleanup()
    }
  })

  test('mergeChain refuses over a dirty primary worktree', () => {
    const { dir, cleanup } = chainRepo()
    try {
      writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n')
      const r = gitStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
      assert.deepEqual(r?.merged, [])
      assert.ok(r?.lines.some((l) => l.includes('uncommitted')))
      assert.equal(git(['rev-list', '--count', 'main'], dir).trim(), '1')
    } finally {
      cleanup()
    }
  })

  test('mergeChain refuses when the primary worktree is not on the trunk', () => {
    const { dir, cleanup } = chainRepo()
    try {
      git(['checkout', '-q', '-b', 'side'], dir)
      const r = gitStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
      assert.deepEqual(r?.merged, [])
      assert.ok(r?.lines.some((l) => l.includes('not main')))
    } finally {
      cleanup()
    }
  })
})
