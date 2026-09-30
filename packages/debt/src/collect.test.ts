import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewThread } from '@broject/core'
import { collectThreads } from './collect.ts'

const META = {
  title: 'a change',
  url: 'https://github.com/acme/widgets/pull/42',
  mergedAt: '2026-01-02T00:00:00Z',
  mergeSha: 'abc123',
}

function thread(opts: Partial<ReviewThread> & { id: string }): ReviewThread {
  return {
    resolved: false,
    outdated: false,
    comment: {
      author: 'reviewer-bot',
      bot: true,
      path: 'a.ts',
      line: 3,
      body: 'fix this',
      createdAt: '2026-01-01T00:00:00Z',
    },
    ...opts,
  }
}

/** collectThreads reads the author policy from cwd — a bare tmpdir hits
 *  the empty fallback. */
function bareDir(): string {
  return mkdtempSync(join(tmpdir(), 'bro-collect-'))
}

describe('collectThreads', () => {
  test('meta + threads classify into records without a facade', () => {
    const cwd = bareDir()
    try {
      const res = collectThreads({
        meta: META,
        threads: [thread({ id: 'THR_1' })],
        pr: 42,
        runId: 'test',
        cwd,
      })
      assert.equal(res.pr, 42)
      assert.equal(res.incoming.length, 1)
      assert.equal(res.incoming[0]!.source_pr, 42)
      assert.equal(res.incoming[0]!.thread_id, 'THR_1')
      assert.equal(res.incoming[0]!.source_pr_url, META.url)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('resolved threads drop silently; outdated count as skipped', () => {
    const res = collectThreads({
      meta: META,
      threads: [
        thread({ id: 'THR_1', resolved: true }),
        thread({ id: 'THR_2', outdated: true }),
        thread({ id: 'THR_3' }),
      ],
      pr: 42,
      runId: 'test',
      cwd: bareDir(),
    })
    assert.equal(res.incoming.length, 1)
    assert.equal(res.skippedOutdated, 1)
  })

  test('threadAuthor filter keeps only matching comments', () => {
    const res = collectThreads({
      meta: META,
      threads: [
        thread({ id: 'THR_1', comment: { author: 'alice', bot: false, path: 'a.ts', line: 1, body: 'x', createdAt: '' } }),
        thread({ id: 'THR_2' }),
      ],
      pr: 42,
      runId: 'test',
      threadAuthor: 'alice',
      cwd: bareDir(),
    })
    assert.equal(res.incoming.length, 1)
    assert.equal(res.incoming[0]!.author, 'alice')
    assert.equal(res.skippedThreadAuthor, 1)
  })
})
