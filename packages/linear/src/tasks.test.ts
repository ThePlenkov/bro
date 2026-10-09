import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { facade, facadeName, registerConnector } from '@broject/core'
import { linearConnector, linearTasks, linearTasksAsync } from './index.ts'
import { linearQueries } from './queries.ts'

const WIN32 = process.platform === 'win32'

/** Scripted curl on PATH — the sync transport's test seam. Reads the
 *  JSON body off stdin (`--data-binary @-`), appends it to
 *  $FAKE_CURL_LOG, answers by operation name. Payloads are env-driven:
 *    FAKE_LINEAR_VIEWER    — BroViewer body (default: a 'me' viewer)
 *    FAKE_LINEAR_TEAMS     — BroTeams body (default: single ENG team)
 *    FAKE_LINEAR_TEAM_META — BroTeamMeta body (states + labels)
 *    FAKE_LINEAR_ISSUES    — BroIssues page body
 *    FAKE_LINEAR_ISSUE_1   — the FIRST BroIssue read (claim's pre-read)
 *    FAKE_LINEAR_ISSUE_2   — scripted override for every LATER BroIssue
 *                            read (claim's verify); falls back to _1 —
 *                            an issue doesn't vanish after one read
 *    FAKE_LINEAR_CHILDREN  — BroChildren body
 *    FAKE_LINEAR_CREATE    — BroIssueCreate body
 *    FAKE_LINEAR_USERS     — BroUsers body
 *    FAKE_CURL_EXIT        — nonzero exit for transport-failure tests */
const FAKE_CURL = `#!/bin/sh
# -r: the JSON payload's \\n and \\" escapes are DATA — plain read eats
# the backslash and the logged body stops being the bytes that were sent
IFS= read -r body
printf '%s\\n' "$body" >> "$FAKE_CURL_LOG"
case "$body" in
  *BroIssues*) printf '%s\\n' "$FAKE_LINEAR_ISSUES" ;;
  *BroChildren*) printf '%s\\n' "$FAKE_LINEAR_CHILDREN" ;;
  *BroTeamMeta*) printf '%s\\n' "$FAKE_LINEAR_TEAM_META" ;;
  *BroTeams*) printf '%s\\n' "$FAKE_LINEAR_TEAMS" ;;
  *BroViewer*) printf '%s\\n' "$FAKE_LINEAR_VIEWER" ;;
  *BroUsers*) printf '%s\\n' "$FAKE_LINEAR_USERS" ;;
  *BroIssueCreate*) printf '%s\\n' "$FAKE_LINEAR_CREATE" ;;
  *BroLabelCreate*) echo '{"data":{"issueLabelCreate":{"issueLabel":{"id":"lbl-new","name":"new-label"}}}}' ;;
  *BroRelationCreate*) echo '{"data":{"issueRelationCreate":{"success":true}}}' ;;
  *BroCommentCreate*) echo '{"data":{"commentCreate":{"success":true}}}' ;;
  *BroIssueUpdate*) echo '{"data":{"issueUpdate":{"success":true}}}' ;;
  *BroIssueDelete*) echo '{"data":{"issueDelete":{"success":true}}}' ;;
  # 'BroIssue(' is paren-anchored — BroIssues/BroIssueCreate never
  # collide with the single-issue read's read-count switch
  *"BroIssue("*)
    n=$(grep -c 'BroIssue(' "$FAKE_CURL_LOG")
    if [ "$n" -gt 1 ] && [ -n "$FAKE_LINEAR_ISSUE_2" ]; then
      printf '%s\\n' "$FAKE_LINEAR_ISSUE_2"
    else
      printf '%s\\n' "$FAKE_LINEAR_ISSUE_1"
    fi ;;
  *) echo '{}' ;;
esac
if [ -n "$FAKE_CURL_EXIT" ]; then exit "$FAKE_CURL_EXIT"; fi
`

const TEAM = { id: 'team-uuid-1', key: 'ENG', name: 'Engineering' }
const TEAM_META = {
  data: {
    team: {
      id: TEAM.id,
      key: TEAM.key,
      states: {
        nodes: [
          { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0 },
          { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
          { id: 'st-doing', name: 'In Progress', type: 'started', position: 2 },
          { id: 'st-done', name: 'Done', type: 'completed', position: 3 },
          { id: 'st-canceled', name: 'Canceled', type: 'canceled', position: 4 },
        ],
      },
      labels: { nodes: [{ id: 'lbl-bug', name: 'bug' }] },
    },
  },
}

interface NodeOpts {
  ident: string
  title?: string
  state?: string // workflow state TYPE — backlog|unstarted|started|completed|canceled|triage
  assignee?: string
  labels?: string[]
  blockedBy?: [string, string][] // [identifier, stateType]
  blocks?: [string, string][]
  children?: [string, string][]
  parent?: string
  priority?: number | null
  description?: string
  url?: string
  createdAt?: string
  completedAt?: string
  canceledAt?: string
  archivedAt?: string
}

const st = (type: string) => ({ id: `st-${type}`, name: type, type, position: 0 })
const relRef = ([ident, type]: [string, string]) => ({ identifier: ident, state: { type } })

/** An issue node in the shape tasks.ts queries for. */
function node(o: NodeOpts): Record<string, unknown> {
  return {
    id: `uuid-${o.ident}`,
    identifier: o.ident,
    title: o.title ?? `issue ${o.ident}`,
    description: o.description ?? '',
    url: o.url ?? `https://linear.app/acme/issue/${o.ident}`,
    priority: o.priority ?? null,
    state: st(o.state ?? 'unstarted'),
    assignee:
      o.assignee !== undefined
        ? { id: `u-${o.assignee}`, displayName: o.assignee, email: `${o.assignee}@x` }
        : null,
    labels: { nodes: (o.labels ?? []).map((name, i) => ({ id: `lbl-${name}`, name })) },
    parent: o.parent !== undefined ? { id: `uuid-${o.parent}`, identifier: o.parent } : null,
    team: { id: TEAM.id, key: TEAM.key },
    children: { nodes: (o.children ?? []).map(relRef) },
    relations: {
      nodes: (o.blocks ?? []).map((r) => ({ type: 'blocks', relatedIssue: relRef(r) })),
    },
    inverseRelations: {
      nodes: (o.blockedBy ?? []).map((r) => ({ type: 'blocks', issue: relRef(r) })),
    },
    createdAt: o.createdAt ?? `2026-01-${o.ident.replace(/\D/g, '').padStart(2, '0')}T00:00:00Z`,
    completedAt: o.completedAt ?? null,
    canceledAt: o.canceledAt ?? null,
    archivedAt: o.archivedAt ?? null,
  }
}

const issuesPage = (nodes: Record<string, unknown>[]): string =>
  JSON.stringify({
    data: { team: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
  })

const issueRead = (n: Record<string, unknown> | null): string =>
  JSON.stringify({ data: { issue: n } })

// Every withLinear call gets its OWN api key: api.ts's credential-keyed
// caches (viewer/team/users) would otherwise hand a stale team pick to
// a later test — a test that swaps LINEAR_TEAM must re-run the probe
let keySeq = 0

const ENV_DEFAULTS: Record<string, string> = {
  // unset ambient LINEAR_TEAM leaks into auto-detect — pin it empty so
  // every test controls its own team set
  LINEAR_TEAM: '',
  FAKE_LINEAR_VIEWER: JSON.stringify({
    data: { viewer: { id: 'u-me', displayName: 'me', email: 'me@x' } },
  }),
  FAKE_LINEAR_TEAMS: JSON.stringify({ data: { teams: { nodes: [TEAM] } } }),
  FAKE_LINEAR_TEAM_META: JSON.stringify(TEAM_META),
}

/** Env swap + a fake curl on PATH; the log records every request body. */
function withLinear(
  env: Record<string, string>,
  fn: (log: string, dir: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-linear-'))
  const log = join(dir, 'curl.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'curl'), FAKE_CURL)
  chmodSync(join(dir, 'curl'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const all = { LINEAR_API_KEY: `lin_api_test_${++keySeq}`, ...ENV_DEFAULTS, ...env }
  const prevEnv = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_CURL_LOG: log, ...all })
  try {
    fn(log, dir)
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete process.env.FAKE_CURL_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Request bodies — one per curl spawn; the operation name is the seam. */
const calls = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n')
const callsMatching = (log: string, re: RegExp): string[] => calls(log).filter((l) => re.test(l))

describe('linearTasks', { skip: WIN32 }, () => {
  test('list maps workflow state, labels, assignee onto task status', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUES: issuesPage([
          node({ ident: 'ENG-1', title: 'plain open' }),
          node({ ident: 'ENG-2', title: 'claimed', assignee: 'me' }),
          node({ ident: 'ENG-3', title: 'blocked', blockedBy: [['ENG-9', 'started']] }),
          node({ ident: 'ENG-4', title: 'done', state: 'completed', completedAt: '2026-01-05T00:00:00Z' }),
          node({ ident: 'ENG-5', title: 'triaged', state: 'triage' }),
          node({ ident: 'ENG-6', title: 'started', state: 'started' }),
        ]),
      },
      (_log, dir) => {
        const rows = linearTasks(dir).list({ all: true })
        const status = new Map(rows.map((r) => [r.id, r.status]))
        assert.deepEqual(Object.fromEntries(status), {
          'ENG-1': 'open',
          'ENG-2': 'in_progress',
          'ENG-3': 'blocked',
          'ENG-4': 'closed',
          'ENG-5': 'blocked', // triage is unapproved work — never claimable
          'ENG-6': 'in_progress',
        })
        // the transport carrier never leaves the store
        assert.equal(rows.some((r) => '__node' in r), false)
      }
    )
  })

  test('ready excludes blocked/claimed/triage, orders mapped priority then created', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUES: issuesPage([
          node({ ident: 'ENG-1', title: 'blocked dep', blockedBy: [['ENG-9', 'started']], priority: 2 }),
          node({ ident: 'ENG-2', title: 'claimed', assignee: 'me', priority: 2 }),
          node({ ident: 'ENG-3', title: 'later, urgent', priority: 1, createdAt: '2026-01-02T00:00:00Z' }),
          node({ ident: 'ENG-4', title: 'earlier, medium', priority: 3, createdAt: '2026-01-01T00:00:00Z' }),
          node({ ident: 'ENG-5', title: 'unblocked — dep landed', blockedBy: [['ENG-9', 'completed']], priority: 3, createdAt: '2026-01-03T00:00:00Z' }),
          node({ ident: 'ENG-6', title: 'open sub-issues make it not-ready', children: [['ENG-7', 'started']], priority: 1 }),
          node({ ident: 'ENG-8', title: 'manual blocked label', labels: ['blocked'], priority: 1 }),
          node({ ident: 'ENG-9', title: 'triaged', state: 'triage', priority: 1 }),
        ]),
      },
      (_log, dir) => {
        const ready = linearTasks(dir).ready()
        // urgent ENG-3 (bd p0) first; then mediums in created order
        assert.deepEqual(ready.map((r) => r.id), ['ENG-3', 'ENG-4', 'ENG-5'])
      }
    )
  })

  test('native priority name-maps onto bd 0-4 — urgent first', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUES: issuesPage([
          node({ ident: 'ENG-1', priority: 1 }), // urgent  → bd 0
          node({ ident: 'ENG-2', priority: 4 }), // low     → bd 3
          node({ ident: 'ENG-3', priority: 0 }), // none    → bd 4
          node({ ident: 'ENG-4', priority: null }), // unset → default 2
        ]),
      },
      (_log, dir) => {
        const pri = new Map(linearTasks(dir).list().map((r) => [r.id, r.priority]))
        assert.deepEqual(Object.fromEntries(pri), {
          'ENG-1': 0,
          'ENG-2': 3,
          'ENG-3': 4,
          'ENG-4': 2,
        })
      }
    )
  })

  test('id forms: bare number resolves in the team, URL and UUID pass through', () => {
    withLinear({ FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42' })) }, (log, dir) => {
      const s = linearTasks(dir)
      assert.equal(s.get('42')?.id, 'ENG-42') // bare number borrows the team key
      assert.match(callsMatching(log, /BroIssue/)[0]!, /"id":"ENG-42"/)
      s.get('https://linear.app/acme/issue/ENG-7-some-slug')
      assert.match(callsMatching(log, /BroIssue/)[1]!, /"id":"ENG-7"/)
      s.get('eng-9') // lowercase identifiers normalize
      assert.match(callsMatching(log, /BroIssue/)[2]!, /"id":"ENG-9"/)
      const uuid = '123e4567-e89b-42d3-a456-426614174000'
      s.get(uuid)
      assert.match(callsMatching(log, /BroIssue/)[3]!, new RegExp(`"id":"${uuid}"`))
      assert.throws(() => s.get('garbage'), /not an issue reference/)
    })
  })

  test('claim assigns the viewer and verifies the re-read', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42' })),
        FAKE_LINEAR_ISSUE_2: issueRead(node({ ident: 'ENG-42', assignee: 'me' })),
      },
      (log, dir) => {
        linearTasks(dir).claim('ENG-42')
        const updates = callsMatching(log, /BroIssueUpdate/)
        assert.equal(updates.length, 1)
        assert.match(updates[0]!, /"assigneeId":"u-me"/)
      }
    )
  })

  test('claim race: the verify read shows a rival — contested, thrown', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42' })),
        FAKE_LINEAR_ISSUE_2: issueRead(node({ ident: 'ENG-42', assignee: 'rival' })),
      },
      (_log, dir) => {
        assert.throws(() => linearTasks(dir).claim('ENG-42'), /claim contested — rival holds it/)
      }
    )
  })

  test('claim refuses an already-assigned or closed issue before writing', () => {
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42', assignee: 'other' })) },
      (log, dir) => {
        assert.throws(() => linearTasks(dir).claim('ENG-42'), /already claimed by other/)
        assert.equal(callsMatching(log, /BroIssueUpdate/).length, 0)
      }
    )
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42', state: 'completed' })) },
      (log, dir) => {
        assert.throws(() => linearTasks(dir).claim('ENG-42'), /only open issues are claimable/)
        assert.equal(callsMatching(log, /BroIssueUpdate/).length, 0)
      }
    )
  })

  test('a started-but-unassigned issue is claimable — assignee is the claim', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42', state: 'started' })),
        FAKE_LINEAR_ISSUE_2: issueRead(node({ ident: 'ENG-42', state: 'started', assignee: 'me' })),
      },
      (log, dir) => {
        linearTasks(dir).claim('ENG-42')
        assert.equal(callsMatching(log, /BroIssueUpdate/).length, 1)
      }
    )
  })

  test('reopen on a completed issue picks the first unstarted state and unassigns', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUE_1: issueRead(
          node({ ident: 'ENG-42', state: 'completed', assignee: 'me' })
        ),
      },
      (log, dir) => {
        linearTasks(dir).reopen('ENG-42')
        const updates = callsMatching(log, /BroIssueUpdate/)
        assert.match(updates.join('\n'), /"stateId":"st-todo"/)
        assert.match(updates.join('\n'), /"assigneeId":null/)
      }
    )
  })

  test('close lands the reason as a comment, then moves to completed', () => {
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42' })) },
      (log, dir) => {
        linearTasks(dir).close('ENG-42', 'landed via PR 7')
        const lines = calls(log)
        const commentIdx = lines.findIndex((l) => /BroCommentCreate/.test(l))
        const updateIdx = lines.findIndex((l) => /BroIssueUpdate/.test(l))
        assert.ok(commentIdx >= 0 && updateIdx > commentIdx, lines.join('\n'))
        assert.match(lines[commentIdx]!, /landed via PR 7/)
        assert.match(lines[updateIdx]!, /"stateId":"st-done"/)
      }
    )
  })

  test('close on an already-closed issue comments but skips the state write', () => {
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-42', state: 'completed' })) },
      (log, dir) => {
        linearTasks(dir).close('ENG-42', 'already done')
        assert.equal(callsMatching(log, /BroIssueUpdate/).length, 0)
        assert.equal(callsMatching(log, /BroCommentCreate/).length, 1)
      }
    )
  })

  test('create posts teamId/title/priority/labelIds and writes the bro trailer', () => {
    withLinear(
      { FAKE_LINEAR_CREATE: JSON.stringify({ data: { issueCreate: { success: true, issue: node({ ident: 'ENG-99', labels: ['bug'], priority: 2 }) } } }) },
      (log, dir) => {
        const row = linearTasks(dir).create({
          title: 'new task',
          type: 'bug',
          priority: 1,
          labels: ['bug'],
        })
        assert.equal(row.id, 'ENG-99')
        const body = callsMatching(log, /BroIssueCreate/)[0]!
        assert.match(body, /"teamId":"team-uuid-1"/)
        assert.match(body, /"priority":2/) // bd p1 → Linear high(2)
        assert.match(body, /"labelIds":\["lbl-bug"\]/)
        assert.match(body, /bro:.*\\"type\\":\\"bug\\"/)
      }
    )
  })

  test('create resolves a new label through issueLabelCreate', () => {
    withLinear(
      {
        FAKE_LINEAR_CREATE: JSON.stringify({
          data: { issueCreate: { success: true, issue: node({ ident: 'ENG-99' }) } },
        }),
      },
      (log, dir) => {
        linearTasks(dir).create({ title: 't', labels: ['not-in-cache'] })
        assert.match(callsMatching(log, /BroLabelCreate/)[0]!, /"name":"not-in-cache"/)
        assert.match(callsMatching(log, /BroIssueCreate/)[0]!, /"labelIds":\["lbl-new"\]/)
      }
    )
  })

  test('create rejects an unsupported dep type before creating', () => {
    withLinear({}, (log, dir) => {
      assert.throws(
        () => linearTasks(dir).create({ title: 't', deps: ['discovered-from:ENG-1'] }),
        /dep type 'discovered-from' unsupported/
      )
      assert.equal(callsMatching(log, /BroIssueCreate/).length, 0)
    })
  })

  test('link blocks maps to issueRelationCreate — bd direction inverted onto Linear', () => {
    // link('ENG-1','ENG-2','blocks') = "ENG-1 blocked by ENG-2" →
    // Linear: issue=ENG-2 (blocker) type=blocks relatedIssue=ENG-1
    withLinear({}, (log, dir) => {
      linearTasks(dir).link('ENG-1', 'ENG-2', 'blocks')
      const body = callsMatching(log, /BroRelationCreate/)[0]!
      assert.match(body, /"issueId":"ENG-2"/)
      assert.match(body, /"relatedIssueId":"ENG-1"/)
      assert.match(body, /"type":"blocks"/)
    })
  })

  test('link parent-child resolves the parent and sets parentId', () => {
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-3' })) },
      (log, dir) => {
        linearTasks(dir).link('ENG-5', 'ENG-3', 'parent-child')
        const body = callsMatching(log, /BroIssueUpdate/)[0]!
        assert.match(body, /"id":"ENG-5"/)
        assert.match(body, /"parentId":"uuid-ENG-3"/)
      }
    )
  })

  test('unsupported link type throws — never faked as a comment', () => {
    withLinear({}, (_log, dir) => {
      assert.throws(() => linearTasks(dir).link('ENG-1', 'ENG-2', 'relates'), /no Linear analogue/)
    })
  })

  test('deps maps inverseRelations upward and relations downward', () => {
    withLinear(
      {
        FAKE_LINEAR_ISSUE_1: issueRead(
          node({ ident: 'ENG-9', blockedBy: [['ENG-8', 'started']], blocks: [['ENG-10', 'unstarted']] })
        ),
      },
      (_log, dir) => {
        assert.deepEqual(linearTasks(dir).deps(['ENG-9']), [
          { issue_id: 'ENG-9', depends_on_id: 'ENG-8', type: 'blocks' },
          { issue_id: 'ENG-10', depends_on_id: 'ENG-9', type: 'blocks' },
        ])
      }
    )
  })

  test('sub-issue parent does not reach row.parent — deps carries it instead', () => {
    // row.parent means an orchestrated molecule step; a Linear
    // sub-issue is plain decomposed work — its parent surfaces via
    // deps('parent-child'), never the molecule gate
    withLinear(
      { FAKE_LINEAR_ISSUE_1: issueRead(node({ ident: 'ENG-5', parent: 'ENG-3' })) },
      (_log, dir) => {
        const row = linearTasks(dir).get('ENG-5')
        assert.equal(row?.parent, undefined)
        assert.deepEqual(linearTasks(dir).deps(['ENG-5'], { type: 'parent-child' }), [
          { issue_id: 'ENG-5', depends_on_id: 'ENG-3', type: 'parent-child' },
        ])
      }
    )
  })

  test('children returns sub-issues as rows', () => {
    withLinear(
      {
        FAKE_LINEAR_CHILDREN: JSON.stringify({
          data: { issue: { children: { nodes: [node({ ident: 'ENG-6' }), node({ ident: 'ENG-7', state: 'completed' })] } } },
        }),
      },
      (_log, dir) => {
        const rows = linearTasks(dir).children('ENG-5')
        assert.deepEqual(
          rows.map((r) => [r.id, r.status]),
          [['ENG-6', 'open'], ['ENG-7', 'closed']]
        )
      }
    )
  })

  test('prefix() is the team key — bare ids are team-scoped', () => {
    withLinear({}, (_log, dir) => {
      assert.equal(linearTasks(dir).prefix(), 'ENG')
    })
  })

  test('multi-team workspace without LINEAR_TEAM throws with the list', () => {
    withLinear(
      {
        FAKE_LINEAR_TEAMS: JSON.stringify({
          data: { teams: { nodes: [TEAM, { id: 'team-uuid-2', key: 'WDG' }] } },
        }),
      },
      (_log, dir) => {
        assert.throws(() => linearTasks(dir).list(), /LINEAR_TEAM required.*ENG, WDG/)
      }
    )
  })

  test('LINEAR_TEAM picks the named team case-insensitively', () => {
    withLinear(
      {
        LINEAR_TEAM: 'wdg',
        FAKE_LINEAR_TEAMS: JSON.stringify({
          data: { teams: { nodes: [TEAM, { id: 'team-uuid-2', key: 'WDG' }] } },
        }),
        FAKE_LINEAR_ISSUES: issuesPage([node({ ident: 'WDG-1' })]),
      },
      (log, dir) => {
        const rows = linearTasks(dir).list()
        assert.deepEqual(rows.map((r) => r.id), ['WDG-1'])
        assert.match(callsMatching(log, /BroIssues/)[0]!, /"team":"team-uuid-2"/)
      }
    )
  })

  test('missing LINEAR_API_KEY throws the remediation, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-linear-'))
    const prev = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
    try {
      assert.throws(() => linearTasks(dir).list(), /LINEAR_API_KEY not set/)
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('curl transport failure names the problem', () => {
    withLinear({ FAKE_CURL_EXIT: '22' }, (_log, dir) => {
      assert.throws(() => linearTasks(dir).list(), /linear: request failed/)
    })
  })

  test('pagination follows pageInfo.endCursor', () => {
    const cursorScript = `#!/bin/sh
read body
echo "$body" >> "$FAKE_CURL_LOG"
case "$body" in
  *BroTeams*) echo "$FAKE_LINEAR_TEAMS" ;;
  *BroIssues*)
    case "$body" in
      *'"cursor":null'*) echo "$FAKE_LINEAR_ISSUES" ;;
      *) echo "$FAKE_LINEAR_ISSUES_2" ;;
    esac ;;
  *) echo '{}' ;;
esac
`
    const dir = mkdtempSync(join(tmpdir(), 'bro-linear-'))
    const log = join(dir, 'curl.log')
    writeFileSync(log, '')
    writeFileSync(join(dir, 'curl'), cursorScript)
    chmodSync(join(dir, 'curl'), 0o755)
    const prevPath = process.env.PATH
    process.env.PATH = `${dir}:${prevPath}`
    const all: Record<string, string> = {
      LINEAR_API_KEY: `lin_api_test_${++keySeq}`,
      ...ENV_DEFAULTS,
      FAKE_LINEAR_ISSUES: JSON.stringify({
        data: {
          team: {
            issues: {
              nodes: [node({ ident: 'ENG-1' })],
              pageInfo: { hasNextPage: true, endCursor: 'cur2' },
            },
          },
        },
      }),
      FAKE_LINEAR_ISSUES_2: issuesPage([node({ ident: 'ENG-2' })]),
    }
    const prevEnv = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]))
    Object.assign(process.env, { FAKE_CURL_LOG: log, ...all })
    try {
      assert.deepEqual(
        linearTasks(dir).list().map((r) => r.id),
        ['ENG-1', 'ENG-2']
      )
      assert.match(callsMatching(log, /BroIssues/)[1]!, /"cursor":"cur2"/)
    } finally {
      process.env.PATH = prevPath
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      delete process.env.FAKE_CURL_LOG
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- async surface: injected fetch ----------------------------------------------

interface FetchCall {
  url: string
  init: RequestInit
}

/** Fetch stub dispatching on the operation name inside the JSON body —
 *  the same seam the fake curl uses, one transport up. */
function fakeFetch(
  bodies: Record<string, unknown>
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    const body = String(init?.body ?? '')
    const op = /(?:query|mutation) (\w+)/.exec(body)?.[1] ?? ''
    const payload = bodies[op] ?? {}
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
  return { fn, calls }
}

describe('linearTasksAsync', () => {
  const asyncDefaults = {
    BroTeams: { data: { teams: { nodes: [TEAM] } } },
    BroViewer: { data: { viewer: { id: 'u-me', displayName: 'me' } } },
  }

  test('list + ready map the same rows over fetch', async () => {
    const { fn, calls } = fakeFetch({
      ...asyncDefaults,
      BroIssues: {
        data: {
          team: {
            issues: {
              nodes: [
                node({ ident: 'ENG-1' }),
                node({ ident: 'ENG-2', blockedBy: [['ENG-9', 'started']] }),
                node({ ident: 'ENG-3', assignee: 'me' }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_async_test'
    try {
      const store = linearTasksAsync('/tmp', { fetch: fn })
      const rows = await store.list()
      assert.deepEqual(
        rows.map((r) => r.status),
        ['open', 'blocked', 'in_progress']
      )
      assert.deepEqual((await store.ready()).map((r) => r.id), ['ENG-1'])
      // the Authorization header carries the key verbatim — not Bearer
      const auth = (calls[0]!.init.headers as Record<string, string>)['Authorization']
      assert.equal(auth, 'lin_api_async_test')
      assert.equal(calls[0]!.url, 'https://api.linear.app/graphql')
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })

  test('get resolves bare numbers through the team — no sync spawn', async () => {
    const { fn } = fakeFetch({
      ...asyncDefaults,
      BroIssue: { data: { issue: node({ ident: 'ENG-42' }) } },
    })
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_async_test'
    try {
      const row = await linearTasksAsync('/tmp', { fetch: fn }).get('42')
      assert.equal(row?.id, 'ENG-42')
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })

  test('deps maps relations over fetch', async () => {
    const { fn } = fakeFetch({
      ...asyncDefaults,
      BroIssue: {
        data: { issue: node({ ident: 'ENG-9', blockedBy: [['ENG-8', 'started']] }) },
      },
    })
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_async_test'
    try {
      const deps = await linearTasksAsync('/tmp', { fetch: fn }).deps(['ENG-9'])
      assert.deepEqual(deps, [
        { issue_id: 'ENG-9', depends_on_id: 'ENG-8', type: 'blocks' },
      ])
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })
})

// --- queries facade -----------------------------------------------------------------

describe('linearQueries', () => {
  test('posts the document + vars to the fixed endpoint with the key verbatim', async () => {
    const { fn, calls } = fakeFetch({ AnyOp: { data: { viewer: { id: 'u1' } } } })
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_query_test'
    try {
      const res = await linearQueries({ fetch: fn }).graphql('query AnyOp { viewer { id } }', {
        vars: { n: 5 },
      })
      assert.deepEqual(res, { data: { viewer: { id: 'u1' } } })
      const init = calls[0]!.init
      assert.equal(calls[0]!.url, 'https://api.linear.app/graphql')
      const headers = init.headers as Record<string, string>
      assert.equal(headers['Authorization'], 'lin_api_query_test')
      assert.equal(headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(String(init.body)), {
        query: 'query AnyOp { viewer { id } }',
        variables: { n: 5 },
      })
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })

  test('errors pass through verbatim — a plan step never throws on API errors', async () => {
    const { fn } = fakeFetch({
      BadOp: { errors: [{ message: 'Cannot query field "nope"' }] },
    })
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_query_test'
    try {
      const res = await linearQueries({ fetch: fn }).graphql('query BadOp { nope }')
      assert.deepEqual(res.errors, [{ message: 'Cannot query field "nope"' }])
      assert.equal(res.data, undefined)
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })

  test('a plan env overlay supplies the key — without leaking process env', async () => {
    const { fn, calls } = fakeFetch({ AnyOp: { data: { ok: true } } })
    const prev = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
    try {
      await linearQueries({ fetch: fn }).graphql('query AnyOp { ok }', {
        env: { LINEAR_API_KEY: 'lin_api_plan_overlay' },
      })
      assert.equal(
        (calls[0]!.init.headers as Record<string, string>)['Authorization'],
        'lin_api_plan_overlay'
      )
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev
    }
  })

  test('HTTP failure throws a named error, non-JSON too', async () => {
    const httpErr = (async () =>
      new Response('unauthorized', { status: 401 })) as typeof fetch
    const prev = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = 'lin_api_query_test'
    try {
      await assert.rejects(
        linearQueries({ fetch: httpErr }).graphql('query A { a }'),
        /linear: HTTP 401/
      )
      const badJson = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch
      await assert.rejects(
        linearQueries({ fetch: badJson }).graphql('query A { a }'),
        /non-JSON response/
      )
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = prev
    }
  })
})

// --- connector wiring ----------------------------------------------------------------

describe('linear connector selection', { skip: WIN32 }, () => {
  const repoWithRemote = (url: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-linear-conn-'))
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url])
    return dir
  }

  test('tasks stays beads on any remote — linear is opt-in only', () => {
    registerConnector(linearConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      assert.equal(facadeName('tasks', { dir }), 'beads')
      // nothing about the repo names linear — with every queries
      // provider opt-in, an unpinned pick is a hard error, not a guess
      assert.throws(() => facadeName('queries', { dir }), /opt-in/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('connectors.tasks=linear resolves the linear TaskStore', () => {
    registerConnector(linearConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      assert.equal(facadeName('tasks', { dir }, { prefer: { tasks: 'linear' } }), 'linear')
      const store = facade('tasks', { dir }, { prefer: { tasks: 'linear' } })
      assert.equal(typeof store.ready, 'function')
      assert.equal(typeof store.claim, 'function')
      assert.equal(typeof store.prefix, 'function')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('connectors.queries=linear resolves the QueryFacade', () => {
    registerConnector(linearConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      const q = facade('queries', { dir }, { prefer: { queries: 'linear' } })
      assert.equal(typeof q.graphql, 'function')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tasksAsync honors the same opt-in pin', () => {
    registerConnector(linearConnector)
    const dir = repoWithRemote('git@github.com:acme/widgets.git')
    try {
      assert.equal(facadeName('tasksAsync', { dir }), 'beads')
      assert.equal(facadeName('tasksAsync', { dir }, { prefer: { tasksAsync: 'linear' } }), 'linear')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('auth() reports the remediation line with no key, never throws', () => {
    const prev = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
    try {
      const msg = linearConnector.auth?.({ dir: '/tmp' })
      assert.match(msg ?? '', /LINEAR_API_KEY not set/)
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev
    }
  })

  test('auth() probes viewer when a key is present — bad key → remediation', () => {
    withLinear(
      {
        LINEAR_API_KEY: 'lin_api_bad',
        FAKE_LINEAR_VIEWER: '{"errors":[{"message":"Unauthorized"}]}',
      },
      (_log, _dir) => {
        const msg = linearConnector.auth?.({ dir: '/tmp' })
        assert.match(msg ?? '', /LINEAR_API_KEY not usable.*Unauthorized/)
      }
    )
  })

  test('auth() returns null on a good key', () => {
    withLinear({ LINEAR_API_KEY: 'lin_api_good' }, (_log, _dir) => {
      assert.equal(linearConnector.auth?.({ dir: '/tmp' }), null)
    })
  })
})
