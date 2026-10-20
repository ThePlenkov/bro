/** github-issue transport (specs/cross-repo/bro-kim1e) — the pure
 *  halves: remote parsing, the comment record format (last fenced
 *  json block wins, prose bodies carry no record), the 50-char label
 *  budget, and author-login provenance. Anything that shells to `gh`
 *  is covered by the gated e2e at the bottom — opt-in, skipped when
 *  unauthenticated. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { MESH_VERSION, type MeshEnvelope } from './envelope.ts'
import {
  githubProvenance,
  issueKey,
  parseComment,
  parseGithubRemote,
  renderComment,
  renderIssueBody,
  routingLabels,
} from './github.ts'

const env = (over: Partial<MeshEnvelope> = {}): MeshEnvelope => ({
  v: MESH_VERSION,
  id: 'req-1',
  kind: 'request',
  thread: 'req-1',
  from: 'mesh://acme/one',
  to: 'mesh://acme/two',
  title: 't',
  body: 'b',
  refs: [],
  terms: {},
  evidence: [],
  ...over,
})

describe('parseGithubRemote', () => {
  test('https / git@ / ssh forms, .git and trailing slash tolerated', () => {
    const want = { owner: 'acme', repo: 'rig' }
    for (const remote of [
      'https://github.com/acme/rig',
      'https://github.com/acme/rig.git',
      'https://github.com/acme/rig/',
      'http://github.com/acme/rig.git',
      'git@github.com:acme/rig.git',
      'ssh://git@github.com/acme/rig.git',
      'ssh://git@github.com:22/acme/rig',
    ]) {
      assert.deepEqual(parseGithubRemote({ remote }), want, remote)
    }
    // owner/repo lowercase — the api path is case-sensitive
    assert.deepEqual(parseGithubRemote({ remote: 'https://github.com/ACME/Rig.git' }), want)
  })

  test('other hosts and non-urls return null — the caller reports the gap', () => {
    for (const remote of [
      'https://gitlab.com/acme/rig.git',
      'git@gitlab.com:acme/rig.git',
      'https://github.example.com/acme/rig',
      '/local/path',
      'wl://org/board',
      'https://github.com/acme',
      'https://github.com/a/b/c',
      '',
    ]) {
      assert.equal(parseGithubRemote({ remote }), null, remote)
    }
  })
})

describe('issue thread ids', () => {
  test('issueKey strips the /issues/<n> tail and reads it', () => {
    const url = 'https://github.com/acme/rig/issues/42'
    assert.deepEqual(issueKey({ thread: url }).repo, { owner: 'acme', repo: 'rig' })
    assert.equal(issueKey({ thread: url }).n, 42)
    assert.equal(issueKey({ thread: 'https://github.com/acme/rig' }).n, null)
    // a bare repo url has no /issues tail — the repo still parses
    assert.deepEqual(issueKey({ thread: 'https://github.com/acme/rig' }).repo, { owner: 'acme', repo: 'rig' })
    assert.equal(issueKey({ thread: 'https://gitlab.com/acme/rig/issues/1' }).repo, null)
  })
})

describe('comment records', () => {
  test('render → parse round-trips the envelope', () => {
    const e = env({ refs: [{ kind: 'url', ref: 'https://x' }], terms: { priority: 'p2' } })
    const parsed = parseComment({ body: renderComment(e) })
    // toEnvelope materializes absent optional fields as undefined —
    // compare on the wire shape
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.envelope)), e)
  })

  test('the LAST fenced json block wins — footers and appended text do not hide it', () => {
    const first = env({ id: 'old', thread: 'old', title: 'old' })
    const last = env({ id: 'new', thread: 'new', title: 'new' })
    const body = [
      renderComment(first),
      '',
      '- [ ] appended checklist item',
      '```json',
      '{"not":"an envelope"}',
      '```',
      renderComment(last),
      '',
      'cross-reference footer added by github',
    ].join('\n')
    const parsed = parseComment({ body })
    assert.equal(parsed.envelope?.id, 'new')
  })

  test('a comment with no valid block is an error line, never a request', () => {
    for (const body of [
      'plain prose, no fences',
      '```json\n{"kind":"nope"}\n```',
      '```json\nnot json\n```',
      '```\n{"v":"mesh/1"}\n```', // unlabelled fence — not a record block
    ]) {
      assert.match(parseComment({ body }).error ?? '', /no valid mesh\/1 record/, body)
    }
  })

  test('a non-request mesh kind still parses — admission (kind==="request") is the caller\'s filter', () => {
    for (const kind of ['claim', 'result', 'accept', 'reject'] as const) {
      const parsed = parseComment({ body: renderComment(env({ kind })) })
      assert.equal(parsed.envelope?.kind, kind)
    }
  })

  test('the issue body carries NO machine block — a maintainer rewriting it destroys nothing', () => {
    const body = renderIssueBody({ from: 'mesh://acme/one', to: 'mesh://acme/two', body: 'please fix the thing' })
    assert.match(body, /please fix the thing/)
    assert.match(body, /first comment/)
    assert.match(parseComment({ body }).error ?? '', /no valid mesh\/1 record/)
  })
})

describe('routingLabels', () => {
  test('labels are an index: over-50 drops whole, never truncates; mesh:thread: never rides', () => {
    const e = env({
      to: 'mesh://a-very-long-org-name/a-very-long-repo-name', // mesh:to: = 59 chars
      refs: [{ kind: 'url', ref: 'https://example.com/some/quite/long/ref/path' }],
      thread: 'https://github.com/acme/rig/issues/1',
    })
    const labels = routingLabels(e)
    assert.ok(labels.includes('mesh:v:1'))
    assert.ok(labels.includes('mesh:kind:request'))
    for (const l of labels) {
      assert.ok(l.length <= 50, l)
    }
    // the overflowing to/ref labels dropped WHOLE — a truncated
    // mesh:to: is a different string that matches nothing
    assert.ok(!labels.some((l) => l.startsWith('mesh:to:') || l.startsWith('mesh:ref:')))
    assert.ok(!labels.some((l) => l.startsWith('mesh:thread:')))
  })

  test('fitting labels survive verbatim', () => {
    const labels = routingLabels(env())
    assert.ok(labels.includes(`mesh:from:mesh://acme/one`))
    assert.ok(labels.includes(`mesh:to:mesh://acme/two`))
  })
})

describe('githubProvenance', () => {
  const peer = { rig: 'mesh://acme/far', login: 'acme-bot' }

  test('the bound login attests the peer rig', () => {
    assert.deepEqual(githubProvenance({ author: 'acme-bot', peer, selfLogin: 'me', ownRig: 'mesh://acme/mine' }), {
      provenance: 'mesh://acme/far',
    })
  })

  test('this account attests the own rig — and fails loud when it cannot resolve', () => {
    assert.deepEqual(githubProvenance({ author: 'me', peer, selfLogin: 'me', ownRig: 'mesh://acme/mine' }), {
      provenance: 'mesh://acme/mine',
    })
    assert.match(
      githubProvenance({ author: 'me', peer, selfLogin: 'me', ownRig: null }).error ?? '',
      /identity doesn't resolve/,
    )
  })

  test('a mismatch is flagged, never admitted', () => {
    const v = githubProvenance({ author: 'intruder', peer, selfLogin: 'me', ownRig: 'mesh://acme/mine' })
    assert.equal(v.provenance, undefined)
    assert.match(v.error ?? '', /neither peer login acme-bot nor this account/)
  })

  test('a binding with no login admits nothing — never falls back to `from`', () => {
    const v = githubProvenance({ author: 'acme-bot', peer: { rig: 'mesh://acme/far' }, selfLogin: 'me', ownRig: 'mesh://acme/mine' })
    assert.equal(v.provenance, undefined)
    assert.match(v.error ?? '', /no login/)
    // …even for the OWN account's records: the binding itself is broken
    const own = githubProvenance({ author: 'me', peer: { rig: 'mesh://acme/far' }, selfLogin: 'me', ownRig: 'mesh://acme/mine' })
    assert.equal(own.provenance, undefined)
  })

  test('own-repo plane: no bound peer, self attests, strangers flag', () => {
    assert.deepEqual(githubProvenance({ author: 'me', peer: undefined, selfLogin: 'me', ownRig: 'mesh://acme/mine' }), {
      provenance: 'mesh://acme/mine',
    })
    assert.match(
      githubProvenance({ author: 'stranger', peer: undefined, selfLogin: 'me', ownRig: 'mesh://acme/mine' }).error ?? '',
      /neither a bound login nor this account/,
    )
  })
})

describe('why no external: dep on this plane', () => {
  // pins the bd 1.3.1 behaviour the mirror-bead design rests on — a
  // silent "fix" here means the decision was silently reverted
  test('bd splits external: on the FIRST colon — a mesh:// uri lands in project=mesh', () => {
    const raw = 'external:mesh://theplenkov/bro:bro-kim1e'
    // strings.SplitN(raw, ":", 3) — at most 3 fields; the LAST keeps
    // the remainder, separators and all (js split(':',3) truncates it)
    const i1 = raw.indexOf(':')
    const i2 = raw.indexOf(':', i1 + 1)
    const parts = [raw.slice(0, i1), raw.slice(i1 + 1, i2), raw.slice(i2 + 1)]
    assert.deepEqual(parts, ['external', 'mesh', '//theplenkov/bro:bro-kim1e'])
    // project='mesh' is configured never; the edge is stored pointing
    // at a project name nothing can resolve
    assert.equal(parts[1], 'mesh')
  })
})

// ---- gated e2e (specs/cross-repo/bro-kim1e Plan, last item) ----
// Opt-in: BRO_MESH_E2E_REPO=owner/repo names a scratch repo the
// authenticated account may post issues to. Two accounts (requester /
// worker) need two real orgs the team controls — this run plays both
// halves from one account, which settles the transport mechanics;
// the cross-account provenance half stays a manual e2e.

const E2E_REPO = process.env.BRO_MESH_E2E_REPO

describe('github e2e (gated)', () => {
  test('request → claim → result → accept over issue comments', async (t) => {
    if (E2E_REPO === undefined || E2E_REPO === '') {
      t.skip('set BRO_MESH_E2E_REPO=owner/repo to run')
      return
    }
    if (spawnSync('gh', ['auth', 'status']).status !== 0) {
      t.skip('gh not authenticated')
      return
    }
    const { postRequest, postComment, issueComments, parseGithubRemote, issueKey } = await import('./github.ts')
    const repo = parseGithubRemote({ remote: E2E_REPO })
    assert.ok(repo, `BRO_MESH_E2E_REPO "${E2E_REPO}" is not a github repo`)

    const posted = postRequest({
      remote: E2E_REPO,
      from: 'mesh://e2e/a',
      to: 'mesh://e2e/b',
      title: `mesh e2e ${Date.now()}`,
      body: 'e2e scratch — close me',
    })
    assert.ok(posted.issue, posted.error)
    const issue = posted.issue
    const n = issueKey({ thread: issue }).n
    assert.ok(n !== null)
    const read = () =>
      issueComments(repo, { number: n }).records.map((r) => r.envelope)

    // the request record landed as the first comment
    assert.deepEqual(read().map((e) => e.kind), ['request'])

    for (const kind of ['claim', 'result', 'accept'] as const) {
      const r = postComment({
        thread: issue,
        env: { ...env({ id: `${issue}#${kind}`, kind, thread: issue }) },
      })
      assert.equal(r.error, undefined)
    }
    assert.deepEqual(read().map((e) => e.kind), ['request', 'claim', 'result', 'accept'])
  })
})
