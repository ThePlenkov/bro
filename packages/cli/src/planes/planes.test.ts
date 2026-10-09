/** Plane catalog contract tests — every registered plane is a real
 *  descriptor (declared reads dispatch, undeclared names throw, verbs
 *  are declared-but-unwired), and the debt plane's adapter reads a real
 *  ledger in a tmp dir. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planes,
  PlaneUnavailable,
  PlaneVerbError,
  type EventRow,
  type Finding,
} from '@broject/core'
// registration side-effect — the catalog is empty without it
import './index.ts'

const EXPECTED = ['work', 'agents', 'queue', 'gates', 'events', 'judge', 'debt', 'learn']

const tmp = (): { dir: string; rm: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-planes-'))
  return { dir, rm: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('plane catalog', () => {
  test('planes(dir) returns the full catalog in canonical order', () => {
    const { dir, rm } = tmp()
    try {
      const catalog = planes(dir)
      assert.deepEqual(catalog.map((p) => p.name), EXPECTED)
    } finally {
      rm()
    }
  })

  test('undeclared named reads are a client bug on every plane', async () => {
    const { dir, rm } = tmp()
    try {
      for (const plane of planes(dir)) {
        await assert.rejects(
          () => plane.read('__bogus__'),
          (err: unknown) => {
            assert.ok(err instanceof PlaneVerbError, `${plane.name}: ${String(err)}`)
            return true
          },
          `${plane.name}.read('__bogus__')`
        )
      }
    } finally {
      rm()
    }
  })

  test('v1 is read-only — declared verbs are unwired, undeclared are client bugs', async () => {
    const { dir, rm } = tmp()
    try {
      for (const plane of planes(dir)) {
        assert.ok(plane.verbs.length > 0, `${plane.name} declares verbs`)
        for (const verb of plane.verbs) {
          await assert.rejects(
            () => plane.exec(verb, {}),
            (err: unknown) => {
              assert.ok(err instanceof PlaneUnavailable, `${plane.name}.${verb}: ${String(err)}`)
              return true
            },
            `${plane.name}.exec('${verb}')`
          )
        }
        await assert.rejects(() => plane.exec('__bogus__', {}), PlaneVerbError)
      }
    } finally {
      rm()
    }
  })
})

const FINDING = {
  thread_id: 'thread-abc-123',
  thread_url: 'https://example.test/t/1',
  status: 'open',
  priority: 'blocking',
  needs: 'code_change',
  source_pr: 42,
  source_pr_url: 'https://example.test/pr/42',
  source_pr_title: 'pr',
  merged_at: '2026-01-01T00:00:00Z',
  merged_sha: 'abc',
  path: 'src/x.ts',
  line: 7,
  author: 'reviewer',
  body: 'fix the thing',
  body_preview: 'fix the thing',
  fingerprint: 'fp1',
  area: 'src',
  harvested_at: '2026-01-02T00:00:00Z',
  harvest_run_id: 'run-1',
  times_seen: 1,
  fix_pr: null,
  fixed_at: null,
  notes: null,
}

describe('debt plane adapter', () => {
  test('reads a real ledger — list/get/next/summary', async () => {
    const { dir, rm } = tmp()
    try {
      const harvests = join(dir, '.agents', 'review-debt', 'harvests')
      mkdirSync(harvests, { recursive: true })
      writeFileSync(
        join(harvests, 'h1.jsonl'),
        `${JSON.stringify(FINDING)}\n${JSON.stringify({ ...FINDING, thread_id: 'thread-done-9', status: 'done', priority: 'nit' })}\n`
      )
      const debt = planes(dir).find((p) => p.name === 'debt')!
      assert.deepEqual(await debt.capabilities(), { read: true, collect: false, set: false })

      const all = await debt.list()
      assert.equal(all.length, 2)
      const open = await debt.list({ status: 'open' })
      assert.equal(open.length, 1)
      const finding = open[0] as Finding
      // plane vocabulary — thread_id is the stable key, never a field name
      assert.equal(finding.id, 'thread-abc-123')
      assert.equal(finding.pr, 42)
      assert.equal(finding.priority, 'blocking')
      assert.ok(!('thread_id' in finding), 'row carries no backend noun field')

      assert.equal((await debt.get('thread-abc-123'))?.id, 'thread-abc-123')
      assert.equal(await debt.get('nope'), undefined)

      const next = (await debt.read('next')) as Finding | null
      assert.equal(next?.id, 'thread-abc-123')
      const summary = (await debt.read('summary')) as { open_count?: number }
      assert.equal(typeof summary.open_count, 'number')
      assert.equal(summary.open_count, 1)
    } finally {
      rm()
    }
  })

  test('empty ledger is a valid zero — next: null, list: []', async () => {
    const { dir, rm } = tmp()
    try {
      const debt = planes(dir).find((p) => p.name === 'debt')!
      assert.deepEqual(await debt.list(), [])
      assert.equal(await debt.read('next'), null)
    } finally {
      rm()
    }
  })
})

describe('events plane adapter', () => {
  /** tmp git repo + isolated XDG mailbox so the test's drops are the
   *  only ones visible; restores both env vars it moves. */
  const withMailbox = (
    drops: Record<string, string>,
    fn: (tail: (args?: Record<string, unknown>) => Promise<unknown>) => Promise<void>
  ): Promise<void> => {
    const { dir, rm } = tmp()
    const xdg = mkdtempSync(join(tmpdir(), 'bro-planes-xdg-'))
    const savedXdg = process.env.XDG_STATE_HOME
    const savedAgent = process.env.BRO_AGENT_ID
    process.env.XDG_STATE_HOME = xdg
    delete process.env.BRO_AGENT_ID
    return (async () => {
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir })
        const mb = join(dir, '.git', 'bro', 'notify')
        mkdirSync(mb, { recursive: true })
        for (const [name, text] of Object.entries(drops)) {
          writeFileSync(join(mb, name), text)
        }
        const events = planes(dir).find((p) => p.name === 'events')!
        await fn((a) => events.read('tail', a) as Promise<unknown>)
      } finally {
        if (savedXdg === undefined) delete process.env.XDG_STATE_HOME
        else process.env.XDG_STATE_HOME = savedXdg
        if (savedAgent === undefined) delete process.env.BRO_AGENT_ID
        else process.env.BRO_AGENT_ID = savedAgent
        rmSync(xdg, { recursive: true, force: true })
        rm()
      }
    })()
  }

  test('a drop addressed to another session is not this reader\'s event', async () => {
    await withMailbox(
      {
        'note-1000-aaaa.txt': 'plain broadcast',
        'note-1001-bbbb.txt': JSON.stringify({
          topic: 'act',
          kind: 'block',
          to: 'ses-other',
          payload: 'not yours',
        }),
        'note-1002-cccc.txt': JSON.stringify({
          topic: 'act',
          kind: 'note',
          to: 'orchestrator',
          payload: 'for the orchestrator',
        }),
      },
      async (tail) => {
        const res = (await tail({})) as { events: EventRow[] }
        const ids = res.events.map((e) => e.id)
        assert.ok(ids.includes('note-1000-aaaa.txt'), `broadcast visible: ${ids}`)
        assert.ok(
          ids.includes('note-1002-cccc.txt'),
          `orchestrator drop visible to an interactive session: ${ids}`
        )
        assert.ok(!ids.includes('note-1001-bbbb.txt'), `foreign drop hidden: ${ids}`)
      }
    )
  })

  test('tail truncation flags gapped — a partial replay is never complete', async () => {
    await withMailbox(
      {
        'note-1000-aaaa.txt': 'one',
        'note-1001-bbbb.txt': 'two',
        'note-1002-cccc.txt': 'three',
      },
      async (tail) => {
        const res = (await tail({ limit: 2 })) as { events: EventRow[]; gapped: boolean }
        assert.equal(res.events.length, 2)
        assert.equal(res.gapped, true)
      }
    )
  })
})
