import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { facade, registerConnector } from '@broject/core'
import { githubConnector } from '@broject/github'
import { gitlabConnector, gitlabReview } from './index.ts'

const WIN32 = process.platform === 'win32'

const MR_DEFAULT =
  '{"iid":%IID%,"state":"merged","title":"did the thing","web_url":"https://gitlab.com/acme/widgets/-/merge_requests/%IID%","merged_at":"2026-01-02T00:00:00Z","updated_at":"2026-01-03T00:00:00Z","merge_commit_sha":"abc123","labels":["bug"],"sha":"abc123","source_branch":"feat","diff_refs":{"head_sha":"abc123"},"author":{"username":"dev"}}'

// d1 sits on the current diff head — d4's note is pinned to oldsha99,
// so outdated comes from position.head_sha, not the flaky `active` flag
const DISCUSSIONS = `[{"id":"d1","individual_note":false,"notes":[{"id":1,"resolvable":true,"resolved":false,"body":"fix this","created_at":"2026-01-01","author":{"username":"project_7_bot_x"},"position":{"new_path":"a.ts","new_line":3,"head_sha":"abc123"}}]},{"id":"d2","individual_note":true,"notes":[{"id":2,"resolvable":false,"body":"nope","author":{"username":"dev"}}]},{"id":"d3","individual_note":false,"notes":[{"id":3,"resolvable":false,"body":"chat","author":{"username":"dev"}}]},{"id":"d4","individual_note":false,"notes":[{"id":4,"resolvable":true,"resolved":true,"body":"done","author":{"username":"dev"},"position":{"new_path":"b.ts","new_line":9,"head_sha":"oldsha99"}}]}]`

/** Scripted glab on PATH — records argv + GITLAB_HOST to $FAKE_GLAB_LOG,
 *  answers REST reads by endpoint shape and writes by method+endpoint. */
const FAKE_GLAB = `#!/bin/sh
echo "$@" >> "$FAKE_GLAB_LOG"
echo "env:GITLAB_HOST=$GITLAB_HOST" >> "$FAKE_GLAB_LOG"
case "$1 $2" in
  "auth status") if [ "$FAKE_GLAB_AUTH_FAIL" = "1" ]; then exit 1; fi; exit 0 ;;
  "api -X") case "$3 $4" in
      "POST "*"/notes") echo '{"id":99}' ;;
      "PUT "*"/discussions/"*) echo '{}' ;;
      "PUT "*"/rebase") if [ "$FAKE_GLAB_REBASE_FAIL" = "1" ]; then echo 'rebase refused' >&2; exit 1; fi; echo '{}' ;;
      "PUT "*"/merge") echo '{"state":"merged"}' ;;
      "POST "*"/labels") if [ "$FAKE_GLAB_LABEL_EXISTS" = "1" ]; then echo 'Label already exists' >&2; exit 1; fi; echo '{}' ;;
      "PUT "*"/labels/"*) echo '{}' ;;
      "PUT "*"/merge_requests/"*) echo '{"iid":7,"updated_at":"2026-02-02T00:00:00Z"}' ;;
    esac ;;
  "api "*) case "$2" in
      *"merge_requests?source_branch="*"state=opened"*) echo "\${FAKE_GLAB_OPEN_MRS:-[]}" ;;
      *"merge_requests?source_branch="*) echo "\${FAKE_GLAB_ANY_MRS:-[]}" ;;
      *"merge_requests?state=merged"*) echo "\${FAKE_GLAB_MERGED_LIST:-[]}" ;;
      *"/jobs"*) echo '[{"id":1,"name":"build","status":"success"},{"id":2,"name":"kilo","status":"running"},{"id":3,"name":"lint","status":"manual"}]' ;;
      *"/bridges"*) echo '[]' ;;
      *"/pipelines"*) echo '[{"id":11,"sha":"abc123","status":"success"}]' ;;
      *"/versions"*) echo '[{"head_commit_sha":"a1"},{"head_commit_sha":"a2"},{"head_commit_sha":"a1"}]' ;;
      *"/discussions"*) echo '${DISCUSSIONS}' ;;
      *"/merge_requests/"*)
        iid=$(echo "$2" | sed 's/.*merge_requests\\///; s/[^0-9].*//')
        case ",$FAKE_GLAB_MR_FAIL," in *",$iid,"*) echo 'glab api failed: 404 Not Found' >&2; exit 1 ;; esac
        if [ -n "$FAKE_GLAB_MR" ]; then echo "$FAKE_GLAB_MR";
        else echo '${MR_DEFAULT}' | sed "s/%IID%/$iid/g"; fi ;;
      *) echo '[]' ;;
    esac ;;
esac
`

/** A git repo in a tmpdir with `url` as origin — remote detection needs
 *  a real checkout, the host never sees a call. */
function makeRepo(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gitlab-'))
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' })
  execSync(`git remote add origin ${url}`, { cwd: dir, stdio: 'ignore' })
  return dir
}

function withFakeGlab(env: Record<string, string>, fn: (log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-glab-'))
  const log = join(dir, 'glab.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'glab'), FAKE_GLAB)
  chmodSync(join(dir, 'glab'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_GLAB_LOG: log, ...env })
  try {
    fn(log)
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete process.env.FAKE_GLAB_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withFakeGlabAsync(
  env: Record<string, string>,
  fn: (log: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-glab-'))
  const log = join(dir, 'glab.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'glab'), FAKE_GLAB)
  chmodSync(join(dir, 'glab'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const prevLog = process.env.FAKE_GLAB_LOG
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_GLAB_LOG: log, ...env })
  try {
    await fn(log)
  } finally {
    process.env.PATH = prevPath
    if (prevLog === undefined) delete process.env.FAKE_GLAB_LOG
    else process.env.FAKE_GLAB_LOG = prevLog
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const target = { repo: 'acme/widgets', pr: 42 }

describe('gitlab connector', () => {
  test('matchRemote claims gitlab.com hosts only', () => {
    assert.equal(gitlabConnector.matchRemote?.('git@gitlab.com:acme/widgets.git'), true)
    assert.equal(gitlabConnector.matchRemote?.('https://gitlab.com/acme/widgets.git'), true)
    assert.equal(gitlabConnector.matchRemote?.('git@github.com:acme/widgets.git'), false)
    assert.equal(gitlabConnector.matchRemote?.('git@evilgitlab.com:acme/widgets.git'), false)
    assert.equal(gitlabConnector.matchRemote?.('git@ops.gitlab.com:acme/w.git'), true)
    // right-edge lookalikes — a `gitlab` label off the gitlab.com edge is
    // indistinguishable from phishing, so self-hosted goes through config
    assert.equal(gitlabConnector.matchRemote?.('git@gitlab.com.evil.com:acme/w.git'), false)
    assert.equal(gitlabConnector.matchRemote?.('git@gitlab.corp.internal:acme/w.git'), false)
  })

  test('parsePrRef extracts repo/mr from the bound host only', () => {
    const rev = gitlabReview(mkdtempSync(join(tmpdir(), 'bro-gl-ref-')))
    assert.deepEqual(rev.parsePrRef('see https://gitlab.com/acme/widgets/-/merge_requests/42'), {
      repo: 'acme/widgets',
      pr: 42,
    })
    // nested group paths keep their slashes
    assert.deepEqual(rev.parsePrRef('https://gitlab.com/a/b/c/-/merge_requests/9'), {
      repo: 'a/b/c',
      pr: 9,
    })
    assert.equal(rev.parsePrRef('fix the thing'), null)
    assert.equal(rev.parsePrRef('https://github.com/acme/widgets/pull/42'), null)
    assert.equal(rev.parsePrRef('https://gitlab.com.evil.com/x/-/merge_requests/9'), null)
  })

  test('resolveRepo reads the origin remote path, positionals join', () => {
    const dir = makeRepo('git@gitlab.com:a/b/c.git')
    try {
      const rev = gitlabReview(dir)
      assert.equal(rev.resolveRepo([]), 'a/b/c')
      assert.equal(rev.resolveRepo(['x', 'y', 'z']), 'x/y/z')
      assert.equal(rev.resolveRepo(['x/y']), 'x/y')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('auth probes glab, naming the detected host in the remediation', () => {
    withFakeGlab({}, () => {
      assert.equal(gitlabConnector.auth!({ dir: mkdtempSync(join(tmpdir(), 'x-')) }), null)
    })
    withFakeGlab({ FAKE_GLAB_AUTH_FAIL: '1' }, () => {
      const msg = gitlabConnector.auth!({ dir: mkdtempSync(join(tmpdir(), 'x-')) })
      assert.match(msg ?? '', /glab not authenticated for gitlab\.com/)
    })
    // a self-hosted remote scopes the probe to its own host — both the
    // --hostname flag and the GITLAB_HOST env pin
    const selfHosted = makeRepo('git@gitlab.corp.com:a/b.git')
    try {
      withFakeGlab({}, (log) => {
        gitlabConnector.auth!({ dir: selfHosted })
        const lines = readFileSync(log, 'utf8')
        assert.match(lines, /auth status --hostname gitlab\.corp\.com/)
        assert.match(lines, /env:GITLAB_HOST=gitlab\.corp\.com/)
      })
    } finally {
      rmSync(selfHosted, { recursive: true, force: true })
    }
  })

  test('facade resolution picks gitlab on a gitlab remote, github on github', () => {
    registerConnector(githubConnector)
    registerConnector(gitlabConnector)
    const gl = makeRepo('git@gitlab.com:acme/widgets.git')
    const gh = makeRepo('git@github.com:acme/widgets.git')
    try {
      const g = facade('reviews', { dir: gl })
      assert.equal(g.prLink('acme/widgets', 7), '[#7](https://gitlab.com/acme/widgets/-/merge_requests/7)')
      const h = facade('reviews', { dir: gh })
      assert.equal(h.prLink('acme/widgets', 7), '[#7](https://github.com/acme/widgets/pull/7)')
    } finally {
      rmSync(gl, { recursive: true, force: true })
      rmSync(gh, { recursive: true, force: true })
    }
  })
})

describe('gitlabReview', { skip: WIN32 }, () => {
  test('prMeta normalizes the MR row — opened→OPEN, CI-pending stays MERGEABLE', () => {
    withFakeGlab(
      {
        FAKE_GLAB_MR:
          '{"iid":42,"state":"opened","draft":true,"web_url":"u","sha":"abc123","source_branch":"feat","target_branch":"main","detailed_merge_status":"ci_still_running"}',
      },
      () => {
        const meta = gitlabReview().prMeta(target)
        assert.equal(meta.state, 'OPEN')
        assert.equal(meta.isDraft, true)
        assert.equal(meta.headSha, 'abc123')
        assert.equal(meta.baseRef, 'main')
        // pending CI is its own gate signal — mergeable only answers
        // "does it conflict"
        assert.equal(meta.mergeable, 'MERGEABLE')
      }
    )
  })

  test('prMeta maps conflict→CONFLICTING, checking→UNKNOWN, need_rebase→BEHIND', () => {
    for (const [dms, mergeable, mergeState] of [
      ['conflict', 'CONFLICTING', 'CONFLICT'],
      ['checking', 'UNKNOWN', 'CHECKING'],
      ['need_rebase', 'MERGEABLE', 'BEHIND'],
      ['mergeable', 'MERGEABLE', 'CLEAN'],
    ] as const) {
      withFakeGlab(
        { FAKE_GLAB_MR: `{"iid":42,"state":"opened","detailed_merge_status":"${dms}"}` },
        () => {
          const meta = gitlabReview().prMeta(target)
          assert.equal(meta.mergeable, mergeable, dms)
          assert.equal(meta.mergeState, mergeState, dms)
        }
      )
    }
  })

  test('checks folds head-pipeline jobs+bridges into bucketed checks', () => {
    withFakeGlab({ FAKE_GLAB_MR: '{"iid":42,"state":"opened","sha":"abc123"}' }, (log) => {
      const got = gitlabReview().checks(target)
      assert.deepEqual(
        got.map((c) => [c.name, c.bucket]),
        [
          ['build', 'pass'],
          ['kilo', 'pending'],
          ['lint', 'skipping'],
        ]
      )
      const lines = readFileSync(log, 'utf8')
      assert.match(lines, /merge_requests\/42\/pipelines/)
      assert.match(lines, /pipelines\/11\/jobs/)
      assert.match(lines, /pipelines\/11\/bridges/)
    })
  })

  test('checks ignores pipelines pinned to an older commit', () => {
    // the fake's only pipeline is sha abc123 — an MR at a moved head has
    // no current pipeline, so no checks rather than stale ones
    withFakeGlab({ FAKE_GLAB_MR: '{"iid":42,"state":"opened","sha":"zzz999"}' }, () => {
      assert.deepEqual(gitlabReview().checks(target), [])
    })
  })

  test('reviewThreads keeps only resolvable discussions, ids carry repo/iid', async () => {
    await withFakeGlabAsync({}, async () => {
      const threads = await gitlabReview().reviewThreads(target)
      assert.equal(threads.length, 2)
      const [a, b] = threads
      assert.deepEqual(
        { id: a!.id, resolved: a!.resolved, outdated: a!.outdated },
        { id: 'acme/widgets/42/d1', resolved: false, outdated: false }
      )
      assert.deepEqual(
        { author: a!.comment!.author, bot: a!.comment!.bot, path: a!.comment!.path, line: a!.comment!.line },
        { author: 'project_7_bot_x', bot: true, path: 'a.ts', line: 3 }
      )
      assert.deepEqual(
        { id: b!.id, resolved: b!.resolved, outdated: b!.outdated },
        { id: 'acme/widgets/42/d4', resolved: true, outdated: true }
      )
    })
  })

  test('resolveThread/replyThread route the composite id back to its MR', () => {
    withFakeGlab({}, (log) => {
      const rev = gitlabReview()
      rev.resolveThread('acme/widgets/42/d1')
      rev.resolveThread('acme/widgets/42/d2', true)
      rev.replyThread('acme/widgets/42/d1', 'fixed — reverting the change')
      const lines = readFileSync(log, 'utf8')
      assert.match(
        lines,
        /api -X PUT projects\/acme%2Fwidgets\/merge_requests\/42\/discussions\/d1 -f resolved=true/
      )
      assert.match(lines, /discussions\/d2 -f resolved=false/)
      assert.match(
        lines,
        /api -X POST projects\/acme%2Fwidgets\/merge_requests\/42\/discussions\/d1\/notes -f body=fixed/
      )
    })
  })

  test('mergedPrInfo returns mergedAt/mergeSha, throws when not merged', () => {
    withFakeGlab({}, () => {
      const info = gitlabReview().mergedPrInfo(target)
      assert.equal(info.mergedAt, '2026-01-02T00:00:00Z')
      assert.equal(info.mergeSha, 'abc123')
    })
    withFakeGlab({ FAKE_GLAB_MR: '{"iid":42,"state":"opened"}' }, () => {
      assert.throws(() => gitlabReview().mergedPrInfo(target), /is not merged/)
    })
  })

  test('mergedPrs explicit ids dedups, skips unmerged, throws on outage', () => {
    withFakeGlab({}, (log) => {
      const prs = gitlabReview().mergedPrs('acme/widgets', { ids: [7, 7, 8, 7] })
      assert.equal(prs.length, 2)
      const fetches = readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => /merge_requests\/\d+$/.test(l))
      assert.equal(fetches.length, 2)
    })
    withFakeGlab({ FAKE_GLAB_MR_FAIL: '8' }, () => {
      const errs: string[] = []
      const origError = console.error
      console.error = (m: unknown) => errs.push(String(m))
      try {
        const prs = gitlabReview().mergedPrs('acme/widgets', { ids: [7, 8] })
        assert.equal(prs.length, 1)
      } finally {
        console.error = origError
      }
      assert.match(errs.join('\n'), /fetch failed/)
    })
    withFakeGlab({ FAKE_GLAB_MR_FAIL: '7,8' }, () => {
      assert.throws(() => gitlabReview().mergedPrs('acme/widgets', { ids: [7, 8] }), /all 2 MR fetch/)
    })
  })

  test('mergedPrs list path hits state=merged with the filter params', () => {
    withFakeGlab(
      {
        FAKE_GLAB_MERGED_LIST:
          '[{"iid":9,"state":"merged","merged_at":"2026-01-02T00:00:00Z","author":{"username":"dev"},"labels":[],"source_branch":"x","sha":"s1"}]',
      },
      (log) => {
        const prs = gitlabReview().mergedPrs('acme/widgets', { author: 'dev', limit: 10 })
        assert.equal(prs.length, 1)
        assert.equal(prs[0]!.number, 9)
        assert.match(readFileSync(log, 'utf8'), /state=merged.*author_username=dev/)
      }
    )
  })

  test('scanMergedPrs pools per-MR meta+threads probes', async () => {
    await withFakeGlabAsync({}, async (log) => {
      const scans = await gitlabReview().scanMergedPrs!([
        { repo: 'acme/widgets', pr: 7 },
        { repo: 'acme/widgets', pr: 8 },
      ])
      assert.equal(scans.size, 2)
      const s = scans.get(7)!
      assert.equal(s.info.mergeSha, 'abc123')
      assert.equal(s.threads.length, 2)
      assert.deepEqual(s.labels, ['bug'])
      const lines = readFileSync(log, 'utf8')
      assert.equal(lines.split('\n').filter((l) => /discussions/.test(l)).length, 2)
    })
  })

  test('scanMergedPrs skips non-merged targets and reports progress', async () => {
    await withFakeGlabAsync(
      { FAKE_GLAB_MR: '{"iid":9,"state":"opened"}' },
      async () => {
        const marks: Array<[number, number]> = []
        const scans = await gitlabReview().scanMergedPrs!(
          [{ repo: 'acme/widgets', pr: 9 }],
          { onProgress: (d, t) => marks.push([d, t]) }
        )
        assert.equal(scans.size, 0)
        assert.deepEqual(marks, [[1, 1]])
      }
    )
  })

  test('labelPrs writes add+remove in one PUT; response carries the cursor', async () => {
    await withFakeGlabAsync({}, async (log) => {
      const out = await gitlabReview().labelPrs!([
        { t: { repo: 'acme/widgets', pr: 7 }, add: ['debt:collected'], remove: ['debt:clean'] },
        { t: { repo: 'acme/widgets', pr: 8 }, add: ['debt:clean'], remove: [] },
      ])
      assert.deepEqual(
        [...out.entries()].sort(),
        [
          [7, '2026-02-02T00:00:00Z'],
          [8, '2026-02-02T00:00:00Z'],
        ]
      )
      const lines = readFileSync(log, 'utf8')
      assert.match(lines, /PUT projects\/acme%2Fwidgets\/merge_requests\/7 -f add_labels=debt:collected -f remove_labels=debt:clean/)
      assert.match(lines, /merge_requests\/8 -f add_labels=debt:clean/)
      assert.doesNotMatch(lines, /merge_requests\/8 -f.*remove_labels/)
      // the PUT response is the MR — no updated_at re-query
      assert.equal(lines.split('\n').filter((l) => /^api projects.*merge_requests\/\d+$/.test(l)).length, 0)
    })
  })

  test('createLabel retries an existing label through its resource route', () => {
    withFakeGlab({ FAKE_GLAB_LABEL_EXISTS: '1' }, (log) => {
      gitlabReview().createLabel('acme/widgets', 'debt:collected', '#112233')
      const lines = readFileSync(log, 'utf8')
      assert.match(lines, /POST projects\/acme%2Fwidgets\/labels -f name=debt:collected/)
      // GitLab updates a label via PUT /labels/:name — the deprecated
      // collection PUT with name as a param must not be used
      assert.match(lines, /PUT projects\/acme%2Fwidgets\/labels\/debt%3Acollected -f color=#112233/)
    })
  })

  test('facade calls pin GITLAB_HOST to the detected remote host', () => {
    const dir = makeRepo('git@gitlab.corp.com:a/b.git')
    try {
      withFakeGlab({}, (log) => {
        gitlabReview(dir).prsForBranch('main')
        assert.match(readFileSync(log, 'utf8'), /env:GITLAB_HOST=gitlab\.corp\.com/)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('currentPr/prsForBranch answer from the checked-out branch', () => {
    const dir = makeRepo('git@gitlab.com:acme/widgets.git')
    try {
      withFakeGlab(
        { FAKE_GLAB_OPEN_MRS: '[{"iid":5,"state":"opened","web_url":"u5"}]' },
        () => {
          assert.deepEqual(gitlabReview(dir).currentPr(), { pr: 5, state: 'OPEN', url: 'u5' })
          assert.deepEqual(gitlabReview(dir).prsForBranch('main'), [5])
        }
      )
      withFakeGlab({}, () => {
        assert.equal(gitlabReview(dir).currentPr(), null)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('updateBranch checks the head sha, then PUTs the rebase', () => {
    withFakeGlab({}, (log) => {
      assert.equal(gitlabReview().updateBranch(target, 'abc123'), true)
      assert.match(readFileSync(log, 'utf8'), /PUT projects\/acme%2Fwidgets\/merge_requests\/42\/rebase/)
    })
    withFakeGlab({}, () => {
      assert.equal(gitlabReview().updateBranch(target, 'moved-head'), false)
    })
    withFakeGlab({ FAKE_GLAB_REBASE_FAIL: '1' }, () => {
      assert.equal(gitlabReview().updateBranch(target, 'abc123'), false)
    })
  })

  test('mergePr pins the head sha and returns the post-merge state', () => {
    withFakeGlab({}, (log) => {
      const state = gitlabReview().mergePr(target, {
        method: 'squash',
        expectedHeadSha: 'abc123',
        deleteBranch: true,
      })
      assert.equal(state, 'MERGED')
      const lines = readFileSync(log, 'utf8')
      assert.match(
        lines,
        /PUT projects\/acme%2Fwidgets\/merge_requests\/42\/merge -f sha=abc123 -f squash=true -f should_remove_source_branch=true/
      )
      // merge_method is project config, not a merge-endpoint param
      assert.doesNotMatch(lines, /merge_method/)
    })
  })
})
