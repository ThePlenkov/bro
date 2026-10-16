/** Plane catalog contract tests — every registered plane is a real
 *  descriptor (declared reads dispatch, undeclared names throw, verbs
 *  are declared-but-unwired), and the debt plane's adapter reads a real
 *  ledger in a tmp dir. */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  busPublish,
  busSocketPath,
  planes,
  scrubEnv,
  startBusBrokerAt,
  PlaneUnavailable,
  PlaneVerbError,
  testGit,
  type EventRow,
  type Finding,
} from '@broject/core'
import { agentEventLine } from './events.ts'
// registration side-effect — the catalog is empty without it
import './index.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

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
        testGit(['init', '-q'], { cwd: dir })
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

describe('events plane — durable lifecycle journal', () => {
  const LIFE_ROWS = [
    { ts: '2026-01-01T00:00:01Z', kind: 'claim', bead: 'bro-a', actor: 'x', session: 's', from: 'open', to: 'in_progress' },
    { ts: '2026-01-01T00:00:02Z', kind: 'spawn', bead: 'bro-a', actor: 'x', session: 's', to: 'spawned' },
    { ts: '2026-01-01T00:00:03Z', kind: 'merge', bead: 'bro-a', pr: 9, actor: 'x', session: 's', to: 'merged' },
  ]

  /** tmp git repo + journal rows + isolated XDG — the plane under test
   *  sees exactly these rows and nothing ambient. */
  const withJournal = async (
    rows: object[],
    fn: (events: ReturnType<typeof planes>[number]) => Promise<void>
  ): Promise<void> => {
    const { dir, rm } = tmp()
    const xdg = mkdtempSync(join(tmpdir(), 'bro-planes-xdg-'))
    const savedXdg = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = xdg
    try {
      testGit(['init', '-q'], { cwd: dir })
      const bro = join(dir, '.git', 'bro')
      mkdirSync(bro, { recursive: true })
      writeFileSync(join(bro, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
      await fn(planes(dir).find((p) => p.name === 'events')!)
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = savedXdg
      rmSync(xdg, { recursive: true, force: true })
      rm()
    }
  }

  test('lifecycle read returns life:<seq> rows in order, filtered', async () => {
    await withJournal(LIFE_ROWS, async (events) => {
      const res = (await events.read('lifecycle', {})) as { events: EventRow[]; gapped: boolean }
      assert.equal(res.events.length, 3)
      assert.deepEqual(
        res.events.map((e) => e.id),
        ['life:1', 'life:2', 'life:3']
      )
      assert.equal(res.events[0]!.origin, 'lifecycle')
      const filtered = (await events.read('lifecycle', { kind: 'merge', pr: 9 })) as {
        events: EventRow[]
      }
      assert.equal(filtered.events.length, 1)
      assert.equal(filtered.events[0]!.id, 'life:3')
      const since = (await events.read('lifecycle', { since: '2026-01-01T00:00:01Z' })) as {
        events: EventRow[]
      }
      assert.equal(since.events.length, 2)
    })
  })

  test('lifecycle rows merge into tail beside mailbox drops', async () => {
    await withJournal(LIFE_ROWS, async (events) => {
      const res = (await events.read('tail', {})) as { events: EventRow[] }
      const life = res.events.filter((e) => e.origin === 'lifecycle')
      assert.equal(life.length, 3)
      assert.equal(life[0]!.kind, 'claim')
      assert.equal(res.events.at(-1)!.id, 'life:3')
    })
  })

  test('get resolves a life:<seq> id; capabilities.read counts the journal', async () => {
    await withJournal(LIFE_ROWS, async (events) => {
      const row = (await events.get('life:2')) as EventRow | undefined
      assert.equal(row?.kind, 'spawn')
      const caps = (await events.capabilities()) as { read: boolean }
      assert.equal(caps.read, true)
    })
  })

  test('no journal still serves — empty read, not an error', async () => {
    const { dir, rm } = tmp()
    try {
      testGit(['init', '-q'], { cwd: dir })
      const events = planes(dir).find((p) => p.name === 'events')!
      const res = (await events.read('lifecycle', {})) as { events: EventRow[]; gapped: boolean }
      assert.deepEqual(res.events, [])
      assert.equal(res.gapped, false)
    } finally {
      rm()
    }
  })
})

describe('agentEventLine', () => {
  test('each kind folds to one "agent last did X" line', () => {
    assert.equal(
      agentEventLine({ kind: 'turn', key: 'w1', payload: { phase: 'start' } }),
      'w1: turn started'
    )
    assert.equal(
      agentEventLine({
        kind: 'turn',
        key: 'w1',
        payload: { phase: 'stop', stopReason: 'end_turn' },
      }),
      'w1: turn stopped (end_turn)'
    )
    assert.equal(
      agentEventLine({ kind: 'turn', key: 'w1', payload: { phase: 'stop', error: 'boom' } }),
      'w1: turn failed — boom'
    )
    assert.equal(
      agentEventLine({
        kind: 'tool_call',
        key: 'w1',
        payload: { phase: 'open', title: 'Read src/foo.ts', kind: 'read' },
      }),
      'w1: Read src/foo.ts started [read]'
    )
    assert.equal(
      agentEventLine({
        kind: 'tool_call',
        key: 'w1',
        payload: { phase: 'finish', toolCallId: 'tc-1', status: 'failed' },
      }),
      'w1: tc-1 finished (failed)'
    )
    assert.equal(
      agentEventLine({
        kind: 'subagent',
        key: 'w1',
        payload: { phase: 'open', title: 'researcher' },
      }),
      'w1: subagent researcher open'
    )
    assert.equal(
      agentEventLine({
        kind: 'usage',
        key: 'w1',
        payload: { used: 100, size: 200 },
      }),
      'w1: context 100/200'
    )
    // a newer payload shape degrades to its discriminator, never throws
    assert.equal(agentEventLine({ kind: 'tool_call', key: 'w1', payload: null }), 'w1: tool finished')
    assert.equal(agentEventLine({ kind: 'mystery', key: 'w1' }), 'w1: mystery')
    assert.equal(agentEventLine({ kind: 'turn' }), 'agent: turn stopped')
  })
})

describe('events plane — activity read', () => {
  test('activity probes the agent topic and folds the newest row per key', async () => {
    const { dir, rm } = tmp()
    try {
      testGit(['init', '-q'], { cwd: dir })
      const broker = await startBusBrokerAt(busSocketPath(dir)!)
      try {
        await busPublish(busSocketPath(dir)!, {
          topic: 'agent',
          kind: 'turn',
          key: 'w1',
          payload: { phase: 'start' },
        })
        await busPublish(busSocketPath(dir)!, {
          topic: 'agent',
          kind: 'tool_call',
          key: 'w1',
          payload: { phase: 'open', title: 'Edit x.ts', kind: 'edit' },
        })
        // a non-agent topic sharing the key must not leak into activity
        await busPublish(busSocketPath(dir)!, {
          topic: 'notify',
          kind: 'note',
          key: 'w1',
          payload: 'unrelated',
        })
        await busPublish(busSocketPath(dir)!, {
          topic: 'agent',
          kind: 'turn',
          key: 'w2',
          payload: { phase: 'stop', stopReason: 'end_turn' },
        })

        const events = planes(dir).find((p) => p.name === 'events')!
        const res = (await events.read('activity', {})) as {
          events: EventRow[]
          latest: Record<string, string>
        }
        assert.deepEqual(res.latest, {
          w1: 'w1: Edit x.ts started [edit]',
          w2: 'w2: turn stopped (end_turn)',
        })
        assert.equal(res.events.length, 3)

        // the agent arg narrows broker-side to one subject key
        const scoped = (await events.read('activity', { agent: 'w2' })) as {
          events: EventRow[]
          latest: Record<string, string>
        }
        assert.deepEqual(Object.keys(scoped.latest), ['w2'])
        assert.equal(scoped.events.length, 1)
      } finally {
        await broker.close()
      }
    } finally {
      rm()
    }
  })

  test('a brokerless repo reads empty, never throws', async () => {
    const { dir, rm } = tmp()
    try {
      testGit(['init', '-q'], { cwd: dir })
      const events = planes(dir).find((p) => p.name === 'events')!
      const res = (await events.read('activity', {})) as { events: EventRow[] }
      assert.deepEqual(res.events, [])
    } finally {
      rm()
    }
  })
})
