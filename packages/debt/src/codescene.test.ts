import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SourceSkipped } from './collectors.ts'
import {
  codesceneDeltaIdOf,
  collectCodescene,
  dedupeCodesceneThreads,
  failedGates,
  parseAnalysisTime,
  resolveCodesceneProject,
} from './codescene.ts'
import { openThread, withEnv, withFakeCurl } from './testhttp.ts'
import type { DebtRecord } from './types.ts'

const CTX = { repo: 'acme/widgets', runId: 't', harvestedAt: '2026-01-02T00:00:00Z' }
const EMPTY_PAGE = '{"page":1,"max_pages":1,"delta_analyses":[]}'

const ANALYSIS = {
  id: 101,
  repository: 'acme/widgets',
  commits: ['abc123'],
  authors: ['dev@example.com'],
  analysistime: 1_767_225_600,
  code_health: 6.0,
  old_code_health: 7.5,
  failed_gates: { degrades_in_code_health: true, violates_goal: false },
}
const DETAIL = {
  ...ANALYSIS,
  file_results: [
    { file: 'src/app.ts', code_health: 5.0, old_code_health: 7.5 },
    { file: 'src/ok.ts', code_health: 9.0, old_code_health: 7.0 },
  ],
}
const listBody = (items: unknown[], page = 1, maxPages = 1) =>
  JSON.stringify({ page, max_pages: maxPages, delta_analyses: items })

describe('resolveCodesceneProject', () => {
  test('config project_id wins — number or string', () =>
    withEnv({ CODESCENE_PROJECT_ID: 'env_id' }, () => {
      assert.equal(resolveCodesceneProject({ project_id: 42 })?.projectId, '42')
      assert.equal(resolveCodesceneProject({ project_id: ' p7 ' })?.projectId, 'p7')
      assert.equal(resolveCodesceneProject({ project_id: 42 })?.via, 'config')
    }))

  test('env is the fallback; nothing → null', () => {
    const prev = process.env.CODESCENE_PROJECT_ID
    try {
      process.env.CODESCENE_PROJECT_ID = 'env9'
      assert.equal(resolveCodesceneProject({})?.projectId, 'env9')
      delete process.env.CODESCENE_PROJECT_ID
      assert.equal(resolveCodesceneProject({}), null)
    } finally {
      if (prev === undefined) delete process.env.CODESCENE_PROJECT_ID
      else process.env.CODESCENE_PROJECT_ID = prev
    }
  })

  test('a self-hosted host wins and carries the UI links', () => {
    const p = resolveCodesceneProject({ project_id: 1, host: 'https://cs.internal/' })
    assert.equal(p?.host, 'https://cs.internal')
    assert.equal(p?.uiHost, 'https://cs.internal')
    const d = resolveCodesceneProject({ project_id: 1 })
    assert.equal(d?.host, 'https://api.codescene.io')
    assert.equal(d?.uiHost, 'https://codescene.io')
  })
})

describe('failedGates', () => {
  test('object keys with truthy values only', () => {
    assert.deepEqual(failedGates({ a: true, b: false, c: { detail: 1 } }), ['a', 'c'])
  })
  test('arrays, strings and empties', () => {
    assert.deepEqual(failedGates(['x', { y: true, z: false }]), ['x', 'y'])
    assert.deepEqual(failedGates('gate_one'), ['gate_one'])
    assert.deepEqual(failedGates({}), [])
    assert.deepEqual(failedGates(null), [])
    assert.deepEqual(failedGates(undefined), [])
    assert.deepEqual(failedGates(''), [])
  })
})

describe('parseAnalysisTime', () => {
  test('epoch seconds and milliseconds normalize to ISO', () => {
    assert.equal(parseAnalysisTime(1_767_225_600, 'F'), '2026-01-01T00:00:00.000Z')
    assert.equal(parseAnalysisTime(1_767_225_600_000, 'F'), '2026-01-01T00:00:00.000Z')
  })
  test('ISO strings pass through; junk falls back', () => {
    assert.equal(parseAnalysisTime('2026-01-01T01:00:00Z', 'F'), '2026-01-01T01:00:00.000Z')
    assert.equal(parseAnalysisTime('not a date', 'F'), 'F')
    assert.equal(parseAnalysisTime(undefined, 'F'), 'F')
  })
})

describe('collectCodescene', () => {
  test('missing CODESCENE_TOKEN skips the source', () => {
    const prev = process.env.CODESCENE_TOKEN
    delete process.env.CODESCENE_TOKEN
    try {
      assert.throws(() => collectCodescene(CTX, { cfg: { project_id: 1 } }), SourceSkipped)
    } finally {
      if (prev !== undefined) process.env.CODESCENE_TOKEN = prev
    }
  })

  test('no project id anywhere skips the source', () =>
    withEnv({ CODESCENE_TOKEN: 'cs_test', CODESCENE_PROJECT_ID: '' }, () => {
      delete process.env.CODESCENE_PROJECT_ID
      assert.throws(() => collectCodescene(CTX, { cfg: {} }), /project id/)
    }))

  test('a failed gate + a declined file map to rows', () =>
    withEnv({ CODESCENE_TOKEN: 'cs_test' }, () =>
      withFakeCurl(
        {
          'delta-analyses/101': JSON.stringify(DETAIL),
          'delta-analyses?page=1': listBody([ANALYSIS]),
        },
        EMPTY_PAGE,
        () => {
          const rows = collectCodescene(CTX, { cfg: { project_id: 9 } })
          const gate = rows.find((r) => r.thread_id === 'codescene:101:gate:degrades_in_code_health')!
          assert.equal(gate.source, 'codescene')
          assert.equal(gate.priority, 'blocking')
          assert.equal(gate.author, 'dev@example.com')
          assert.match(gate.body, /7\.5 → 6/)
          assert.match(gate.thread_url, /codescene\.io\/projects\/9\/delta-analysis\/101/)
          const file = rows.find((r) => r.thread_id === 'codescene:101:file:src/app.ts')!
          assert.equal(file.priority, 'scan')
          assert.equal(file.path, 'src/app.ts')
          assert.match(file.body, /7\.5 → 5/)
          assert.equal(rows.length, 2) // src/ok.ts improved — no row
          assert.equal(rows[0]!.merged_at, '2026-01-01T00:00:00.000Z')
        }
      )
    ))

  test('a clean analysis emits nothing and never fetches detail', () =>
    withEnv({ CODESCENE_TOKEN: 'cs_test' }, () =>
      withFakeCurl(
        {
          // no detail key — a fetch for it would hit the empty-page fallback
          // and the row count assertion would catch a phantom record
          'delta-analyses?page=1': listBody([
            { ...ANALYSIS, id: 55, failed_gates: {}, code_health: 8.0, old_code_health: 7.0 },
          ]),
        },
        EMPTY_PAGE,
        () => {
          assert.equal(collectCodescene(CTX, { cfg: { project_id: 9 } }).length, 0)
        }
      )
    ))

  test('pages follow max_pages', () =>
    withEnv({ CODESCENE_TOKEN: 'cs_test' }, () =>
      withFakeCurl(
        {
          'delta-analyses/1': JSON.stringify({ ...ANALYSIS, id: 1 }),
          'delta-analyses?page=1': listBody([{ ...ANALYSIS, id: 1 }], 1, 2),
          'delta-analyses?page=2': listBody([{ ...ANALYSIS, id: 2 }], 2, 2),
          'delta-analyses/2': JSON.stringify({ ...ANALYSIS, id: 2 }),
        },
        EMPTY_PAGE,
        () => {
          const ids = collectCodescene(CTX, { cfg: { project_id: 9 } })
            .map((r) => r.thread_id)
            .sort()
          assert.deepEqual(ids, [
            'codescene:1:gate:degrades_in_code_health',
            'codescene:2:gate:degrades_in_code_health',
          ])
        }
      )
    ))

  test('a result set past the page cap fails instead of truncating', () =>
    withEnv({ CODESCENE_TOKEN: 'cs_test' }, () =>
      withFakeCurl(
        {
          'delta-analyses?page=': listBody([{ ...ANALYSIS, id: 1 }], 1, 21),
        },
        EMPTY_PAGE,
        () =>
          assert.throws(
            () => collectCodescene(CTX, { cfg: { project_id: 9 } }),
            /partial fetch/
          )
      )
    ))
})

describe('dedupeCodesceneThreads', () => {
  const codescene = (id: string): DebtRecord =>
    ({
      thread_id: `codescene:${id}:file:src/a.ts`,
      path: 'src/a.ts',
      line: null,
      status: 'open',
      source: 'codescene',
      body: 'b',
    }) as DebtRecord
  const thread = openThread

  test('a delta-analysis link in the thread body covers', () => {
    const d = dedupeCodesceneThreads(
      [codescene('101')],
      [thread({ body: 'verdict: https://codescene.io/projects/9/delta-analysis/101' })]
    )
    assert.equal(d.kept.length, 0)
    assert.equal(d.duped[0]!.coveredBy, 'PRRT_1')
  })

  test('the plural path segment covers too', () => {
    const d = dedupeCodesceneThreads(
      [codescene('101')],
      [thread({ body: 'api: api.codescene.io/v2/projects/9/delta-analyses/101' })]
    )
    assert.equal(d.kept.length, 0)
  })

  test('same path alone and bare id mentions do not cover', () => {
    const d = dedupeCodesceneThreads(
      [codescene('101'), codescene('102')],
      [
        thread({ path: 'src/a.ts' }), // path alone — a human comment must not suppress
        { ...thread({ body: 'codescene 102 is degraded' }), thread_id: 'PRRT_2' },
      ]
    )
    assert.equal(d.kept.length, 2)
  })
})

describe('codesceneDeltaIdOf', () => {
  test('reads the id from both row shapes', () => {
    assert.equal(codesceneDeltaIdOf('codescene:7:gate:degrades'), '7')
    assert.equal(codesceneDeltaIdOf('codescene:7:file:src/a.ts'), '7')
    assert.equal(codesceneDeltaIdOf('codescene:7'), '')
  })
})
