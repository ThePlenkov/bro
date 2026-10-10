import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { facade, facadeName, registerConnector } from '@broject/core'
import { githubConnector } from './index.ts'
import { githubTasks } from './tasks.ts'

const WIN32 = process.platform === 'win32'

/** Scripted gh on PATH — records argv to $FAKE_GH_LOG, answers by argv
 *  shape. Payloads are env-driven:
 *    FAKE_GH_ISSUES   — the issues(first:) GraphQL page body
 *    FAKE_GH_ISSUE_1  — the FIRST issue(number:) read body (claim's pre-read)
 *    FAKE_GH_ISSUE_2  — every LATER issue(number:) read (claim's verify)
 *    FAKE_GH_SUBS     — the subIssues query body
 *    FAKE_GH_ACTOR    — `api user` login */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
if [ -z "$FAKE_GH_MILESTONES" ]; then FAKE_GH_MILESTONES='[]'; fi
if [ -z "$FAKE_GH_MILESTONE_MADE" ]; then FAKE_GH_MILESTONE_MADE='{}'; fi
case "$1" in
  --version) echo 'gh version 2.80.0 (fake)' ;;
  repo) echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  api)
    case "$2" in
      user)
        case "$*" in
          *--jq*) echo "$FAKE_GH_ACTOR" ;;
          *) echo "{\\"login\\":\\"$FAKE_GH_ACTOR\\"}" ;;
        esac ;;
      graphql)
        case "$*" in
          *deleteIssue*) echo '{}' ;;
          # ISSUES_QUERY lists issues(first: — the singular queries
          # carry issue(number: instead; subIssues rides the bare
          # issue query's field set, so it must match LAST
          *"issues(first"*) echo "$FAKE_GH_ISSUES" ;;
          *"issue(number:\$n){ subIssues"*) echo "$FAKE_GH_SUBS" ;;
          *"issue(number"*)
            n=$(grep -c 'issue(number' "$FAKE_GH_LOG")
            if [ "$n" -le 1 ] && [ -n "$FAKE_GH_ISSUE_1" ]; then
              echo "$FAKE_GH_ISSUE_1"
            else
              echo "$FAKE_GH_ISSUE_2"
            fi ;;
          *) echo '{}' ;;
        esac ;;
      -X)
        case "$*" in
          *"POST"*milestones*) echo "$FAKE_GH_MILESTONE_MADE" ;;
          *"PATCH"*)
            if [ -n "$FAKE_GH_PATCH_FAIL" ]; then echo 'patch failed' >&2; exit 1; fi
            echo '{}' ;;
          *) echo '{}' ;;
        esac ;;
      --paginate)
        case "$*" in
          *milestones*) echo "$FAKE_GH_MILESTONES" ;;
          *) echo '{}' ;;
        esac ;;
      *milestones*) echo "$FAKE_GH_MILESTONES" ;;
      *) echo '{}' ;;
    esac ;;
  issue)
    case "$2" in
      create) echo 'https://github.com/acme/widgets/issues/42' ;;
      *) : ;;
    esac ;;
  label) : ;;
esac
`

interface NodeOpts {
  number: number
  title?: string
  state?: string
  stateReason?: string | null
  labels?: string[]
  assignees?: string[]
  blockedBy?: [number, string][]
  blocking?: [number, string][]
  subIssues?: [number, string][]
  parent?: number
  issueType?: string
  body?: string
  createdAt?: string
  closedAt?: string
  databaseId?: number
}

const ref = (n: [number, string]) => ({ number: n[0], state: n[1] })

/** A GraphQL issue node in the shape tasks.ts queries for. */
function node(o: NodeOpts): Record<string, unknown> {
  const n: Record<string, unknown> = {
    number: o.number,
    id: `ISSUE_ID_${o.number}`,
    databaseId: o.databaseId ?? o.number,
    title: o.title ?? `issue ${o.number}`,
    body: o.body ?? '',
    url: `https://github.com/acme/widgets/issues/${o.number}`,
    state: o.state ?? 'OPEN',
    stateReason: o.stateReason ?? null,
    createdAt: o.createdAt ?? `2026-01-0${o.number}T00:00:00Z`,
    closedAt: o.closedAt ?? null,
    issueType: o.issueType !== undefined ? { name: o.issueType } : null,
    labels: { nodes: (o.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (o.assignees ?? []).map((login) => ({ login })) },
    parent: o.parent !== undefined ? { number: o.parent } : null,
    blockedBy: { nodes: (o.blockedBy ?? []).map(ref) },
    blocking: { nodes: (o.blocking ?? []).map(ref) },
    subIssues: { nodes: (o.subIssues ?? []).map(ref) },
  }
  return n
}

const issuesPage = (nodes: Record<string, unknown>[]): string =>
  JSON.stringify({
    data: {
      repository: {
        issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  })

const issueRead = (n: Record<string, unknown> | null): string =>
  JSON.stringify({ data: { repository: { issue: n } } })

const subIssuesRead = (nodes: Record<string, unknown>[]): string =>
  JSON.stringify({
    data: { repository: { issue: { subIssues: { nodes } } } },
  })

function withFakeGh(
  env: Record<string, string>,
  fn: (log: string, dir: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gh-tasks-'))
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_GH_LOG: log, ...env })
  try {
    fn(log, dir)
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

const calls = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n')
const callsMatching = (log: string, re: RegExp): string[] => calls(log).filter((l) => re.test(l))

describe('githubTasks', { skip: WIN32 }, () => {
  test('list maps issue state/labels/assignees onto task status', () => {
    const issues = issuesPage([
      node({ number: 1, title: 'plain open' }),
      node({ number: 2, title: 'claimed', labels: ['bro:claimed'], assignees: ['me'] }),
      node({ number: 3, title: 'blocked', blockedBy: [[9, 'OPEN']] }),
      node({ number: 4, title: 'closed work', state: 'CLOSED', closedAt: '2026-01-05T00:00:00Z' }),
    ])
    withFakeGh({ FAKE_GH_ISSUES: issues, FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      const rows = githubTasks(dir).list({ all: true })
      const status = new Map(rows.map((r) => [r.id, r.status]))
      assert.deepEqual(Object.fromEntries(status), {
        '1': 'open',
        '2': 'in_progress',
        '3': 'blocked',
        '4': 'closed',
      })
      // the transport carrier never leaves the store
      assert.equal(rows.some((r) => '__node' in r), false)
    })
  })

  test('ready excludes blocked and claimed issues, orders priority then created', () => {
    const issues = issuesPage([
      node({ number: 1, title: 'blocked by open dep', blockedBy: [[9, 'OPEN']], labels: ['p1'] }),
      node({ number: 2, title: 'claimed', assignees: ['me'], labels: ['p1'] }),
      node({ number: 3, title: 'later, higher prio', labels: ['p1'], createdAt: '2026-01-01T00:00:00Z' }),
      node({ number: 4, title: 'earlier, lower prio', labels: ['p2'], createdAt: '2026-01-02T00:00:00Z' }),
      node({ number: 5, title: 'unblocked — dep landed', blockedBy: [[9, 'CLOSED']], labels: ['p2'], createdAt: '2026-01-03T00:00:00Z' }),
      node({ number: 6, title: 'open sub-issues make it not-ready', subIssues: [[7, 'OPEN']], labels: ['p0'] }),
      node({ number: 7, title: 'manual blocked label', labels: ['blocked'] }),
    ])
    withFakeGh({ FAKE_GH_ISSUES: issues, FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      const ready = githubTasks(dir).ready()
      // p1 (3) first; then p2s in created order (4 before 5)
      assert.deepEqual(
        ready.map((r) => r.id),
        ['3', '4', '5']
      )
    })
  })

  test('a closed blocker un-gates the dependent issue — blocked-by ordering', () => {
    const blocked = issuesPage([
      node({ number: 8, title: 'dep', state: 'OPEN' }),
      node({ number: 9, title: 'blocked', blockedBy: [[8, 'OPEN']], labels: ['p0'] }),
    ])
    withFakeGh({ FAKE_GH_ISSUES: blocked, FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      assert.deepEqual(
        githubTasks(dir).ready().map((r) => r.id),
        ['8']
      )
    })
    const unblocked = issuesPage([
      node({ number: 8, title: 'dep', state: 'CLOSED' }),
      node({ number: 9, title: 'now ready', blockedBy: [[8, 'CLOSED']], labels: ['p0'] }),
    ])
    withFakeGh({ FAKE_GH_ISSUES: unblocked, FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      assert.deepEqual(
        githubTasks(dir).ready().map((r) => r.id),
        ['9']
      )
    })
  })

  test('claim assigns the actor and lands bro:claimed after verification', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
        FAKE_GH_ISSUE_2: issueRead(node({ number: 42, assignees: ['me'] })),
      },
      (log, dir) => {
        githubTasks(dir).claim('42')
        const lines = calls(log)
        assert.match(
          lines.find((l) => /issue edit 42 .*--add-assignee me/.test(l)) ?? '',
          /issue edit 42/
        )
        const labelIdx = lines.findIndex((l) => /--add-label bro:claimed/.test(l))
        const assignIdx = lines.findIndex((l) => /--add-assignee me/.test(l))
        // the label lands LAST — it is the commit flag
        assert.ok(assignIdx >= 0 && labelIdx > assignIdx, calls(log).join('\n'))
      }
    )
  })

  test('claim race: the higher-login loser unassigns and throws', () => {
    // session order: my read shows the issue free, my assign lands, the
    // verify re-read shows 'aaa-rival' also grabbed it — lowest login wins
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'zz-me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
        FAKE_GH_ISSUE_2: issueRead(node({ number: 42, assignees: ['zz-me', 'aaa-rival'] })),
      },
      (log, dir) => {
        assert.throws(() => githubTasks(dir).claim('42'), /claim contested — aaa-rival holds it/)
        assert.match(
          callsMatching(log, /--remove-assignee zz-me/).join('\n'),
          /--remove-assignee zz-me/
        )
        // the loser must NOT land the commit flag
        assert.equal(callsMatching(log, /--add-label bro:claimed/).length, 0)
      }
    )
  })

  test('claim race: the lower-login winner keeps the claim and labels', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'aaa-me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
        FAKE_GH_ISSUE_2: issueRead(node({ number: 42, assignees: ['aaa-me', 'zz-rival'] })),
      },
      (log, dir) => {
        githubTasks(dir).claim('42')
        assert.equal(callsMatching(log, /--add-label bro:claimed/).length, 1)
        // the winner never unassigns itself — the loser's removal is theirs to run
        assert.equal(callsMatching(log, /--remove-assignee/).length, 0)
      }
    )
  })

  test('claim refuses an already-claimed issue before assigning', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42, assignees: ['other'] })),
      },
      (log, dir) => {
        assert.throws(() => githubTasks(dir).claim('42'), /already claimed by other/)
        assert.equal(callsMatching(log, /--add-assignee/).length, 0)
      }
    )
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42, labels: ['bro:claimed'] })),
      },
      (log, dir) => {
        assert.throws(() => githubTasks(dir).claim('42'), /already claimed/)
        assert.equal(callsMatching(log, /--add-assignee/).length, 0)
      }
    )
  })

  test('close lands the reason as a comment', () => {
    withFakeGh({ FAKE_GH_ACTOR: 'me' }, (log, dir) => {
      githubTasks(dir).close('#42', 'landed via PR 7')
      assert.match(calls(log).join('\n'), /issue close 42 --comment landed via PR 7/)
    })
  })

  test('reopen on an already-open issue skips the verb but drops the claim', () => {
    // gh issue reopen errors on OPEN issues — a claimed issue being
    // un-claimed is already open; only the markers need releasing
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(node({ number: 42, assignees: ['me'], labels: ['bro:claimed'] })) },
      (log, dir) => {
        githubTasks(dir).reopen('42')
        const lines = calls(log)
        assert.equal(lines.filter((l) => /issue reopen/.test(l)).length, 0)
        assert.match(lines.join('\n'), /--remove-assignee me/)
        assert.match(lines.join('\n'), /--remove-label bro:claimed/)
      }
    )
  })

  test('reopen on a closed issue runs the verb', () => {
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(node({ number: 42, state: 'CLOSED' })) },
      (log, dir) => {
        githubTasks(dir).reopen('42')
        assert.match(calls(log).join('\n'), /issue reopen 42/)
      }
    )
  })

  test('GHES schema drift retries without relation fields — absent, not faked', () => {
    // every graphql call fails on rel fields the first time; the fake
    // keys drift off FAKE_GH_DRIFT per-call via the log
    const driftOnce = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$1" in
  repo) echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  api)
    case "$*" in
      *blockedBy*|*subIssues*|*issueType*)
        echo 'gh: Cannot query field "blockedBy" on type "Issue".' >&2
        exit 1 ;;
      *graphql*) echo "$FAKE_GH_ISSUES" ;;
      *) echo '{}' ;;
    esac ;;
  *) : ;;
esac
`
    const dir = mkdtempSync(join(tmpdir(), 'bro-gh-tasks-'))
    const log = join(dir, 'gh.log')
    writeFileSync(log, '')
    writeFileSync(join(dir, 'gh'), driftOnce)
    chmodSync(join(dir, 'gh'), 0o755)
    const prevPath = process.env.PATH
    process.env.PATH = `${dir}:${prevPath}`
    const prevIssues = process.env.FAKE_GH_ISSUES
    const prevLog = process.env.FAKE_GH_LOG
    process.env.FAKE_GH_LOG = log
    // a 'blockedBy' node field CANNOT be in the fallback response — GHES
    // lacks the field entirely, so the same payload without it is what
    // the server would answer
    process.env.FAKE_GH_ISSUES = issuesPage([node({ number: 1, title: 'ghes issue' })])
    try {
      const rows = githubTasks(dir).list()
      assert.deepEqual(rows.map((r) => r.id), ['1'])
      // two graphql calls: the drifted rel query, then the core retry.
      // The query arg carries newlines — slice on call boundaries, not lines
      const entries = readFileSync(log, 'utf8')
        .split(/(?=api graphql -f query=)/)
        .filter((s) => s.startsWith('api graphql'))
      assert.equal(entries.length, 2)
      assert.match(entries[0]!, /blockedBy/)
      assert.doesNotMatch(entries[1]!, /blockedBy/)
    } finally {
      process.env.PATH = prevPath
      if (prevIssues === undefined) delete process.env.FAKE_GH_ISSUES
      else process.env.FAKE_GH_ISSUES = prevIssues
      if (prevLog === undefined) delete process.env.FAKE_GH_LOG
      else process.env.FAKE_GH_LOG = prevLog
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('create passes labels and writes a bro metadata trailer', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42, labels: ['bug'] })),
      },
      (log, dir) => {
        const row = githubTasks(dir).create({
          title: 'new task',
          type: 'bug',
          priority: 1,
          labels: ['bug'],
        })
        assert.equal(row.id, '42')
        assert.match(calls(log).join('\n'), /issue create --title new task --body .*bro:.*"type":"bug".*"priority":1.*--label bug/)
      }
    )
  })

  test('unsupported link type throws — never faked as a comment', () => {
    withFakeGh({ FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      assert.throws(
        () => githubTasks(dir).link('1', '2', 'discovered-from'),
        /no GitHub analogue/
      )
    })
  })

  test('link blocks maps to the dependencies endpoint with the databaseId', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 2, databaseId: 777 })),
      },
      (log, dir) => {
        githubTasks(dir).link('1', '2', 'blocks')
        assert.match(
          calls(log).join('\n'),
          /api -X POST repos\/\{owner\}\/\{repo\}\/issues\/1\/dependencies\/blocked_by -f issue_id=777/
        )
      }
    )
  })

  test('deps direction — blockedBy reads down, blocking reads up', () => {
    const n = node({ number: 9, blockedBy: [[8, 'OPEN']], blocking: [[10, 'OPEN']] })
    withFakeGh({ FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(n) }, (_log, dir) => {
      assert.deepEqual(githubTasks(dir).deps(['9'], { direction: 'down' }), [
        { issue_id: '9', depends_on_id: '8', type: 'blocked' },
      ])
    })
    withFakeGh({ FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(n) }, (_log, dir) => {
      assert.deepEqual(githubTasks(dir).deps(['9'], { direction: 'up' }), [
        { issue_id: '10', depends_on_id: '9', type: 'blocked' },
      ])
    })
  })

  test('neighbors on a non-canonical id returns the dep, never the issue itself', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 9, blockedBy: [[8, 'OPEN']] })),
        FAKE_GH_ISSUE_2: issueRead(node({ number: 8 })),
      },
      (_log, dir) => {
        // '#9' resolves to issue 9 — edges carry String(n.number), so a
        // raw-id comparison would return the queried row as a neighbor
        assert.deepEqual(
          githubTasks(dir).neighbors('#9').map((r) => r.id),
          ['8']
        )
      }
    )
  })

  test('sub-issue parent does not reach row.parent — it is not an orchestrated step', () => {
    // classify() gates `row.parent` rows as molecule steps; a github
    // sub-issue is plain decomposed work — its relationship surfaces
    // through deps()/children(), never the molecule gate
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 5, parent: 3 })),
        FAKE_GH_ISSUE_2: issueRead(node({ number: 5, parent: 3 })),
      },
      (_log, dir) => {
        const row = githubTasks(dir).get('5')
        assert.equal(row?.parent, undefined)
        assert.deepEqual(githubTasks(dir).deps(['5'], { rel: 'parent' }), [
          { issue_id: '5', depends_on_id: '3', type: 'parent' },
        ])
      }
    )
  })

  test('prefix() is undefined — the repo itself is the scope', () => {
    withFakeGh({ FAKE_GH_ACTOR: 'me' }, (_log, dir) => {
      assert.equal(githubTasks(dir).prefix(), undefined)
    })
  })

  test('publish dedups on an own-repo issue external_ref — no second create', () => {
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(node({ number: 42, title: 'the bead' })) },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          {
            id: 'bro-t1',
            title: 'the bead',
            external_ref: 'https://github.com/acme/widgets/issues/42',
          },
          {}
        )
        assert.equal(res?.item.id, '42')
        assert.equal(callsMatching(log, /issue create/).length, 0)
      }
    )
  })

  test('publish declines a foreign external_ref — another system owns that map', () => {
    withFakeGh({ FAKE_GH_ACTOR: 'me' }, (log, dir) => {
      for (const external_ref of [
        'jira:ACME-7',
        'https://github.com/other/repo/issues/7',
        'https://ghe.corp/acme/widgets/issues/7',
        'debt://thread-9',
      ]) {
        assert.equal(
          githubTasks(dir).publish!({ id: 'bro-t1', title: 'x', external_ref }, {}),
          undefined,
          external_ref
        )
      }
      assert.equal(callsMatching(log, /issue create/).length, 0)
    })
  })

  test('publish creates a bro:bead issue carrying the bead provenance', () => {
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(node({ number: 42, labels: ['bro:bead'] })) },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          {
            id: 'bro-t9',
            title: 'mirror me',
            issue_type: 'feature',
            labels: ['area:cli'],
            description: 'the work',
          },
          {}
        )
        assert.equal(res?.item.id, '42')
        // the --body arg carries newlines — the create entry spans
        // physical lines, so match the raw log, not per-line hits
        const created = readFileSync(log, 'utf8')
        assert.match(created, /--label bro:bead --label area:cli/)
        assert.match(created, /"bead":"bro-t9"/)
        assert.match(created, /"type":"feature"/)
      }
    )
  })

  test('publish with an epic parent materializes a milestone and joins it', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_MILESTONE_MADE:
          '{"number":3,"title":"the epic","html_url":"https://github.com/acme/widgets/milestone/3"}',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
      },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          { id: 'bro-c1', title: 'child', issue_type: 'feature' },
          { epic: { id: 'bro-e1', title: 'the epic', issue_type: 'epic' } }
        )
        assert.equal(res?.epicRef, 'https://github.com/acme/widgets/milestone/3')
        const lines = calls(log).join('\n')
        assert.match(lines, /api --paginate repos\/acme\/widgets\/milestones\?state=all/)
        assert.match(lines, /api -X POST repos\/acme\/widgets\/milestones -f title=the epic/)
        assert.match(lines, /api -X PATCH repos\/\{owner\}\/\{repo\}\/issues\/42 -F milestone=3/)
      }
    )
  })

  test('a same-title milestone is reused — dedup survives a lost external_ref map', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_MILESTONES:
          '[{"number":5,"title":"the epic","html_url":"https://github.com/acme/widgets/milestone/5"}]',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
      },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          { id: 'bro-c1', title: 'child', issue_type: 'feature' },
          { epic: { id: 'bro-e1', title: 'the epic', issue_type: 'epic' } }
        )
        assert.equal(res?.epicRef, 'https://github.com/acme/widgets/milestone/5')
        assert.equal(callsMatching(log, /POST repos\/acme\/widgets\/milestones/).length, 0)
        assert.match(calls(log).join('\n'), /-F milestone=5/)
      }
    )
  })

  test('an epic already carrying a milestone ref joins it — no list or create', () => {
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })) },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          { id: 'bro-c1', title: 'child', issue_type: 'feature' },
          {
            epic: {
              id: 'bro-e1',
              title: 'the epic',
              issue_type: 'epic',
              external_ref: 'https://github.com/acme/widgets/milestone/7',
            },
          }
        )
        assert.equal(res?.epicRef, undefined)
        const lines = calls(log).join('\n')
        assert.doesNotMatch(lines, /milestones\?state=all/)
        assert.doesNotMatch(lines, /POST repos\/acme\/widgets\/milestones/)
        assert.match(lines, /-F milestone=7/)
      }
    )
  })

  test('a foreign epic ref joins no container — the issue still projects', () => {
    const read42 = issueRead(node({ number: 42 }))
    withFakeGh(
      { FAKE_GH_ACTOR: 'me', FAKE_GH_ISSUE_1: read42, FAKE_GH_ISSUE_2: read42 },
      (log, dir) => {
        for (const external_ref of [
          'jira:EPIC-1',
          'https://github.com/other/repo/milestone/7',
          'https://ghe.corp/acme/widgets/milestone/7',
        ]) {
          const res = githubTasks(dir).publish!(
            { id: 'bro-c1', title: 'child', issue_type: 'feature' },
            { epic: { id: 'bro-e1', title: 'the epic', issue_type: 'epic', external_ref } }
          )
          assert.equal(res?.item.id, '42', external_ref)
          assert.equal(res?.epicRef, undefined, external_ref)
        }
        const lines = calls(log).join('\n')
        assert.doesNotMatch(lines, /milestone/)
      }
    )
  })

  test('a failed milestone join does not lose the created issue', () => {
    withFakeGh(
      {
        FAKE_GH_ACTOR: 'me',
        FAKE_GH_ISSUE_1: issueRead(node({ number: 42 })),
        FAKE_GH_PATCH_FAIL: '1',
      },
      (log, dir) => {
        const res = githubTasks(dir).publish!(
          { id: 'bro-c1', title: 'child', issue_type: 'feature' },
          {
            epic: {
              id: 'bro-e1',
              title: 'the epic',
              issue_type: 'epic',
              external_ref: 'https://github.com/acme/widgets/milestone/7',
            },
          }
        )
        // the created issue still returns — the epic join is best-effort,
        // so publishSync's external_ref write-back survives a PATCH miss
        assert.equal(res?.item.id, '42')
      }
    )
  })
})

describe('github tasks connector selection', { skip: WIN32 }, () => {
  const repoWithRemote = (url: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-gh-conn-'))
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
    return dir
  }

  test('tasks stays beads on a github remote — opt-in is name-only', () => {
    registerConnector(githubConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      // remote match would claim reviews; tasks must NOT follow it
      assert.equal(facadeName('reviews', { dir }), 'github')
      assert.equal(facadeName('tasks', { dir }), 'beads')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('connectors.tasks=github resolves the github TaskStore', () => {
    registerConnector(githubConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      const name = facadeName('tasks', { dir }, { prefer: { tasks: 'github' } })
      assert.equal(name, 'github')
      const store = facade('tasks', { dir }, { prefer: { tasks: 'github' } })
      assert.equal(typeof store.ready, 'function')
      assert.equal(typeof store.claim, 'function')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('connectors.tasks=github resolves on a non-github remote too', () => {
    registerConnector(githubConnector)
    // an explicit pin is an operator choice — the remote only drives
    // auto-match, never the pin
    const dir = repoWithRemote('git@gitlab.com:acme/widgets.git')
    try {
      assert.equal(facadeName('tasks', { dir }, { prefer: { tasks: 'github' } }), 'github')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tasksAsync honors the same opt-in', () => {
    registerConnector(githubConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      assert.equal(facadeName('tasksAsync', { dir }), 'beads')
      assert.equal(facadeName('tasksAsync', { dir }, { prefer: { tasksAsync: 'github' } }), 'github')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

