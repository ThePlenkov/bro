import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { facade, registerConnector } from '@broject/core'
import { githubConnector, githubReview } from './index.ts'

const WIN32 = process.platform === 'win32'

const SCAN_NODE = `{"title":"did the thing","url":"https://github.com/acme/widgets/pull/7","mergedAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-03T00:00:00Z","mergeCommit":{"oid":"abc123"},"labels":{"nodes":[{"name":"bug"}]},"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[{"id":"THR_1","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"reviewer-bot","__typename":"Bot"},"path":"a.ts","line":3,"body":"fix this","createdAt":"2026-01-01"}]}}]}}`

/** Scripted gh on PATH — records argv to $FAKE_GH_LOG, answers by $1 $2. */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr checks") if [ "$FAKE_GH_NO_CHECKS" = "1" ]; then echo 'no checks reported' >&2; exit 8; fi
      echo '[{"name":"build","state":"SUCCESS","bucket":"pass"},{"name":"kilo","state":"PENDING","bucket":"pending"}]' ;;
  "repo view") echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  "pr view") echo '{"state":"MERGED"}' ;;
  "pr merge") echo 'Merging pull request' ;;
  "api graphql") case "$@" in
      *"s0: pullRequest"*) echo '{"data":{"repository":{"s0":${SCAN_NODE},"s1":${SCAN_NODE}}}}' ;;
      *"u0: pullRequest"*) echo '{"data":{"repository":{"u0":{"updatedAt":"2026-02-02T00:00:00Z"},"u1":{"updatedAt":"2026-02-02T00:00:00Z"}}}}' ;;
      *) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"THR_1","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"reviewer-bot","__typename":"Bot"},"path":"a.ts","line":3,"body":"fix this","createdAt":"2026-01-01"}]}}]}}}}}' ;;
    esac ;;
  "api repos/"* ) case "$2" in
      *check-runs?*) echo '{"check_runs":[{"id":1,"name":"build"},{"id":2,"name":"kilo"},{"id":3,"name":"build"},{"id":4,"name":"lint"}]}' ;;
      *) echo '{}' ;;
    esac ;;
  "api --paginate") case "$4" in
      *check-runs/1/annotations*) echo '[[{"annotation_level":"failure"},{"annotation_level":"warning"}]]' ;;
      *check-runs/2/annotations*) if [ "$FAKE_GH_ANN_FAIL" = "1" ]; then echo 'rate limit' >&2; exit 1; fi
          echo '[[{"annotation_level":"failure"}]]' ;;
      *check-runs/3/annotations*) echo '[[{"annotation_level":"failure"}]]' ;;
      *check-runs/4/annotations*) echo '{"message":"Not Found"}' ;;
    esac ;;
  "pr edit"|"label create") : ;;
esac
`

function withFakeGh(env: Record<string, string>, fn: (log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-gh-'))
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_GH_LOG: log, ...env })
  try {
    fn(log)
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete process.env.FAKE_GH_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

const target = { repo: 'acme/widgets', pr: 42 }

describe('github connector', () => {
  test('matchRemote claims github hosts only', () => {
    assert.equal(githubConnector.matchRemote?.('git@github.com:acme/widgets.git'), true)
    assert.equal(githubConnector.matchRemote?.('https://github.com/acme/widgets.git'), true)
    assert.equal(githubConnector.matchRemote?.('git@gitlab.com:acme/widgets.git'), false)
    assert.equal(githubConnector.matchRemote?.('git@evilgithub.com:acme/widgets.git'), false)
    assert.equal(githubConnector.matchRemote?.('git@github.corp.internal:acme/w.git'), true)
  })

  test('parsePrRef extracts repo/pr from a GitHub pull URL only', () => {
    const rev = githubReview()
    assert.deepEqual(rev.parsePrRef('see https://github.com/acme/widgets/pull/42 please'), {
      repo: 'acme/widgets',
      pr: 42,
    })
    assert.equal(rev.parsePrRef('fix the thing'), null)
    assert.equal(rev.parsePrRef('github.com/acme/widgets/issues/9'), null)
    assert.equal(rev.parsePrRef('https://gitlab.com/acme/widgets/-/merge_requests/42'), null)
  })
})

describe('githubReview', { skip: WIN32 }, () => {
  test('checks parses the JSON gh pr checks emits', () => {
    withFakeGh({}, (log) => {
      const got = githubReview().checks(target)
      assert.deepEqual(
        got.map((c) => c.name),
        ['build', 'kilo']
      )
      assert.match(readFileSync(log, 'utf8'), /pr checks 42 --repo acme\/widgets --json name,state,bucket/)
    })
  })

  test('checks returns [] when the host reports no checks', () => {
    withFakeGh({ FAKE_GH_NO_CHECKS: '1' }, () => {
      assert.deepEqual(githubReview().checks(target), [])
    })
  })

  test('checkAnnotations accumulates failure counts across re-run attempts', () => {
    withFakeGh({}, () => {
      const got = githubReview().checkAnnotations('acme/widgets', 'abc123')
      // build ran twice (ids 1+3) — 1 failure each; kilo once — 1 failure;
      // lint's endpoint answered a non-array error body, which counts as
      // unknown rather than throwing.
      assert.deepEqual(Object.fromEntries(got), { build: 2, kilo: 1, lint: null })
    })
  })

  test('checkAnnotations marks only the failed run unknown — other counts survive', () => {
    withFakeGh({ FAKE_GH_ANN_FAIL: '1' }, () => {
      const got = githubReview().checkAnnotations('acme/widgets', 'abc123')
      assert.equal(got.get('build'), 2)
      assert.equal(got.get('kilo'), null)
      assert.equal(got.get('lint'), null)
      assert.equal(got.size, 3)
    })
  })

  test('reviewThreads normalizes the graphql shape onto domain types', async () => {
    await withFakeGhAsync(async () => {
      const threads = await githubReview().reviewThreads(target)
      assert.equal(threads.length, 1)
      const [t] = threads
      assert.deepEqual(
        { id: t!.id, resolved: t!.resolved, outdated: t!.outdated },
        { id: 'THR_1', resolved: false, outdated: false }
      )
      assert.deepEqual(
        { author: t!.comment!.author, bot: t!.comment!.bot, path: t!.comment!.path, line: t!.comment!.line },
        { author: 'reviewer-bot', bot: true, path: 'a.ts', line: 3 }
      )
    })
  })

  test('scanMergedPrs folds a chunk of PRs into one aliased query', async () => {
    await withFakeGhAsync(async (log) => {
      const scans = await githubReview().scanMergedPrs!([
        { repo: 'acme/widgets', pr: 7 },
        { repo: 'acme/widgets', pr: 8 },
      ])
      assert.equal(scans.size, 2)
      const s = scans.get(7)!
      assert.equal(s.info.mergeSha, 'abc123')
      assert.equal(s.info.mergedAt, '2026-01-02T00:00:00Z')
      assert.equal(s.updatedAt, '2026-01-03T00:00:00Z')
      assert.deepEqual(s.labels, ['bug'])
      assert.equal(s.threads.length, 1)
      assert.equal(s.threads[0]!.id, 'THR_1')
      assert.equal(s.threads[0]!.comment!.author, 'reviewer-bot')
      // both PRs ride ONE graphql call — the per-PR serial probes are
      // what made a wide collect crawl (the logged query is multi-line,
      // so assertions match the whole log)
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      assert.equal(calls.filter((l) => l.startsWith('api graphql')).length, 1)
      assert.match(readFileSync(log, 'utf8'), /s0: pullRequest\(number: 7\)/)
      assert.match(readFileSync(log, 'utf8'), /s1: pullRequest\(number: 8\)/)
    })
  })

  test('scanMergedPrs reports progress per chunk', async () => {
    await withFakeGhAsync(async () => {
      const marks: Array<[number, number]> = []
      await githubReview().scanMergedPrs!(
        [{ repo: 'acme/widgets', pr: 7 }],
        { onProgress: (d, t) => marks.push([d, t]) }
      )
      assert.deepEqual(marks, [[1, 1]])
    })
  })

  test('labelPrs writes add+remove in one pr edit and re-queries updatedAt', async () => {
    await withFakeGhAsync(async (log) => {
      const out = await githubReview().labelPrs!([
        {
          t: { repo: 'acme/widgets', pr: 7 },
          add: ['debt:collected'],
          remove: ['debt:clean'],
        },
        {
          t: { repo: 'acme/widgets', pr: 8 },
          add: ['debt:clean'],
          remove: [],
        },
      ])
      assert.deepEqual(
        [...out.entries()].sort(),
        [
          [7, '2026-02-02T00:00:00Z'],
          [8, '2026-02-02T00:00:00Z'],
        ]
      )
      const lines = readFileSync(log, 'utf8')
      assert.match(
        lines,
        /pr edit 7 --repo acme\/widgets --add-label debt:collected --remove-label debt:clean/
      )
      assert.match(lines, /pr edit 8 --repo acme\/widgets --add-label debt:clean/)
      assert.doesNotMatch(lines, /--remove-label $|--remove-label\n/m)
      // one batched updatedAt re-query — no per-PR `pr view`
      assert.match(lines, /u0: pullRequest\(number: \d+\) \{ updatedAt \}/)
      assert.equal(lines.split('\n').filter((l) => l.startsWith('pr view')).length, 0)
    })
  })

  test('resolveThread picks the mutation by the unresolve flag', () => {
    withFakeGh({}, (log) => {
      githubReview().resolveThread('THR_1')
      githubReview().resolveThread('THR_2', true)
      const lines = readFileSync(log, 'utf8')
      assert.match(lines, /resolveReviewThread/)
      assert.match(lines, /unresolveReviewThread/)
    })
  })

  test('mergePr pins the head and returns the post-merge state', () => {
    withFakeGh({}, (log) => {
      const state = githubReview().mergePr(target, {
        method: 'squash',
        expectedHeadSha: 'abc123',
        deleteBranch: true,
      })
      assert.equal(state, 'MERGED')
      assert.match(
        readFileSync(log, 'utf8'),
        /pr merge 42 --squash --repo acme\/widgets --match-head-commit abc123 --delete-branch/
      )
    })
  })

  test('facade resolution picks github via connectors.reviews config', () => {
    registerConnector(githubConnector)
    const dir = mkdtempSync(join(tmpdir(), 'bro-gh-facade-'))
    try {
      const f = facade('reviews', { dir }, { prefer: { reviews: 'github' } })
      assert.equal(typeof f.prMeta, 'function')
      assert.equal(f.prLink('acme/widgets', 7), '[#7](https://github.com/acme/widgets/pull/7)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

async function withFakeGhAsync(fn: (log: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-gh-'))
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const prevLog = process.env.FAKE_GH_LOG
  process.env.FAKE_GH_LOG = log
  try {
    await fn(log)
  } finally {
    process.env.PATH = prevPath
    if (prevLog === undefined) delete process.env.FAKE_GH_LOG
    else process.env.FAKE_GH_LOG = prevLog
    rmSync(dir, { recursive: true, force: true })
  }
}
