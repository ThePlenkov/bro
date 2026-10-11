import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { facade, facadeName, registerConnector } from '@broject/core'
import { jiraConnector, jiraTasks, jiraTasksAsync } from './index.ts'

const WIN32 = process.platform === 'win32'

/** Scripted `atlassian` on PATH — the transport's test seam. Parses
 *  `api <METHOD> [--url <base>] <endpoint> [-d <json>] --json`, appends
 *  argv to $FAKE_ATL_ARGV and -d bodies to $FAKE_ATL_LOG, and answers
 *  by endpoint shape. Payloads are env-driven:
 *    FAKE_JIRA_VIEWER     — /myself body
 *    FAKE_JIRA_PROJECTS   — /project/search body
 *    FAKE_JIRA_PRIORITIES — /priority body
 *    FAKE_JIRA_TYPES      — /issuetype body
 *    FAKE_JIRA_LINKTYPES  — /issueLinkType body
 *    FAKE_JIRA_ISSUES     — /search/jql page body
 *    FAKE_JIRA_ISSUE_1    — the FIRST /issue/<k> read (claim's pre-read)
 *    FAKE_JIRA_ISSUE_2    — scripted override for every LATER issue read
 *                           (claim's verify); falls back to _1 — an
 *                           issue doesn't vanish after one read
 *    FAKE_JIRA_TRANSITIONS — /issue/<k>/transitions body
 *    FAKE_JIRA_USERS      — /user/assignable/search body
 *    FAKE_JIRA_CREATE     — POST /issue body
 *    FAKE_SEARCH_POST_EXIT — nonzero exit for POST /search/jql only
 *                           (GET-fallback tests); stderr carries '404'
 *    FAKE_ATL_EXIT        — nonzero exit for every call
 *    FAKE_ATL_ERR         — extra stderr text on failure */
const FAKE_ATL = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ATL_ARGV"
method=''
ep=''
data=''
prev=''
for a in "$@"; do
  case "$prev" in
    -d) data=$a ;;
  esac
  case "$a" in
    GET|POST|PUT|DELETE) [ -z "$method" ] && method=$a ;;
    /*) ep=$a ;;
  esac
  prev=$a
done
[ -n "$data" ] && printf '%s\\n' "$data" >> "$FAKE_ATL_LOG"
if [ -n "$FAKE_SEARCH_POST_EXIT" ] && [ "$method" = POST ]; then
  case "$ep" in */search/jql*) echo "HTTP 404 Not Found" >&2; exit "$FAKE_SEARCH_POST_EXIT" ;; esac
fi
case "$ep" in
  */myself) printf '%s\\n' "$FAKE_JIRA_VIEWER" ;;
  */project/search*) printf '%s\\n' "$FAKE_JIRA_PROJECTS" ;;
  */priority) printf '%s\\n' "$FAKE_JIRA_PRIORITIES" ;;
  */issuetype) printf '%s\\n' "$FAKE_JIRA_TYPES" ;;
  */issueLinkType) printf '%s\\n' "$FAKE_JIRA_LINKTYPES" ;;
  */search/jql*) printf '%s\\n' "$FAKE_JIRA_ISSUES" ;;
  */issue/*/transitions)
    [ "$method" = GET ] && printf '%s\\n' "$FAKE_JIRA_TRANSITIONS" || echo '{}' ;;
  */issue/*/comment|*/issue/*/assignee) echo '{}' ;;
  */issueLink) echo '{}' ;;
  */user/assignable/search*) printf '%s\\n' "$FAKE_JIRA_USERS" ;;
  */issue)
    [ "$method" = POST ] && printf '%s\\n' "$FAKE_JIRA_CREATE" || echo '{}' ;;
  */issue/*)
    case "$method" in
      GET)
        n=$(grep -c "GET.*\\/issue\\/" "$FAKE_ATL_ARGV" || true)
        if [ "$n" -gt 1 ] && [ -n "$FAKE_JIRA_ISSUE_2" ]; then
          printf '%s\\n' "$FAKE_JIRA_ISSUE_2"
        else
          printf '%s\\n' "$FAKE_JIRA_ISSUE_1"
        fi ;;
      *) echo '{}' ;;
    esac ;;
  *) echo '{}' ;;
esac
if [ -n "$FAKE_ATL_EXIT" ]; then
  [ -n "$FAKE_ATL_ERR" ] && echo "$FAKE_ATL_ERR" >&2
  exit "$FAKE_ATL_EXIT"
fi
exit 0
`

const JIRA_STATUS = (key: string) => ({ name: key, statusCategory: { key, name: key } })

interface IssueOpts {
  key: string
  title?: string
  category?: string // statusCategory key — new | indeterminate | done
  assignee?: string | null
  labels?: string[]
  blockedBy?: [string, string][] // outwardIssue counterparts (blockers)
  blocks?: [string, string][] // inwardIssue counterparts (blocked by this)
  relates?: [string, string][]
  subtasks?: [string, string][]
  parent?: string
  issuetype?: string
  priority?: string | null
  description?: unknown
  resolution?: string | null
  resolutiondate?: string | null
  created?: string
}

const ref = ([k, cat]: [string, string]): Record<string, unknown> => ({
  key: k,
  fields: { status: JIRA_STATUS(cat), summary: `issue ${k}` },
})

const BLOCKS = {
  name: 'Blocks',
  inward: 'is blocked by',
  outward: 'blocks',
}
const RELATES = { name: 'Relates', inward: 'relates to', outward: 'relates to' }

/** An issue node in the shape the REST surface returns. */
function issue(o: IssueOpts): Record<string, unknown> {
  const num = o.key.replace(/\D/g, '')
  const issuelinks: Record<string, unknown>[] = [
    ...(o.blockedBy ?? []).map((r) => ({ type: BLOCKS, outwardIssue: ref(r) })),
    ...(o.blocks ?? []).map((r) => ({ type: BLOCKS, inwardIssue: ref(r) })),
    ...(o.relates ?? []).map((r) => ({ type: RELATES, outwardIssue: ref(r) })),
  ]
  return {
    id: `10${num}`,
    key: o.key,
    self: `https://acme.atlassian.net/rest/api/3/issue/10${num}`,
    fields: {
      summary: o.title ?? `issue ${o.key}`,
      description: o.description ?? null,
      status: JIRA_STATUS(o.category ?? 'new'),
      issuetype: { name: o.issuetype ?? 'Task' },
      priority:
        o.priority === undefined
          ? { name: 'Medium' }
          : o.priority === null
            ? null
            : { name: o.priority },
      assignee:
        o.assignee === undefined || o.assignee === null
          ? null
          : { accountId: `acct-${o.assignee}`, displayName: o.assignee },
      labels: o.labels ?? [],
      issuelinks,
      subtasks: (o.subtasks ?? []).map(ref),
      ...(o.parent !== undefined ? { parent: { key: o.parent } } : {}),
      resolution: o.resolution != null ? { name: o.resolution } : null,
      created: o.created ?? `2026-01-${num.padStart(2, '0')}T00:00:00.000+0000`,
      resolutiondate: o.resolutiondate ?? null,
    },
  }
}

const issuesPage = (nodes: Record<string, unknown>[]): string =>
  JSON.stringify({ issues: nodes, isLast: true })

/** The ADF the REST surface hands back for a plain-text description. */
const adf = (text: string): Record<string, unknown> => ({
  type: 'doc',
  version: 1,
  content: text
    .split(/\n{2,}/)
    .filter((p) => p !== '')
    .map((p) => ({
      type: 'paragraph',
      content: p
        .split('\n')
        .flatMap((line, i) => [
          ...(i > 0 ? [{ type: 'hardBreak' }] : []),
          { type: 'text', text: line },
        ]),
    })),
})

// Every withAtl call gets its OWN site base URL: api.ts's caches key on
// it — a later test swapping payloads would otherwise inherit a stale
// pick. The unique base also exercises the --url + https-assert path.
let siteSeq = 0

const ENV_DEFAULTS: Record<string, string> = {
  // unset ambient project pins leak into auto-detect — pin them empty
  // so every test controls its own project set
  JIRA_PROJECT: '',
  ATLASSIAN_PROJECT: '',
  JIRA_CLOUD_ID: '',
  ATLASSIAN_CLOUD_ID: '',
  FAKE_JIRA_VIEWER: JSON.stringify({
    accountId: 'acct-me',
    displayName: 'Me',
    emailAddress: 'me@x',
  }),
  FAKE_JIRA_PROJECTS: JSON.stringify({
    values: [{ id: 'p1', key: 'PROJ', name: 'Project' }],
  }),
  FAKE_JIRA_PRIORITIES: JSON.stringify([
    { name: 'Highest' },
    { name: 'High' },
    { name: 'Medium' },
    { name: 'Low' },
    { name: 'Lowest' },
  ]),
  FAKE_JIRA_TYPES: JSON.stringify([
    { name: 'Task' },
    { name: 'Bug' },
    { name: 'Story' },
    { name: 'Sub-task' },
    { name: 'Epic' },
  ]),
  FAKE_JIRA_LINKTYPES: JSON.stringify({
    issueLinkTypes: [
      { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
      { id: '3', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
    ],
  }),
  FAKE_JIRA_TRANSITIONS: JSON.stringify({
    transitions: [
      {
        id: '11',
        name: 'Start',
        to: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      },
      { id: '21', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done', name: 'Done' } } },
      { id: '31', name: 'Reopen', to: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } } },
    ],
  }),
}

/** Env swap + a scripted `atlassian` on PATH; the logs record argv and
 *  bodies. Returns the swap's undo — async tests await inside their
 *  own try/finally so the fake stays on PATH for late spawns. */
function atlSetup(
  script: string,
  env: Record<string, string>
): { argv: string; body: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-jira-'))
  const argv = join(dir, 'argv.log')
  const body = join(dir, 'body.log')
  writeFileSync(argv, '')
  writeFileSync(body, '')
  writeFileSync(join(dir, 'atlassian'), script)
  chmodSync(join(dir, 'atlassian'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const all = {
    JIRA_BASE_URL: `https://jira-test-${++siteSeq}.example.com`,
    ...ENV_DEFAULTS,
    ...env,
  }
  const prevEnv = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_ATL_ARGV: argv, FAKE_ATL_LOG: body, ...all })
  return {
    argv,
    body,
    dir,
    cleanup: () => {
      process.env.PATH = prevPath
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      delete process.env.FAKE_ATL_ARGV
      delete process.env.FAKE_ATL_LOG
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function withAtl(
  script: string,
  env: Record<string, string>,
  fn: (logs: { argv: string; body: string }, dir: string) => void
): void {
  const t = atlSetup(script, env)
  try {
    fn({ argv: t.argv, body: t.body }, t.dir)
  } finally {
    t.cleanup()
  }
}

function withJira(
  env: Record<string, string>,
  fn: (logs: { argv: string; body: string }, dir: string) => void
): void {
  withAtl(FAKE_ATL, env, fn)
}

/** argv lines — `api GET --url <base> <endpoint> ... --json` per spawn. */
const calls = (argv: string): string[] =>
  readFileSync(argv, 'utf8').trim().split('\n').filter((l) => l !== '')
const callsMatching = (argv: string, re: RegExp): string[] => calls(argv).filter((l) => re.test(l))
const bodies = (body: string): string[] =>
  readFileSync(body, 'utf8').trim().split('\n').filter((l) => l !== '')
const bodiesMatching = (body: string, re: RegExp): Record<string, unknown>[] =>
  bodies(body)
    .filter((l) => re.test(l))
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('jiraTasks', { skip: WIN32 }, () => {
  test('list maps statusCategory, assignee, blocked links onto status', () => {
    withJira(
      {
        FAKE_JIRA_ISSUES: issuesPage([
          issue({ key: 'PROJ-1', title: 'plain open' }),
          issue({ key: 'PROJ-2', title: 'claimed', assignee: 'me' }),
          issue({ key: 'PROJ-3', title: 'blocked', blockedBy: [['PROJ-9', 'new']] }),
          issue({ key: 'PROJ-4', title: 'done', category: 'done' }),
          issue({ key: 'PROJ-5', title: 'started', category: 'indeterminate' }),
          issue({ key: 'PROJ-6', title: 'label blocked', labels: ['blocked'] }),
          issue({ key: 'PROJ-7', title: 'open child', subtasks: [['PROJ-8', 'new']] }),
          issue({ key: 'PROJ-9', title: 'resolved blocker', blockedBy: [['PROJ-10', 'done']] }),
        ]),
      },
      (_logs, dir) => {
        const rows = jiraTasks(dir).list({ all: true })
        const status = new Map(rows.map((r) => [r.id, r.status]))
        assert.deepEqual(Object.fromEntries(status), {
          'PROJ-1': 'open',
          'PROJ-2': 'in_progress',
          'PROJ-3': 'blocked',
          'PROJ-4': 'closed',
          'PROJ-5': 'in_progress',
          'PROJ-6': 'blocked',
          'PROJ-7': 'blocked',
          'PROJ-9': 'open',
        })
      }
    )
  })

  test('list sends a project-scoped JQL; closed/all flip the status clause', () => {
    withJira({ FAKE_JIRA_ISSUES: issuesPage([issue({ key: 'PROJ-1' })]) }, (logs, dir) => {
      const s = jiraTasks(dir)
      s.list()
      s.list({ status: 'closed' })
      s.list({ all: true })
      const jqls = bodiesMatching(logs.body, /"jql"/).map((b) => b.jql)
      assert.equal(jqls[0], 'project = "PROJ" AND statusCategory != Done ORDER BY created ASC')
      assert.equal(jqls[1], 'project = "PROJ" AND statusCategory = Done ORDER BY created ASC')
      assert.equal(jqls[2], 'project = "PROJ" ORDER BY created ASC')
      // the endpoint is site-relative and the base rides --url
      const post = callsMatching(logs.argv, /POST/)
      assert.match(post[0]!, /--url https:\/\/jira-test-\d+\.example\.com \/rest\/api\/3\/search\/jql/)
    })
  })

  test('POST /search/jql falling to 404 retries the GET form', () => {
    withJira(
      {
        FAKE_SEARCH_POST_EXIT: '1',
        FAKE_JIRA_ISSUES: issuesPage([issue({ key: 'PROJ-1' })]),
      },
      (logs, dir) => {
        const rows = jiraTasks(dir).list()
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.id, 'PROJ-1')
        assert.equal(callsMatching(logs.argv, /POST.*search\/jql/).length, 1)
        const get = callsMatching(logs.argv, /GET.*search\/jql/)
        assert.equal(get.length, 1)
        assert.match(get[0]!, /jql=project/)
      }
    )
  })

  test('get resolves keys, bare numbers, and /browse/ URLs to a row', () => {
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(
          issue({
            key: 'PROJ-5',
            title: 'the ticket',
            category: 'new',
            labels: ['ui'],
            priority: 'High',
            issuetype: 'Bug',
            description: adf('do the thing\n\n<!-- bro: {"type":"bug","priority":1} -->'),
            created: '2026-01-04T00:00:00.000+0000',
          })
        ),
      },
      (_logs, dir) => {
        const s = jiraTasks(dir)
        for (const id of [
          'PROJ-5',
          'proj-5',
          '5',
          'https://acme.atlassian.net/browse/PROJ-5',
        ]) {
          const r = s.get(id)
          assert.equal(r?.id, 'PROJ-5', `id ${id}`)
        }
        const r = s.get('PROJ-5')!
        assert.equal(r.title, 'the ticket')
        // native issuetype wins over the trailer — Jira HAS types
        assert.equal(r.issue_type, 'bug')
        // site priority name maps positionally: High = index 1 of 5
        assert.equal(r.priority, 1)
        assert.equal(r.description, 'do the thing')
        assert.equal(r.external_ref, 'https://acme.atlassian.net/browse/PROJ-5')
        assert.deepEqual(r.labels, ['ui'])
        assert.deepEqual(r.metadata, { type: 'bug', priority: 1 })
        assert.equal(
          (r as { created_at?: string }).created_at,
          '2026-01-04T00:00:00.000+0000'
        )
      }
    )
  })

  test('ready keeps only open unblocked unclaimed rows, priority then created', () => {
    withJira(
      {
        FAKE_JIRA_ISSUES: issuesPage([
          issue({ key: 'PROJ-1', title: 'low prio', priority: 'Low', created: '2026-01-01T00:00:00.000+0000' }),
          issue({ key: 'PROJ-2', title: 'claimed', assignee: 'other' }),
          issue({ key: 'PROJ-3', title: 'high newer', priority: 'Highest', created: '2026-01-03T00:00:00.000+0000' }),
          issue({ key: 'PROJ-4', title: 'high older', priority: 'Highest', created: '2026-01-02T00:00:00.000+0000' }),
          issue({ key: 'PROJ-6', title: 'blocked', blockedBy: [['PROJ-9', 'new']] }),
          issue({ key: 'PROJ-7', title: 'done', category: 'done' }),
        ]),
      },
      (logs, dir) => {
        const rows = jiraTasks(dir).ready()
        assert.deepEqual(
          rows.map((r) => r.id),
          ['PROJ-4', 'PROJ-3', 'PROJ-1']
        )
        // JQL pre-filters unassigned + not-done server-side
        const jql = bodiesMatching(logs.body, /"jql"/)[0]!.jql
        assert.match(String(jql), /assignee is EMPTY/)
        assert.match(String(jql), /statusCategory != Done/)
      }
    )
  })

  test('claim assigns the viewer and verifies; assigned/done throw', () => {
    const open = issue({ key: 'PROJ-5', assignee: null })
    // the fixture derives accountId from the name — 'me' → 'acct-me',
    // exactly what the viewer probe answers
    const mine = issue({ key: 'PROJ-5', assignee: 'me' })
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(open),
        FAKE_JIRA_ISSUE_2: JSON.stringify(mine),
      },
      (logs, dir) => {
        const s = jiraTasks(dir)
        s.claim('PROJ-5')
        const assign = bodiesMatching(logs.body, /accountId/)
        assert.equal(assign[0]!.accountId, 'acct-me')
        // a 'start' transition rides best-effort after the verify
        const tr = bodiesMatching(logs.body, /"transition"/)
        assert.deepEqual(tr[0]!.transition, { id: '11' })
      }
    )
    withJira(
      { FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', assignee: 'rival' })) },
      (_logs, dir) => {
        assert.throws(() => jiraTasks(dir).claim('PROJ-5'), /already claimed by rival/)
      }
    )
    withJira(
      { FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', category: 'done' })) },
      (_logs, dir) => {
        assert.throws(() => jiraTasks(dir).claim('PROJ-5'), /only open issues are claimable/)
      }
    )
    // verify shows a different holder → contested
    const rival = issue({ key: 'PROJ-5', assignee: 'rival' })
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(open),
        FAKE_JIRA_ISSUE_2: JSON.stringify(rival),
      },
      (_logs, dir) => {
        assert.throws(() => jiraTasks(dir).claim('PROJ-5'), /claim contested — rival holds it/)
      }
    )
  })

  test('close comments the reason then transitions to done', () => {
    withJira(
      { FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5' })) },
      (logs, dir) => {
        jiraTasks(dir).close('PROJ-5', 'shipped it')
        const argv = calls(logs.argv)
        const commentAt = argv.findIndex((l) => /\/issue\/PROJ-5\/comment/.test(l))
        const trGetAt = argv.findIndex((l) => /GET.*\/issue\/PROJ-5\/transitions/.test(l))
        const trPostAt = argv.findIndex((l) => /POST.*\/issue\/PROJ-5\/transitions/.test(l))
        assert.ok(commentAt >= 0 && commentAt < trGetAt && trGetAt < trPostAt, argv.join('\n'))
        const tr = bodiesMatching(logs.body, /"transition"/)
        assert.deepEqual(tr[0]!.transition, { id: '21' })
        const cmt = bodiesMatching(logs.body, /shipped it/)
        assert.equal(cmt.length, 1)
      }
    )
  })

  test('reopen transitions to new, unassigns, drops the blocked label', () => {
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(
          issue({ key: 'PROJ-5', category: 'done', assignee: 'me', labels: ['blocked', 'ui'] })
        ),
      },
      (logs, dir) => {
        jiraTasks(dir).reopen('PROJ-5')
        const tr = bodiesMatching(logs.body, /"transition"/)
        assert.deepEqual(tr[0]!.transition, { id: '31' })
        const unassign = bodiesMatching(logs.body, /"accountId":"-1"/)
        assert.equal(unassign.length, 1)
        const labelsPut = bodiesMatching(logs.body, /"labels"/)
        assert.deepEqual(labelsPut[0]!.fields, { labels: ['ui'] })
      }
    )
  })

  test('deps maps issuelinks + parent/subtasks into canonical edges', () => {
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(
          issue({
            key: 'PROJ-5',
            blockedBy: [['PROJ-1', 'new']],
            blocks: [['PROJ-2', 'new']],
            relates: [['PROJ-3', 'new']],
            parent: 'PROJ-0',
            subtasks: [['PROJ-6', 'new']],
          })
        ),
      },
      (_logs, dir) => {
        const s = jiraTasks(dir)
        assert.deepEqual(s.deps(['PROJ-5'], { direction: 'down' }), [
          { issue_id: 'PROJ-5', depends_on_id: 'PROJ-1', type: 'blocked' },
          { issue_id: 'PROJ-5', depends_on_id: 'PROJ-3', type: 'related' },
          { issue_id: 'PROJ-5', depends_on_id: 'PROJ-0', type: 'parent' },
        ])
        assert.deepEqual(s.deps(['PROJ-5'], { direction: 'up' }), [
          { issue_id: 'PROJ-2', depends_on_id: 'PROJ-5', type: 'blocked' },
          { issue_id: 'PROJ-6', depends_on_id: 'PROJ-5', type: 'parent' },
        ])
        assert.deepEqual(s.deps(['PROJ-5'], { rel: 'blocked' }), [
          { issue_id: 'PROJ-5', depends_on_id: 'PROJ-1', type: 'blocked' },
          { issue_id: 'PROJ-2', depends_on_id: 'PROJ-5', type: 'blocked' },
        ])
        assert.deepEqual(s.deps(['PROJ-5'], { rel: 'parent' }), [
          { issue_id: 'PROJ-5', depends_on_id: 'PROJ-0', type: 'parent' },
          { issue_id: 'PROJ-6', depends_on_id: 'PROJ-5', type: 'parent' },
        ])
      }
    )
  })

  test('link wires blocked/related/parent onto the right Jira verbs', () => {
    withJira({}, (logs, dir) => {
      const s = jiraTasks(dir)
      // link(a, b, 'blocked') = "a is blocked by b" → b rides outward
      s.link('PROJ-5', 'PROJ-1', 'blocked')
      s.link('PROJ-5', 'PROJ-3', 'related')
      s.link('PROJ-5', 'PROJ-0', 'parent')
      const links = bodiesMatching(logs.body, /issueLink|inwardIssue/)
      assert.deepEqual(links[0], {
        type: { name: 'Blocks' },
        outwardIssue: { key: 'PROJ-1' },
        inwardIssue: { key: 'PROJ-5' },
      })
      assert.deepEqual(links[1], {
        type: { name: 'Relates' },
        outwardIssue: { key: 'PROJ-5' },
        inwardIssue: { key: 'PROJ-3' },
      })
      const parentPut = bodiesMatching(logs.body, /"parent"/)
      assert.deepEqual(parentPut[0]!.fields, { parent: { key: 'PROJ-0' } })
    })
  })

  test('create posts fields, wires deps, reads the row back', () => {
    const created = issue({ key: 'PROJ-9', title: 'new work', issuetype: 'Bug', priority: 'High' })
    withJira(
      {
        FAKE_JIRA_CREATE: JSON.stringify({ key: 'PROJ-9' }),
        FAKE_JIRA_ISSUE_1: JSON.stringify(created),
      },
      (logs, dir) => {
        const r = jiraTasks(dir).create({
          title: 'new work',
          type: 'bug',
          priority: 1,
          labels: ['ui'],
          description: 'body',
          externalRef: 'ext-1',
          deps: ['blocked:PROJ-1', 'parent:PROJ-0'],
        })
        assert.equal(r.id, 'PROJ-9')
        const posts = bodiesMatching(logs.body, /"summary":"new work"/)
        const fields = posts[0]!.fields as Record<string, unknown>
        assert.deepEqual(fields.project, { key: 'PROJ' })
        assert.deepEqual(fields.issuetype, { name: 'Bug' })
        // bd priority 1 of 0-4 → index 1 of the site's 5 names
        assert.deepEqual(fields.priority, { name: 'High' })
        assert.deepEqual(fields.labels, ['ui'])
        // description lands as ADF carrying the bro trailer
        const desc = JSON.stringify(fields.description)
        assert.match(desc, /bro:/)
        assert.match(desc, /ext-1/)
        // deps wired after create — blocked rides Blocks outward,
        // parent rides the parent field
        const links = bodiesMatching(logs.body, /inwardIssue/)
        assert.deepEqual(links[0], {
          type: { name: 'Blocks' },
          outwardIssue: { key: 'PROJ-1' },
          inwardIssue: { key: 'PROJ-9' },
        })
        const parentPut = bodiesMatching(logs.body, /"parent":\{"key":"PROJ-0"\}/)
        assert.equal(parentPut.length, 1)
      }
    )
  })

  test('update dispatches title/labels/priority/note/status patches', () => {
    withJira(
      { FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', labels: ['ui'] })) },
      (logs, dir) => {
        const s = jiraTasks(dir)
        s.update('PROJ-5', { title: 'renamed' })
        s.update('PROJ-5', { labels: 'ui,backend' })
        s.update('PROJ-5', { priority: 4 })
        s.update('PROJ-5', { note: 'a note' })
        s.update('PROJ-5', { status: 'closed' })
        assert.deepEqual(bodiesMatching(logs.body, /"summary":"renamed"/)[0]!.fields, {
          summary: 'renamed',
        })
        assert.deepEqual(bodiesMatching(logs.body, /"labels":\[/)[0]!.fields, {
          labels: ['ui', 'backend'],
        })
        assert.deepEqual(bodiesMatching(logs.body, /"priority":/)[0]!.fields, {
          priority: { name: 'Lowest' },
        })
        assert.equal(bodiesMatching(logs.body, /a note/).length, 1)
        // status:closed → the done transition
        assert.deepEqual(bodiesMatching(logs.body, /"transition"/)[0]!.transition, { id: '21' })
        assert.throws(() => s.update('PROJ-5', { wat: 'x' }), /unsupported update key/)
      }
    )
  })

  test('children hydrates sub-task rows; neighbors tag dependency_type', () => {
    const child = issue({ key: 'PROJ-6', title: 'child' })
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', subtasks: [['PROJ-6', 'new']] })),
        FAKE_JIRA_ISSUE_2: JSON.stringify(child),
      },
      (_logs, dir) => {
        const s = jiraTasks(dir)
        const kids = s.children('PROJ-5')
        assert.deepEqual(
          kids.map((r) => r.id),
          ['PROJ-6']
        )
      }
    )
    const blocker = issue({ key: 'PROJ-1', title: 'blocker' })
    withJira(
      {
        FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', blockedBy: [['PROJ-1', 'new']] })),
        FAKE_JIRA_ISSUE_2: JSON.stringify(blocker),
      },
      (_logs, dir) => {
        const rows = jiraTasks(dir).neighbors('PROJ-5')
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.id, 'PROJ-1')
        assert.equal((rows[0] as { dependency_type?: string }).dependency_type, 'blocked')
      }
    )
  })

  test('actor answers the viewer name; prefix is the project key', () => {
    withJira({}, (_logs, dir) => {
      const s = jiraTasks(dir)
      assert.equal(s.actor?.(), 'Me')
      assert.equal(s.prefix(), 'PROJ')
    })
  })

  test('a dead CLI throws the transport error, not a silent empty', () => {
    withJira({ FAKE_ATL_EXIT: '1', FAKE_ATL_ERR: 'boom' }, (_logs, dir) => {
      assert.throws(() => jiraTasks(dir).list(), /boom/)
    })
  })

  test('auth reports a remediation line when the CLI cannot answer', () => {
    withJira({}, (_logs, _dir) => {
      assert.equal(jiraConnector.auth?.({ dir: '' } as never), null)
    })
    withJira({ FAKE_ATL_EXIT: '1', FAKE_ATL_ERR: 'no token' }, (_logs, _dir) => {
      const line = jiraConnector.auth?.({ dir: '' } as never)
      assert.match(String(line), /atlassian CLI not ready/)
      assert.match(String(line), /no token/)
    })
  })
})

describe('jiraTasksAsync', { skip: WIN32 }, () => {
  test('list + ready map the same rows over spawn', async () => {
    const t = atlSetup(FAKE_ATL, {
      FAKE_JIRA_ISSUES: issuesPage([
        issue({ key: 'PROJ-1', title: 'open' }),
        issue({ key: 'PROJ-2', title: 'claimed', assignee: 'other' }),
        issue({ key: 'PROJ-4', title: 'done', category: 'done' }),
      ]),
      FAKE_JIRA_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-1', title: 'open' })),
    })
    try {
      const s = jiraTasksAsync(t.dir)
      const rows = await s.list({ all: true })
      assert.equal(rows.length, 3)
      const ready = await s.ready()
      assert.deepEqual(
        ready.map((r) => r.id),
        ['PROJ-1']
      )
      const got = await s.get('PROJ-1')
      assert.equal(got?.title, 'open')
      assert.equal(await s.actor?.(), 'Me')
    } finally {
      t.cleanup()
    }
  })

  test('deps maps relations over async spawns', async () => {
    const t = atlSetup(FAKE_ATL, {
      FAKE_JIRA_ISSUE_1: JSON.stringify(
        issue({ key: 'PROJ-5', blockedBy: [['PROJ-1', 'new']], parent: 'PROJ-0' })
      ),
    })
    try {
      const deps = await jiraTasksAsync(t.dir).deps(['PROJ-5'], { direction: 'down' })
      assert.deepEqual(deps, [
        { issue_id: 'PROJ-5', depends_on_id: 'PROJ-1', type: 'blocked' },
        { issue_id: 'PROJ-5', depends_on_id: 'PROJ-0', type: 'parent' },
      ])
    } finally {
      t.cleanup()
    }
  })
})

describe('jira connector selection', { skip: WIN32 }, () => {
  test('opt-in: never auto-detected, always name-selectable', () => {
    withJira({}, (_logs, dir) => {
      registerConnector(jiraConnector)
      // nothing about a repo names a Jira project — beads stays default
      assert.equal(facadeName('tasks', { dir }), 'beads')
      assert.equal(facadeName('tasks', { dir }, { prefer: { tasks: 'jira' } }), 'jira')
      const store = facade('tasks', { dir }, { prefer: { tasks: 'jira' } })
      assert.equal(store.prefix(), 'PROJ')
      assert.equal(facadeName('tasksAsync', { dir }, { prefer: { tasksAsync: 'jira' } }), 'jira')
    })
  })
})
