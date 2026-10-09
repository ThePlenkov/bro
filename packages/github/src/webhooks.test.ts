import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, test } from 'node:test'
import {
  githubEventConcernsPr,
  githubWebhookEvent,
  githubWebhookHandler,
  parseGithubWebhookBody,
  verifyGithubWebhook,
} from './webhooks.ts'

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

describe('verifyGithubWebhook', () => {
  const body = '{"zen":"keep it simple"}'

  test('a correct signature verifies; anything else fails', () => {
    assert.equal(verifyGithubWebhook('s3cret', body, sign('s3cret', body)), true)
    assert.equal(verifyGithubWebhook('s3cret', body, sign('other', body)), false)
    assert.equal(verifyGithubWebhook('s3cret', `${body} `, sign('s3cret', body)), false)
    assert.equal(verifyGithubWebhook('s3cret', body, undefined), false)
    assert.equal(verifyGithubWebhook('s3cret', body, 'sha256=nothex'), false)
    // sha1 fallback headers don't pass — sha256 only
    assert.equal(verifyGithubWebhook('s3cret', body, `sha1=${sign('s3cret', body).slice(7)}`), false)
  })
})

describe('parseGithubWebhookBody', () => {
  test('application/json parses the body verbatim', () => {
    assert.deepEqual(parseGithubWebhookBody('application/json', '{"a":1}'), { a: 1 })
  })

  test('urlencoded rides the payload= field — a repo webhook default', () => {
    const body = `payload=${encodeURIComponent('{"a":1}')}`
    assert.deepEqual(parseGithubWebhookBody('application/x-www-form-urlencoded', body), { a: 1 })
    assert.equal(parseGithubWebhookBody('application/x-www-form-urlencoded', 'other=1'), undefined)
  })

  test('malformed bodies return undefined, not a throw', () => {
    assert.equal(parseGithubWebhookBody('application/json', '{nope'), undefined)
    assert.equal(
      parseGithubWebhookBody('application/x-www-form-urlencoded', `payload=${encodeURIComponent('{nope')}`),
      undefined
    )
  })
})

const prPayload = {
  action: 'synchronize',
  number: 388,
  pull_request: { number: 388, html_url: 'https://github.com/o/r/pull/388', head: { sha: 'abc' } },
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  sender: { login: 'pepl' },
}

describe('githubWebhookEvent', () => {
  test('pull_request maps topic/kind/key/ref and a bounded projection', () => {
    const e = githubWebhookEvent('pull_request', 'del-1', prPayload)
    assert.ok(e !== undefined)
    assert.equal(e.topic, 'github:pull_request')
    assert.equal(e.kind, 'synchronize')
    assert.equal(e.key, 'pr-388')
    assert.equal(e.ref, 'https://github.com/o/r/pull/388')
    assert.equal(e.source, 'github')
    const p = e.payload as Record<string, unknown>
    assert.deepEqual(p['prs'], [388])
    assert.equal(p['repo'], 'o/r')
    assert.equal(p['sender'], 'pepl')
    assert.equal(p['delivery'], 'del-1')
  })

  test('issue_comment on a PR links the pr; on an issue it does not', () => {
    const onPr = githubWebhookEvent('issue_comment', 'd', {
      action: 'created',
      issue: { number: 42, html_url: 'https://github.com/o/r/issues/42', pull_request: {} },
      repository: { full_name: 'o/r' },
    })
    assert.ok(onPr !== undefined)
    assert.equal(onPr.key, 'pr-42')
    assert.deepEqual((onPr.payload as Record<string, unknown>)['prs'], [42])

    const onIssue = githubWebhookEvent('issue_comment', 'd', {
      action: 'created',
      issue: { number: 42, html_url: 'https://github.com/o/r/issues/42' },
      repository: { full_name: 'o/r' },
    })
    assert.ok(onIssue !== undefined)
    assert.equal(onIssue.key, undefined)
    assert.deepEqual((onIssue.payload as Record<string, unknown>)['prs'], [])
  })

  test('check_run carries sha + linkage; an unlinked one keeps sha identity', () => {
    const linked = githubWebhookEvent('check_run', 'd', {
      action: 'completed',
      check_run: {
        name: 'build',
        head_sha: 'deadbeefcafe',
        conclusion: 'success',
        html_url: 'https://github.com/o/r/checks/1',
        pull_requests: [{ number: 7 }],
      },
      repository: { full_name: 'o/r' },
    })
    assert.ok(linked !== undefined)
    assert.equal(linked.key, 'pr-7')
    const lp = linked.payload as Record<string, unknown>
    assert.deepEqual(lp['prs'], [7])
    assert.equal(lp['checkName'], 'build')
    assert.equal(lp['conclusion'], 'success')
    assert.equal(lp['sha'], 'deadbeefcafe')

    const unlinked = githubWebhookEvent('check_suite', 'd', {
      action: 'completed',
      check_suite: { head_sha: 'deadbeefcafe', conclusion: 'failure', pull_requests: [] },
      repository: { full_name: 'o/r' },
    })
    assert.ok(unlinked !== undefined)
    assert.equal(unlinked.key, 'sha-deadbeefcafe')
    assert.equal(unlinked.kind, 'completed')
    assert.deepEqual((unlinked.payload as Record<string, unknown>)['prs'], [])
  })

  test('an actionless event names itself as kind; ping maps too', () => {
    const e = githubWebhookEvent('ping', 'd', { zen: 'x', repository: { full_name: 'o/r' } })
    assert.ok(e !== undefined)
    assert.equal(e.topic, 'github:ping')
    assert.equal(e.kind, 'ping')
  })

  test('non-object payloads are not events', () => {
    assert.equal(githubWebhookEvent('push', 'd', 'a string'), undefined)
    assert.equal(githubWebhookEvent('push', 'd', null), undefined)
    assert.equal(githubWebhookEvent('', 'd', {}), undefined)
  })
})

describe('githubEventConcernsPr', () => {
  test('PR-linked events match only their PR; unlinked match all', () => {
    const linked = { topic: 'github:pull_request', payload: { prs: [388] } }
    assert.equal(githubEventConcernsPr(linked, 388), true)
    assert.equal(githubEventConcernsPr(linked, 1), false)

    const unlinked = { topic: 'github:check_suite', payload: { prs: [] } }
    assert.equal(githubEventConcernsPr(unlinked, 1), true)

    // foreign topics and hand-published events without the projection
    assert.equal(githubEventConcernsPr({ topic: 'act', payload: {} }, 388), false)
    assert.equal(githubEventConcernsPr({ topic: 'github:push', payload: {} }, 388), true)
  })
})

describe('githubWebhookHandler', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    secret: () => 's3cret' as string | undefined,
    publish: async () => ({ published: true, seq: 9 }),
    ...over,
  })
  const post = (body: string, headers: Record<string, string> = {}) => ({
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign('s3cret', body),
      ...headers,
    },
  })

  test('no secret configured → 503, fail closed', async () => {
    const h = githubWebhookHandler(deps({ secret: () => undefined }))
    const res = await h(post(JSON.stringify(prPayload)))
    assert.equal(res.status, 503)
  })

  test('bad signature → 401 before anything else is trusted', async () => {
    const h = githubWebhookHandler(deps())
    const res = await h(post(JSON.stringify(prPayload), { 'x-hub-signature-256': 'sha256=bad' }))
    assert.equal(res.status, 401)
  })

  test('verified delivery → 202 and the mapped event is published', async () => {
    let seen: unknown
    const h = githubWebhookHandler(
      deps({ publish: async (e: unknown) => ((seen = e), { published: true, seq: 9 }) })
    )
    const res = await h(post(JSON.stringify(prPayload), { 'x-github-delivery': 'del-1' }))
    assert.equal(res.status, 202)
    const body = res.body as Record<string, unknown>
    assert.equal(body['accepted'], true)
    assert.equal(body['published'], true)
    assert.equal(body['seq'], 9)
    const event = seen as Record<string, unknown>
    assert.equal(event['topic'], 'github:pull_request')
    assert.equal(event['key'], 'pr-388')
  })

  test('missing event header / unparseable body → 400', async () => {
    const h = githubWebhookHandler(deps())
    const body = JSON.stringify(prPayload)
    const noEvent = await h(
      post(body, { 'x-github-event': undefined as unknown as string })
    )
    assert.equal(noEvent.status, 400)
    // remove the header rather than send an undefined value
    const h2 = githubWebhookHandler(deps())
    const r2 = await h2({
      rawBody: body,
      headers: { 'x-hub-signature-256': sign('s3cret', body) },
    })
    assert.equal(r2.status, 400)

    const bad = 'not json'
    const res = await h(post(bad))
    assert.equal(res.status, 400)
  })

  test('broker down → 202 with published:false — transport loss is not a rejection', async () => {
    const h = githubWebhookHandler(
      deps({ publish: async () => ({ published: false, reason: 'broker down' }) })
    )
    const res = await h(post(JSON.stringify(prPayload)))
    assert.equal(res.status, 202)
    const body = res.body as Record<string, unknown>
    assert.equal(body['published'], false)
    assert.equal(body['reason'], 'broker down')
  })

  test('urlencoded body publishes the same mapped event', async () => {
    let seen: unknown
    const h = githubWebhookHandler(deps({ publish: async (e: unknown) => ((seen = e), { published: true }) }))
    const raw = `payload=${encodeURIComponent(JSON.stringify(prPayload))}`
    const res = await h({
      rawBody: raw,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign('s3cret', raw),
      },
    })
    assert.equal(res.status, 202)
    assert.equal((seen as Record<string, unknown>)['topic'], 'github:pull_request')
  })
})
