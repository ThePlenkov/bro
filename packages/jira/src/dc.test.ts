import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { facadeName, registerConnector } from '@broject/core'
import { jiraDcConnector, jiraDcTasks } from './index.ts'

const WIN32 = process.platform === 'win32'

/** Scripted `atlassian` on PATH — the transport's test seam. Answers
 *  the /rest/api/2 shapes: string bodies, name-keyed users, /search
 *  paged on startAt, /project as a bare array. Payloads are
 *  env-driven:
 *    FAKE_DC_VIEWER      — /myself body ({name, key, displayName})
 *    FAKE_DC_PROJECTS    — /project array body
 *    FAKE_DC_PROJECT_ONE — /project/<key> body (direct key read)
 *    FAKE_DC_PRIORITIES  — /priority body
 *    FAKE_DC_TYPES       — /issuetype body
 *    FAKE_DC_LINKTYPES   — /issueLinkType body
 *    FAKE_DC_PAGE1       — POST /search body for startAt 0
 *    FAKE_DC_PAGE2       — POST /search body for any later startAt
 *    FAKE_DC_ISSUE_1     — the FIRST /issue/<k> read (claim's pre-read)
 *    FAKE_DC_ISSUE_2     — scripted override for every LATER issue read
 *                          (claim's verify); falls back to _1
 *    FAKE_DC_TRANSITIONS — /issue/<k>/transitions body
 *    FAKE_DC_USERS       — /user/assignable/search body
 *    FAKE_DC_CREATE      — POST /issue body
 *    FAKE_ATL_EXIT       — nonzero exit for every call
 *    FAKE_ATL_ERR        — extra stderr text on failure */
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
case "$ep" in
  */myself) printf '%s\\n' "$FAKE_DC_VIEWER" ;;
  */project/*)
    if [ -z "$FAKE_DC_PROJECT_ONE" ]; then
      echo "HTTP 404 Not Found" >&2; exit 4
    fi
    printf '%s\\n' "$FAKE_DC_PROJECT_ONE" ;;
  */project) printf '%s\\n' "$FAKE_DC_PROJECTS" ;;
  */priority) printf '%s\\n' "$FAKE_DC_PRIORITIES" ;;
  */issuetype) printf '%s\\n' "$FAKE_DC_TYPES" ;;
  */issueLinkType) printf '%s\\n' "$FAKE_DC_LINKTYPES" ;;
  */search)
    case "$data" in
      *'"startAt":0'*) printf '%s\\n' "$FAKE_DC_PAGE1" ;;
      *) printf '%s\\n' "$FAKE_DC_PAGE2" ;;
    esac ;;
  */issue/*/transitions)
    [ "$method" = GET ] && printf '%s\\n' "$FAKE_DC_TRANSITIONS" || echo '{}' ;;
  */issue/*/comment|*/issue/*/assignee) echo '{}' ;;
  */issueLink) echo '{}' ;;
  */user/assignable/search*) printf '%s\\n' "$FAKE_DC_USERS" ;;
  */issue)
    [ "$method" = POST ] && printf '%s\\n' "$FAKE_DC_CREATE" || echo '{}' ;;
  */issue/*)
    case "$method" in
      GET)
        n=$(grep -c "GET.*\\/issue\\/" "$FAKE_ATL_ARGV" || true)
        if [ "$n" -gt 1 ] && [ -n "$FAKE_DC_ISSUE_2" ]; then
          printf '%s\\n' "$FAKE_DC_ISSUE_2"
        else
          printf '%s\\n' "$FAKE_DC_ISSUE_1"
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

const DC_STATUS = (key: string) => ({ name: key, statusCategory: { key, name: key } })

/** An issue node in the v2 shape — string description, name-keyed
 *  assignee. */
function issue(o: {
  key: string
  title?: string
  category?: string
  assignee?: string | null
  description?: unknown
  issuetype?: string
  labels?: string[]
}): Record<string, unknown> {
  const num = o.key.replace(/\D/g, '')
  return {
    id: `10${num}`,
    key: o.key,
    self: `https://jira.dc.example/rest/api/2/issue/10${num}`,
    fields: {
      summary: o.title ?? `issue ${o.key}`,
      description: o.description ?? null,
      status: DC_STATUS(o.category ?? 'new'),
      issuetype: { name: o.issuetype ?? 'Task' },
      priority: { name: 'Medium' },
      assignee:
        o.assignee === undefined || o.assignee === null
          ? null
          : { name: o.assignee, displayName: o.assignee },
      labels: o.labels ?? [],
      issuelinks: [],
      subtasks: [],
      created: `2026-01-${num.padStart(2, '0')}T00:00:00.000+0000`,
    },
  }
}

const page = (nodes: Record<string, unknown>[], startAt: number, total: number): string =>
  JSON.stringify({ issues: nodes, startAt, maxResults: 100, total })

const lastPage = (nodes: Record<string, unknown>[]): string =>
  JSON.stringify({ issues: nodes, startAt: 0, maxResults: 100, total: nodes.length })

// Every withDc call gets its OWN site base URL: api.ts's caches key on
// it — a later test swapping payloads would otherwise inherit a stale
// pick. The unique base also exercises the --url + https-assert path.
let siteSeq = 0

const ENV_DEFAULTS: Record<string, string> = {
  JIRA_PROJECT: '',
  ATLASSIAN_PROJECT: '',
  JIRA_DC_BASE_URL: '',
  JIRA_CLOUD_ID: '',
  ATLASSIAN_CLOUD_ID: '',
  FAKE_DC_VIEWER: JSON.stringify({ name: 'me', key: 'me', displayName: 'Me' }),
  FAKE_DC_PROJECTS: JSON.stringify([{ id: 'p1', key: 'PROJ', name: 'Project' }]),
  FAKE_DC_PRIORITIES: JSON.stringify([
    { name: 'Highest' },
    { name: 'High' },
    { name: 'Medium' },
    { name: 'Low' },
    { name: 'Lowest' },
  ]),
  FAKE_DC_TYPES: JSON.stringify([{ name: 'Task' }, { name: 'Bug' }]),
  FAKE_DC_LINKTYPES: JSON.stringify({
    issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
  }),
  FAKE_DC_TRANSITIONS: JSON.stringify({
    transitions: [
      {
        id: '11',
        name: 'Start',
        to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      },
      { id: '21', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
      { id: '31', name: 'Reopen', to: { name: 'To Do', statusCategory: { key: 'new' } } },
    ],
  }),
}

/** Env swap + a scripted `atlassian` on PATH; the logs record argv and
 *  bodies. Returns the swap's undo. */
function dcSetup(env: Record<string, string>): {
  argv: string
  body: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'bro-jira-dc-'))
  const argv = join(dir, 'argv.log')
  const body = join(dir, 'body.log')
  writeFileSync(argv, '')
  writeFileSync(body, '')
  writeFileSync(join(dir, 'atlassian'), FAKE_ATL)
  chmodSync(join(dir, 'atlassian'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  const all = {
    JIRA_BASE_URL: `https://jira-dc-${++siteSeq}.example.com`,
    ...ENV_DEFAULTS,
    ...env,
  }
  const prevEnv = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]))
  Object.assign(process.env, { FAKE_ATL_ARGV: argv, FAKE_ATL_LOG: body, ...all })
  return {
    argv,
    body,
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

function withDc(
  env: Record<string, string>,
  fn: (logs: { argv: string; body: string }) => void
): void {
  const t = dcSetup(env)
  try {
    fn({ argv: t.argv, body: t.body })
  } finally {
    t.cleanup()
  }
}

const calls = (argv: string): string[] =>
  readFileSync(argv, 'utf8').trim().split('\n').filter((l) => l !== '')
const bodies = (body: string): string[] => calls(body)
const callsMatching = (argv: string, re: RegExp): string[] => calls(argv).filter((l) => re.test(l))

describe('jiraDcTasks', { skip: WIN32 }, () => {
  test('rides the v2 prefix and string description, not ADF', () => {
    withDc(
      {
        FAKE_DC_PAGE1: lastPage([
          issue({ key: 'PROJ-1', category: 'new', description: 'plain body text' }),
        ]),
      },
      ({ argv }) => {
        const store = jiraDcTasks('/tmp/x')
        const rows = store.list() as { id: string; description?: string }[]
        assert.equal(rows.length, 1)
        assert.equal(rows[0]!.description, 'plain body text')
        const line = callsMatching(argv, /search/)[0]!
        assert.match(line, /\/rest\/api\/2\/search/)
        assert.doesNotMatch(line, /api\/3|search\/jql/)
      }
    )
  })

  test('pages /search on startAt until total is reached', () => {
    withDc(
      {
        FAKE_DC_PAGE1: page([issue({ key: 'PROJ-1' }), issue({ key: 'PROJ-2' })], 0, 3),
        FAKE_DC_PAGE2: page([issue({ key: 'PROJ-3' })], 2, 3),
      },
      ({ argv, body }) => {
        const store = jiraDcTasks('/tmp/x')
        const rows = store.list({ all: true })
        assert.deepEqual(
          rows.map((r) => r.id),
          ['PROJ-1', 'PROJ-2', 'PROJ-3']
        )
        assert.equal(callsMatching(argv, /\/search/).length, 2)
        const searchBody = bodies(body).find((b) => b.includes('"jql"'))!
        assert.match(searchBody, /"startAt":0/)
      }
    )
  })

  test('claim writes {name} and verifies the name-keyed holder', () => {
    withDc(
      {
        FAKE_DC_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', category: 'new' })),
        FAKE_DC_ISSUE_2: JSON.stringify(issue({ key: 'PROJ-5', category: 'new', assignee: 'me' })),
      },
      ({ body }) => {
        const store = jiraDcTasks('/tmp/x')
        store.claim('PROJ-5')
        const assign = bodies(body).find((b) => b.includes('"name":"me"'))!
        assert.match(assign, /^\{"name":"me"\}$/)
      }
    )
  })

  test('close comments the reason as a plain string, not ADF', () => {
    withDc(
      { FAKE_DC_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5', category: 'indeterminate' })) },
      ({ body }) => {
        const store = jiraDcTasks('/tmp/x')
        store.close('PROJ-5', 'wont fix')
        const comment = bodies(body).find((b) => b.includes('wont fix'))!
        assert.match(comment, /^\{"body":"wont fix"\}$/)
        assert.doesNotMatch(comment, /"type":"doc"/)
      }
    )
  })

  test('reopen unassigns with the name-keyed -1 sentinel', () => {
    withDc(
      {
        FAKE_DC_ISSUE_1: JSON.stringify(
          issue({ key: 'PROJ-5', category: 'done', assignee: 'other' })
        ),
      },
      ({ body }) => {
        const store = jiraDcTasks('/tmp/x')
        store.reopen('PROJ-5')
        const unassign = bodies(body).find((b) => b.includes('"-1"'))!
        assert.match(unassign, /^\{"name":"-1"\}$/)
      }
    )
  })

  test('assignee update resolves users via the username param', () => {
    withDc(
      {
        FAKE_DC_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-5' })),
        FAKE_DC_USERS: JSON.stringify([{ name: 'bob', displayName: 'Bob' }]),
      },
      ({ argv, body }) => {
        const store = jiraDcTasks('/tmp/x')
        store.update('PROJ-5', { assignee: 'bob' })
        assert.match(callsMatching(argv, /assignable\/search/)[0]!, /username=bob/)
        const assign = bodies(body).find((b) => b.includes('"name":"bob"'))!
        assert.match(assign, /^\{"name":"bob"\}$/)
      }
    )
  })

  test('unset project falls back to the /project array listing', () => {
    withDc(
      {
        FAKE_DC_PAGE1: lastPage([issue({ key: 'OPS-1' })]),
        FAKE_DC_PROJECTS: JSON.stringify([{ id: 'p1', key: 'OPS' }]),
      },
      ({ argv }) => {
        const store = jiraDcTasks('/tmp/x')
        const rows = store.list()
        assert.equal(rows[0]!.id, 'OPS-1')
        const listing = callsMatching(argv, /GET.*\/rest\/api\/2\/project\b/)[0]!
        assert.doesNotMatch(listing, /project\/search/)
      }
    )
  })

  test('create posts string description + name-shaped fields', () => {
    withDc(
      {
        FAKE_DC_CREATE: JSON.stringify({ key: 'PROJ-9' }),
        FAKE_DC_ISSUE_1: JSON.stringify(issue({ key: 'PROJ-9' })),
      },
      ({ body }) => {
        const store = jiraDcTasks('/tmp/x')
        store.create({ title: 'new thing', description: 'made of text', type: 'task' })
        const create = bodies(body).find((b) => b.includes('"issuetype"'))!
        assert.match(create, /"description":"made of text/)
        assert.doesNotMatch(create, /"type":"doc"/)
      }
    )
  })

  test('a missing site base refuses before the spawn', () => {
    // HOME pinned off the real config so cliConfig() resolves {} —
    // the no-base verdict can't ride an ambient baseUrl
    withDc({ JIRA_BASE_URL: '', JIRA_DC_BASE_URL: '', HOME: '/nonexistent-bro-dc' }, () => {
      const store = jiraDcTasks('/tmp/x')
      assert.throws(() => store.get('PROJ-1'), /jira-dc: no site base/)
    })
  })

  test('actor answers the name-keyed viewer', () => {
    withDc({}, () => {
      const store = jiraDcTasks('/tmp/x')
      assert.equal(store.actor(), 'Me')
    })
  })

  test('auth reports a remediation line naming the PAT channel', () => {
    withDc({ FAKE_ATL_EXIT: '3', FAKE_ATL_ERR: 'unauthorized' }, () => {
      const line = jiraDcConnector.auth?.({ dir: '' } as never)
      assert.match(String(line), /jira-dc: atlassian CLI not ready/)
      assert.match(String(line), /unauthorized/)
      assert.match(String(line), /JIRA_BASE_URL|PAT/)
    })
  })
})

describe('jira-dc connector selection', { skip: WIN32 }, () => {
  test('opt-in: never auto-detected, always name-selectable', () => {
    withDc({}, (_logs) => {
      registerConnector(jiraDcConnector)
      // nothing about a repo names a DC site — beads stays default
      assert.equal(facadeName('tasks', { dir: '/tmp/x' }), 'beads')
      assert.equal(
        facadeName('tasks', { dir: '/tmp/x' }, { prefer: { tasks: 'jira-dc' } }),
        'jira-dc'
      )
      assert.equal(
        facadeName('tasksAsync', { dir: '/tmp/x' }, { prefer: { tasksAsync: 'jira-dc' } }),
        'jira-dc'
      )
    })
  })
})
