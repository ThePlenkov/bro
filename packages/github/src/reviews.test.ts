import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { facade, registerConnector } from '@broject/core'
import { githubConnector, githubReview } from './index.ts'
import { mergeAsync } from './reviews.ts'

const WIN32 = process.platform === 'win32'

const SCAN_NODE = `{"title":"did the thing","url":"https://github.com/acme/widgets/pull/7","mergedAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-03T00:00:00Z","mergeCommit":{"oid":"abc123"},"labels":{"nodes":[{"name":"bug"}]},"reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[{"id":"THR_1","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"reviewer-bot","__typename":"Bot"},"path":"a.ts","line":3,"body":"fix this","createdAt":"2026-01-01"}]}}]}}`

/** Scripted gh on PATH — records argv to $FAKE_GH_LOG, answers by $1 $2.
 *  The merge-async family is env-driven: FAKE_GH_PULL (the PR read that
 *  carries `.stack`), FAKE_GH_QUEUE (a non-null GraphQL mergeQueue),
 *  FAKE_GH_ASYNC / FAKE_GH_ASYNC_ERR (the PUT's body / a failing one on
 *  stderr, as gh reports a 4xx), FAKE_GH_ASYNC_POLL / FAKE_GH_POLL_ERR
 *  (the result GET), FAKE_GH_PR_MERGE_ERR, FAKE_GH_PR_STATE. */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
if [ -z "$FAKE_GH_PULL" ]; then FAKE_GH_PULL='{}'; fi
if [ -z "$FAKE_GH_ASYNC" ]; then FAKE_GH_ASYNC='{"status":"merged","details":{"sha":"abc123"}}'; fi
if [ -z "$FAKE_GH_ASYNC_POLL" ]; then FAKE_GH_ASYNC_POLL='{"status":"merged","details":{"sha":"abc123"}}'; fi
case "$1 $2" in
  "pr checks") if [ "$FAKE_GH_NO_CHECKS" = "1" ]; then echo 'no checks reported' >&2; exit 8; fi
      echo '[{"name":"build","state":"SUCCESS","bucket":"pass"},{"name":"kilo","state":"PENDING","bucket":"pending"}]' ;;
  "repo view") echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  "pr view") if [ -n "$FAKE_GH_PR_STATE" ]; then echo '{"state":"'"$FAKE_GH_PR_STATE"'"}'; exit 0; fi
      if [ -n "$FAKE_GH_PR_VIEW_FAIL" ]; then case ",$FAKE_GH_PR_VIEW_FAIL," in
      *",$3,"*) echo 'gh: authentication required' >&2; exit 1 ;; esac; fi
      if [ "$FAKE_GH_NO_MERGED_AT" = "1" ]; then echo '{"state":"MERGED"}';
      else echo '{"state":"MERGED","title":"did the thing","url":"https://github.com/acme/widgets/pull/7","mergedAt":"2026-01-02T00:00:00Z","mergeCommit":{"oid":"abc123"}}'; fi ;;
  "pr list") echo '[{"number":9,"mergedAt":"2026-01-02T00:00:00Z","updatedAt":null,"author":{"login":"dev"},"labels":[],"headRefName":"x","headRefOid":"s1"}]' ;;
  "pr merge") if [ -n "$FAKE_GH_PR_MERGE_ERR" ]; then echo "$FAKE_GH_PR_MERGE_ERR" >&2; exit 1; fi
      echo 'Merging pull request' ;;
  "api graphql") case "$@" in
      *"mergeQueue(branch:"*) if [ "$FAKE_GH_QUEUE" = "1" ]; then echo '{"data":{"repository":{"mergeQueue":{"id":7}}}}';
          else echo '{"data":{"repository":{"mergeQueue":null}}}'; fi ;;
      *"s0: pullRequest"*) echo '{"data":{"repository":{"s0":${SCAN_NODE},"s1":${SCAN_NODE}}}}' ;;
      *"u0: pullRequest"*) echo '{"data":{"repository":{"u0":{"updatedAt":"2026-02-02T00:00:00Z"},"u1":{"updatedAt":"2026-02-02T00:00:00Z"}}}}' ;;
      *) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"THR_1","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"author":{"login":"reviewer-bot","__typename":"Bot"},"path":"a.ts","line":3,"body":"fix this","createdAt":"2026-01-01"}]}}]}}}}}' ;;
    esac ;;
  "api -X") if [ "$3" = "PUT" ]; then case "$4" in
      *merge-async) if [ -n "$FAKE_GH_ASYNC_ERR" ]; then echo "$FAKE_GH_ASYNC_ERR" >&2; exit 1; fi
          echo "$FAKE_GH_ASYNC" ;;
      *) echo '{}' ;;
    esac; fi ;;
  "api repos/"* ) case "$2" in
      *check-runs\\?*) echo '{"check_runs":[{"id":1,"name":"build"},{"id":2,"name":"kilo"},{"id":3,"name":"build"},{"id":4,"name":"lint"}]}' ;;
      *merge-async/*) if [ -n "$FAKE_GH_POLL_ERR" ]; then echo "$FAKE_GH_POLL_ERR" >&2; exit 1; fi
          echo "$FAKE_GH_ASYNC_POLL" ;;
      */pulls/*) if [ -z "$3" ]; then
          # a bare repos/{o}/{r}/pulls/{n} read is the stack probe; a
          # pulls/{n}/subresource keeps the empty default
          if [ -n "$FAKE_GH_PULL_ERR" ]; then echo 'gh: API rate limit exceeded' >&2; exit 1; fi
          echo "$FAKE_GH_PULL"
        else
          echo '{}'
        fi ;;
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
    assert.equal(githubConnector.matchRemote?.('git@api.github.com:acme/w.git'), true)
    // right-edge lookalikes — a `github` label off the github.com edge is
    // indistinguishable from phishing, so GHES goes through config instead
    assert.equal(githubConnector.matchRemote?.('git@github.com.evil.com:acme/w.git'), false)
    assert.equal(githubConnector.matchRemote?.('git@foo.github.attacker.tld:a/w.git'), false)
    assert.equal(githubConnector.matchRemote?.('git@github.corp.internal:acme/w.git'), false)
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

  test('mergedPrInfo returns the mergedAt the API reports', () => {
    withFakeGh({}, () => {
      const info = githubReview().mergedPrInfo(target)
      assert.equal(info.mergedAt, '2026-01-02T00:00:00Z')
      assert.equal(info.mergeSha, 'abc123')
    })
  })

  test('mergedPrInfo throws when a MERGED PR reports no mergedAt', () => {
    withFakeGh({ FAKE_GH_NO_MERGED_AT: '1' }, () => {
      assert.throws(() => githubReview().mergedPrInfo(target), /no mergedAt/)
    })
  })

  test('mergedPrs explicit ids throws when every fetch fails — an outage, not N unmerged PRs', () => {
    withFakeGh({ FAKE_GH_PR_VIEW_FAIL: '7,8' }, () => {
      assert.throws(
        () => githubReview().mergedPrs('acme/widgets', { ids: [7, 8] }),
        /authentication required/
      )
    })
  })

  test('mergedPrs explicit ids deduplicates — one fetch, one row per id', () => {
    withFakeGh({}, (log) => {
      const prs = githubReview().mergedPrs('acme/widgets', { ids: [7, 7, 8, 7] })
      assert.equal(prs.length, 2)
      const lines = readFileSync(log, 'utf8')
      assert.equal(lines.split('\n').filter((l) => l.startsWith('pr view 7 ')).length, 1)
      assert.equal(lines.split('\n').filter((l) => l.startsWith('pr view 8 ')).length, 1)
    })
  })

  test('mergedPrs mergedSince goes into the search query — the cap cannot crowd the window out', () => {
    withFakeGh({}, (log) => {
      const prs = githubReview().mergedPrs('acme/widgets', {
        limit: 10,
        mergedSince: '2026-01-01T00:00:00Z',
      })
      assert.equal(prs.length, 1)
      assert.match(readFileSync(log, 'utf8'), /pr list .*--search merged:>=2026-01-01\n/)
    })
  })

  test('mergedPrs explicit ids keeps partial results and warns with the gh error', () => {
    withFakeGh({ FAKE_GH_PR_VIEW_FAIL: '8' }, () => {
      const errs: string[] = []
      const origError = console.error
      console.error = (msg: unknown) => errs.push(String(msg))
      try {
        const prs = githubReview().mergedPrs('acme/widgets', { ids: [7, 8] })
        assert.equal(prs.length, 1)
        assert.equal(prs[0]!.mergedAt, '2026-01-02T00:00:00Z')
      } finally {
        console.error = origError
      }
      assert.match(errs.join('\n'), /fetch failed — .*authentication required/)
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

  // --- stacks: the async merge endpoint is the only way in ----------------------
  //
  // GitHub rejects GraphQL mergePullRequest (what `gh pr merge` is) and the
  // sync REST merge for a stack member. Both detection signals are covered:
  // the `.stack` field on the PR read, and the rejection itself.

  const STACK_PULL = '{"base":{"ref":"stack/s/1-a"},"stack":{"base":{"ref":"main"},"id":9,"number":3,"position":2,"size":4}}'

  test('mergePr sends a stack member to merge-async, never `gh pr merge`', () => {
    withFakeGh({ FAKE_GH_PULL: STACK_PULL }, (log) => {
      const state = githubReview().mergePr(target, {
        method: 'squash',
        expectedHeadSha: 'abc123',
        // a lower layer's deletion closes every PR stacked on it — the
        // async path must not carry the flag
        deleteBranch: true,
      })
      assert.equal(state, 'MERGED')
      const calls = readFileSync(log, 'utf8')
      assert.doesNotMatch(calls, /pr merge 42/)
      assert.doesNotMatch(calls, /delete-branch/)
      assert.match(
        calls,
        /api -X PUT repos\/acme\/widgets\/pulls\/42\/merge-async -f sha=abc123 -f merge_action=direct_merge -f merge_method=squash/
      )
    })
  })

  test('mergePr reports an enqueued stack merge as the state the PR is really in', () => {
    withFakeGh(
      {
        FAKE_GH_PULL: STACK_PULL,
        FAKE_GH_ASYNC: '{"status":"enqueued","details":{"message":"added to queue"}}',
        FAKE_GH_PR_STATE: 'OPEN',
      },
      () => {
        // enqueued is final for the REQUEST, not for the PR — the
        // authoritative re-read is what the caller sees, so a queue hold
        // reads as "still open" instead of a landed merge
        assert.equal(
          githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' }),
          'OPEN'
        )
      }
    )
  })

  test('mergeAsync waits out a pending request by polling its uuid', () => {
    withFakeGh(
      {
        FAKE_GH_ASYNC: '{"status":"pending","details":{"uuid":"u-1","merge_action":"direct_merge"}}',
        FAKE_GH_ASYNC_POLL: '{"status":"merged","details":{"sha":"abc123"}}',
      },
      (log) => {
        const naps: number[] = []
        mergeAsync(target, { method: 'squash', expectedHeadSha: 'abc123' }, { base: 'main' }, {
          sleep: (ms) => naps.push(ms),
        })
        assert.deepEqual(naps, [2_000])
        assert.match(readFileSync(log, 'utf8'), /api repos\/acme\/widgets\/pulls\/42\/merge-async\/u-1/)
      }
    )
  })

  test('mergeAsync never naps past the watch deadline', () => {
    // a 1s budget with the default 2s gap: an unclamped sleep carries the
    // loop a whole interval past the deadline before it can notice
    withFakeGh(
      {
        FAKE_GH_ASYNC: '{"status":"pending","details":{"uuid":"u-4"}}',
        FAKE_GH_ASYNC_POLL: '{"status":"merged","details":{"sha":"abc123"}}',
      },
      () => {
        const naps: number[] = []
        mergeAsync(target, { method: 'squash', expectedHeadSha: 'abc123' }, { base: 'main' }, {
          sleep: (ms) => naps.push(ms),
          deadlineMs: 1_000,
        })
        // the nap is clamped to the remaining deadline — elapsed since
        // `started` can be a millisecond, so ≤1_000, never exactly it
        assert.deepEqual(naps.length, 1)
        assert.ok(naps[0] > 0 && naps[0] <= 1_000)
      }
    )
  })

  test('mergePr asks for the merge queue when the base branch requires one', () => {
    withFakeGh({ FAKE_GH_PULL: STACK_PULL, FAKE_GH_QUEUE: '1' }, (log) => {
      githubReview().mergePr(target, {
        method: 'rebase',
        expectedHeadSha: 'abc123',
        admin: true,
      })
      const call = readFileSync(log, 'utf8')
        .split('\n')
        .find((l) => l.includes('merge-async'))
      assert.match(call ?? '', /-f merge_action=merge_queue/)
      // the queue owns the strategy — a custom merge_method is rejected
      assert.doesNotMatch(call ?? '', /merge_method/)
      assert.match(call ?? '', /-F bypass_rules=true/)
    })
  })

  test('the queue is asked about the PR base, not the stack target', () => {
    // STACK_PULL is position 2 of 4: it merges INTO stack/s/1-a while the
    // stack targets main. The queue that governs this merge is the one on
    // the branch it lands on, so the query names stack/s/1-a. Asking about
    // main instead would push the PR at a queue that does not govern its
    // own base -- and miss one that does, if stack/s/1-a ever requires it.
    withFakeGh({ FAKE_GH_PULL: STACK_PULL }, (log) => {
      githubReview().mergePr(target, {
        method: 'squash',
        expectedHeadSha: 'abc123',
      })
      const query = readFileSync(log, 'utf8')
        .split('\n')
        .find((l) => l.includes('mergeQueue(branch:'))
      assert.match(query ?? '', /b=stack\/s\/1-a/)
      assert.doesNotMatch(query ?? '', /b=main/)
    })
  })

  test('a merge rejected as stack-only falls back to merge-async (no `.stack` field seen)', () => {
    withFakeGh(
      {
        FAKE_GH_PR_MERGE_ERR:
          'GraphQL: This pull request must be merged using the asynchronous merge REST API.',
        FAKE_GH_ASYNC: '{"status":"merged","details":{"sha":"abc123"}}',
      },
      (log) => {
        assert.equal(
          githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' }),
          'MERGED'
        )
        assert.match(readFileSync(log, 'utf8'), /api -X PUT repos\/acme\/widgets\/pulls\/42\/merge-async/)
      }
    )
  })

  test('an ordinary merge failure propagates — no async retry behind a red gate', () => {
    withFakeGh({ FAKE_GH_PR_MERGE_ERR: 'Base branch is missing required checks' }, (log) => {
      assert.throws(
        () => githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' }),
        /missing required checks/
      )
      assert.doesNotMatch(readFileSync(log, 'utf8'), /merge-async/)
    })
  })

  test('mergeAsync resolves a 409 by polling the uuid the rejection carries', () => {
    withFakeGh(
      {
        FAKE_GH_ASYNC_ERR: '{"status":"pending","details":{"uuid":"u-9","merge_action":"direct_merge"}}',
        FAKE_GH_ASYNC_POLL: '{"status":"merged","details":{"sha":"abc123"}}',
      },
      (log) => {
        mergeAsync(target, { method: 'squash', expectedHeadSha: 'abc123' }, { base: 'main' }, {
          sleep: () => {},
        })
        assert.match(readFileSync(log, 'utf8'), /merge-async\/u-9/)
      }
    )
  })

  test('mergeAsync throws the API reason on a failed request', () => {
    withFakeGh(
      {
        FAKE_GH_ASYNC: '{"status":"failed","details":{"message":"Base branch is protected"}}',
      },
      () => {
        assert.throws(
          () =>
            mergeAsync(target, { method: 'squash', expectedHeadSha: 'abc123' }, { base: 'main' }, {
              sleep: () => {},
            }),
          /failed — Base branch is protected/
        )
      }
    )
  })

  test('mergeAsync never reports an unsettled merge as landed', () => {
    const opts = { method: 'squash' as const, expectedHeadSha: 'abc123' }
    // pending with no uuid — nothing to poll
    withFakeGh({ FAKE_GH_ASYNC: '{"status":"pending","details":{}}' }, () => {
      assert.throws(
        () => mergeAsync(target, opts, { base: 'main' }, { sleep: () => {} }),
        /pending with no uuid/
      )
    })
    // a result GET that 404s (the record is gone) is unobservable, not merged
    withFakeGh(
      { FAKE_GH_ASYNC_ERR: '', FAKE_GH_ASYNC: '{"status":"pending","details":{"uuid":"u-2"}}', FAKE_GH_POLL_ERR: 'gh: Not Found (HTTP 404)' },
      () => {
        assert.throws(
          () => mergeAsync(target, opts, { base: 'main' }, { sleep: () => {} }),
          /no observable status/
        )
      }
    )
    // the watch gives up rather than blocking forever; the merge itself
    // keeps running on GitHub's side
    withFakeGh({ FAKE_GH_ASYNC: '{"status":"pending","details":{"uuid":"u-3"}}' }, () => {
      assert.throws(
        () =>
          mergeAsync(target, opts, { base: 'main' }, {
            sleep: () => {},
            deadlineMs: 0,
          }),
        /still pending/
      )
    })
  })

  test('an unreadable PR read falls back to the sync merge, not a blind async one', () => {
    withFakeGh({ FAKE_GH_PULL_ERR: '1' }, (log) => {
      assert.equal(
        githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' }),
        'MERGED'
      )
      const calls = readFileSync(log, 'utf8')
      assert.match(calls, /pr merge 42 --squash/)
      assert.doesNotMatch(calls, /merge-async/)
    })
  })

  // --- queues on unstacked PRs (spec bro-huy5o.6) ---------------------------

  test('mergePr enqueues a NON-stack PR whose base requires the queue', () => {
    withFakeGh({ FAKE_GH_PULL: '{"base":{"ref":"main"}}', FAKE_GH_QUEUE: '1' }, (log) => {
      githubReview().mergePr(target, {
        method: 'rebase',
        expectedHeadSha: 'abc123',
      })
      const calls = readFileSync(log, 'utf8')
      assert.doesNotMatch(calls, /pr merge 42/)
      assert.doesNotMatch(calls, /delete-branch/)
      const call = calls.split('\n').find((l) => l.includes('merge-async -f'))
      assert.match(call ?? '', /-f sha=abc123 -f merge_action=merge_queue/)
      // the queue owns the strategy — merge_method is rejected with it
      assert.doesNotMatch(call ?? '', /merge_method/)
    })
  })

  test('a non-stack PR on a queue-less base still merges directly — and pays one probe', () => {
    withFakeGh({ FAKE_GH_PULL: '{"base":{"ref":"main"}}' }, (log) => {
      githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' })
      const calls = readFileSync(log, 'utf8')
      // detection costs exactly one GraphQL probe, then the sync path
      // keeps the caller's requested strategy
      assert.equal(calls.split('\n').filter((l) => l.includes('mergeQueue(branch:')).length, 1)
      assert.match(calls, /pr merge 42 --squash/)
      assert.doesNotMatch(calls, /merge-async/)
    })
  })

  test('the queue verdict the caller computed reaches mergeAsync — no second probe', () => {
    withFakeGh({ FAKE_GH_PULL: '{"base":{"ref":"main"}}', FAKE_GH_QUEUE: '1' }, (log) => {
      githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' })
      assert.equal(
        readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('mergeQueue(branch:')).length,
        1
      )
    })
  })

  test('a sync refusal naming the merge queue enqueues without re-probing', () => {
    withFakeGh(
      {
        FAKE_GH_PULL: '{"base":{"ref":"main"}}',
        FAKE_GH_PR_MERGE_ERR:
          'GraphQL: the base branch requires a merge queue. Add the pull request to the merge queue.',
        FAKE_GH_ASYNC: '{"status":"enqueued","details":{"message":"added to queue"}}',
        FAKE_GH_PR_STATE: 'OPEN',
      },
      (log) => {
        assert.equal(
          githubReview().mergePr(target, { method: 'squash', expectedHeadSha: 'abc123' }),
          'OPEN'
        )
        const calls = readFileSync(log, 'utf8')
        const call = calls.split('\n').find((l) => l.includes('merge-async -f'))
        assert.match(call ?? '', /-f merge_action=merge_queue/)
        assert.doesNotMatch(call ?? '', /merge_method/)
        // GitHub just gave the queue verdict — the proactive probe ran
        // once up front, and the refusal doesn't pay a second one
        assert.equal(calls.split('\n').filter((l) => l.includes('mergeQueue(branch:')).length, 1)
      }
    )
  })

  test('mergeAsync honors a precomputed queue verdict with no base to probe', () => {
    withFakeGh({ FAKE_GH_ASYNC: '{"status":"enqueued","details":{}}' }, (log) => {
      mergeAsync(target, { method: 'squash', expectedHeadSha: 'abc123' }, { queued: true })
      const calls = readFileSync(log, 'utf8')
      assert.match(calls, /merge_action=merge_queue/)
      assert.doesNotMatch(calls, /mergeQueue\(branch:/)
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
