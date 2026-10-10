import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceSkipped } from './collectors.ts'
import {
  assertSonarHostTrusted,
  collectSonarcloud,
  dedupeReviewThreads,
  parseSonarProperties,
  resolveSonarProject,
  sonarKeyOf,
} from './sonarcloud.ts'
import type { DebtRecord } from './types.ts'
import type { SonarProject } from './sonarcloud.ts'

const CTX = { repo: 'acme/widgets', runId: 't', harvestedAt: '2026-01-02T00:00:00Z' }

/** Scripted curl on PATH — answers by URL substring via a JSON map file.
 *  Absent key → `{"paging":{"total":0}}` so paging loops terminate. */
function withFakeCurl(cases: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-curl-'))
  const mapPath = join(dir, 'map.json')
  writeFileSync(mapPath, JSON.stringify(cases))
  writeFileSync(
    join(dir, 'curl'),
    [
      '#!/usr/bin/env node',
      'const map = JSON.parse(require("fs").readFileSync(process.env.FAKE_CURL_MAP, "utf8"))',
      'const args = process.argv.slice(2).join(" ")',
      'for (const [k, v] of Object.entries(map)) {',
      '  if (args.includes(k)) { console.log(v); process.exit(0) }',
      '}',
      'console.log("{\\"paging\\":{\\"total\\":0}}")',
    ].join('\n')
  )
  chmodSync(join(dir, 'curl'), 0o755)
  const prevPath = process.env.PATH
  const prevMap = process.env.FAKE_CURL_MAP
  process.env.PATH = `${dir}:${prevPath}`
  process.env.FAKE_CURL_MAP = mapPath
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    if (prevMap === undefined) {
      delete process.env.FAKE_CURL_MAP
    } else {
      process.env.FAKE_CURL_MAP = prevMap
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** SONAR_TOKEN set for fn, restored after — the skip path is tested by
 *  deleting it explicitly. */
function withToken(fn: () => void): void {
  const prev = process.env.SONAR_TOKEN
  process.env.SONAR_TOKEN = 'squ_test'
  try {
    fn()
  } finally {
    if (prev === undefined) {
      delete process.env.SONAR_TOKEN
    } else {
      process.env.SONAR_TOKEN = prev
    }
  }
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-sonar-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ISSUE = {
  key: 'AXabc',
  rule: 'typescript:S4325',
  severity: 'CRITICAL',
  component: 'acme_widgets:src/app.ts',
  line: 42,
  message: 'Reduce this function',
  creationDate: '2026-01-01T00:00:00Z',
}
const HOTSPOT = {
  key: 'HXdef',
  component: 'acme_widgets:src/auth.ts',
  line: 7,
  message: 'Review this crypto use',
  vulnerabilityProbability: 'HIGH',
  creationDate: '2026-01-01T00:00:00Z',
}

const issuesBody = (issues: unknown[], total = issues.length, comps: unknown[] = []) =>
  JSON.stringify({ paging: { total }, issues, components: comps })
const hotspotsBody = (hotspots: unknown[], total = hotspots.length, comps: unknown[] = []) =>
  JSON.stringify({ paging: { total }, hotspots, components: comps })

describe('parseSonarProperties', () => {
  test('reads projectKey + host, skips comments, trims trailing slash', () => {
    const p = parseSonarProperties(
      '# comment\nsonar.projectKey=acme_widgets\nsonar.host.url=https://sonar.example.com/\n! bang\nsonar.other=x\n'
    )
    assert.equal(p.projectKey, 'acme_widgets')
    assert.equal(p.host, 'https://sonar.example.com')
  })
})

describe('resolveSonarProject', () => {
  test('config project_key wins over the properties file', () =>
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'sonar-project.properties'), 'sonar.projectKey=from_props\n')
      const p = resolveSonarProject(dir, { project_key: 'from_cfg' })
      assert.equal(p?.projectKey, 'from_cfg')
      assert.equal(p?.via, 'config')
      assert.equal(p?.host, 'https://sonarcloud.io')
    }))

  test('properties file supplies key + host', () =>
    withTmpDir((dir) => {
      writeFileSync(
        join(dir, 'sonar-project.properties'),
        'sonar.projectKey=pk\nsonar.host.url=https://sq.internal\n'
      )
      const p = resolveSonarProject(dir, {})
      assert.equal(p?.projectKey, 'pk')
      assert.equal(p?.host, 'https://sq.internal')
      assert.equal(p?.via, 'properties')
    }))

  test('nothing resolves → null', () =>
    withTmpDir((dir) => {
      assert.equal(resolveSonarProject(dir, {}), null)
    }))
})

describe('collectSonarcloud', () => {
  test('missing SONAR_TOKEN skips the source', () =>
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'sonar-project.properties'), 'sonar.projectKey=pk\n')
      const prev = process.env.SONAR_TOKEN
      delete process.env.SONAR_TOKEN
      try {
        assert.throws(() => collectSonarcloud(CTX, { dir }), SourceSkipped)
      } finally {
        if (prev !== undefined) process.env.SONAR_TOKEN = prev
      }
    }))

  test('no project key anywhere skips the source', () =>
    withTmpDir((dir) =>
      withToken(() => {
        assert.throws(() => collectSonarcloud(CTX, { dir }), /project key/)
      })
    ))

  test('issues + hotspots map to stable rows', () =>
    withTmpDir((dir) =>
      withToken(() =>
        withFakeCurl(
          {
            'issues/search': issuesBody([ISSUE], 1, [
              { key: 'acme_widgets:src/app.ts', path: 'src/app.ts' },
            ]),
            'hotspots/search': hotspotsBody([HOTSPOT], 1, [
              { key: 'acme_widgets:src/auth.ts', path: 'src/auth.ts' },
            ]),
          },
          () => {
            const rows = collectSonarcloud(CTX, { dir, cfg: { project_key: 'pk' } })
            assert.equal(rows.length, 2)
            const issue = rows.find((r) => r.thread_id === 'sonarcloud:AXabc')!
            assert.equal(issue.source, 'sonarcloud')
            assert.equal(issue.priority, 'blocking') // CRITICAL
            assert.equal(issue.path, 'src/app.ts')
            assert.equal(issue.line, 42)
            assert.match(issue.body, /typescript:S4325/)
            assert.match(issue.thread_url, /open=AXabc/)
            const spot = rows.find((r) => r.thread_id === 'sonarcloud:hotspot:HXdef')!
            assert.equal(spot.priority, 'blocking') // HIGH probability
            assert.equal(spot.path, 'src/auth.ts')
          }
        )
      )
    ))

  test('MAJOR severity → scan, MINOR → nit, LOW hotspot → nit', () =>
    withTmpDir((dir) =>
      withToken(() =>
        withFakeCurl(
          {
            'issues/search': issuesBody([
              { ...ISSUE, key: 'A1', severity: 'MAJOR' },
              { ...ISSUE, key: 'A2', severity: 'MINOR' },
            ]),
            'hotspots/search': hotspotsBody([
              { ...HOTSPOT, key: 'H1', vulnerabilityProbability: 'LOW' },
              { ...HOTSPOT, key: 'H2', vulnerabilityProbability: 'MEDIUM' },
            ]),
          },
          () => {
            const rows = collectSonarcloud(CTX, { dir, cfg: { project_key: 'pk' } })
            const pri = new Map(rows.map((r) => [r.thread_id, r.priority]))
            assert.equal(pri.get('sonarcloud:A1'), 'scan')
            assert.equal(pri.get('sonarcloud:A2'), 'nit')
            assert.equal(pri.get('sonarcloud:hotspot:H1'), 'nit')
            assert.equal(pri.get('sonarcloud:hotspot:H2'), 'scan')
          }
        )
      )
    ))

  test('paging follows paging.total until every item is fetched', () =>
    withTmpDir((dir) =>
      withToken(() =>
        withFakeCurl(
          {
            // query strings end in …&ps=500&p=<n> — page-specific keys
            '&p=1': issuesBody([{ ...ISSUE, key: 'P1' }], 2),
            '&p=2': issuesBody([{ ...ISSUE, key: 'P2' }], 2),
          },
          () => {
            const ids = collectSonarcloud(CTX, { dir, cfg: { project_key: 'pk' } })
              .map((r) => r.thread_id)
              .sort()
            assert.deepEqual(ids, ['sonarcloud:P1', 'sonarcloud:P2'])
          }
        )
      )
    ))

  test('component prefix strips when components[] is absent', () =>
    withTmpDir((dir) =>
      withToken(() =>
        withFakeCurl(
          {
            'issues/search': issuesBody([
              { ...ISSUE, component: 'pk:lib/x.ts', line: undefined },
            ]),
          },
          () => {
            const r = collectSonarcloud(CTX, { dir, cfg: { project_key: 'pk' } })[0]!
            assert.equal(r.path, 'lib/x.ts')
            assert.equal(r.line, null)
          }
        )
      )
    ))

  test('a result set past the API window fails instead of truncating', () =>
    withTmpDir((dir) =>
      withToken(() =>
        withFakeCurl(
          { 'issues/search': issuesBody([ISSUE], 20_001) },
          () =>
            assert.throws(
              () => collectSonarcloud(CTX, { dir, cfg: { project_key: 'pk' } }),
              /partial fetch/
            )
        )
      )
    ))

  test('a properties-file host off sonarcloud.io skips before any request', () =>
    withTmpDir((dir) => {
      writeFileSync(
        join(dir, 'sonar-project.properties'),
        'sonar.projectKey=pk\nsonar.host.url=https://evil.example\n'
      )
      withToken(() =>
        assert.throws(() => collectSonarcloud(CTX, { dir }), SourceSkipped)
      )
    }))
})

describe('assertSonarHostTrusted', () => {
  const proj = (
    host: string,
    hostVia: 'config' | 'properties' | 'default'
  ): SonarProject => ({ projectKey: 'pk', host, via: 'properties', hostVia })

  test('a non-default host from a properties file is refused', () => {
    assert.throws(
      () => assertSonarHostTrusted(proj('https://sq.internal', 'properties')),
      SourceSkipped
    )
    assert.throws(
      () => assertSonarHostTrusted(proj('https://sonarcloud.io.evil.com', 'properties')),
      SourceSkipped
    )
  })

  test('the same host asserted in config is trusted', () => {
    assertSonarHostTrusted(proj('https://sq.internal', 'config'))
  })

  test('non-loopback http is refused even from config', () => {
    assert.throws(
      () => assertSonarHostTrusted(proj('http://sq.internal', 'config')),
      /cleartext/
    )
  })

  test('loopback http and the default host from properties are fine', () => {
    assertSonarHostTrusted(proj('http://localhost:9000', 'properties'))
    assertSonarHostTrusted(proj('https://sonarcloud.io', 'properties'))
    assertSonarHostTrusted(proj('https://sonarcloud.io', 'default'))
  })

  test('an unparseable host refuses', () => {
    assert.throws(
      () => assertSonarHostTrusted(proj('not a url', 'config')),
      SourceSkipped
    )
  })
})

describe('dedupeReviewThreads', () => {
  const sonar = (id: string, path = 'src/a.ts', line: number | null = 5): DebtRecord =>
    ({
      thread_id: `sonarcloud:${id}`,
      path,
      line,
      status: 'open',
      source: 'sonarcloud',
      body: 'b',
    }) as DebtRecord
  const thread = (over: Partial<DebtRecord>): DebtRecord =>
    ({
      thread_id: 'PRRT_1',
      status: 'open',
      path: '',
      line: null,
      body: '',
      ...over,
    }) as DebtRecord

  test('same path+line on an open review thread drops the sonar row', () => {
    const d = dedupeReviewThreads(
      [sonar('K1')],
      [thread({ path: 'src/a.ts', line: 5 })]
    )
    assert.equal(d.kept.length, 0)
    assert.equal(d.duped[0]!.coveredBy, 'PRRT_1')
  })

  test('issue key in the thread body drops the sonar row', () => {
    const d = dedupeReviewThreads(
      [sonar('K2', 'src/other.ts', 9)],
      [thread({ path: 'src/other.ts', line: 1, body: 'see https://sonarcloud.io/project/issues?open=K2&id=p' })]
    )
    assert.equal(d.kept.length, 0)
  })

  test('key embedded in a longer token does not cover the sonar row', () => {
    const rows = [sonar('K5', 'src/c.ts', 3)]
    const d = dedupeReviewThreads(rows, [
      thread({ path: 'src/c.ts', line: 1, body: 'see ?open=K55&id=p' }),
      { ...thread({ body: 'XK5 flagged elsewhere' }), thread_id: 'PRRT_2' },
      { ...thread({ body: 'dup of K5-9' }), thread_id: 'PRRT_3' },
    ])
    assert.equal(d.kept.length, 1)
    assert.equal(d.duped.length, 0)
  })

  test('whole-token key at a markdown-link boundary still covers', () => {
    const d = dedupeReviewThreads(
      [sonar('K6', 'src/c.ts', 3)],
      [thread({ path: 'src/c.ts', line: 1, body: '[open](https://sonarcloud.io/project/issues?open=K6)' })]
    )
    assert.equal(d.kept.length, 0)
    assert.equal(d.duped[0]!.coveredBy, 'PRRT_1')
  })

  test('a bare key mention in prose or code does not cover', () => {
    const d = dedupeReviewThreads(
      [sonar('K7', 'src/c.ts', 3), sonar('K9', 'src/c.ts', 3)],
      [
        thread({ path: 'src/c.ts', line: 1, body: 'K7 also flagged in docs/K7-notes' }),
        { ...thread({ body: 'the constant issues=K99 reminded me of K9' }), thread_id: 'PRRT_2' },
      ]
    )
    assert.equal(d.kept.length, 2)
    assert.equal(d.duped.length, 0)
  })

  test('key in an issues= link param covers', () => {
    const d = dedupeReviewThreads(
      [sonar('K8', 'src/c.ts', 3)],
      [thread({ path: 'src/c.ts', line: 1, body: 'see https://sq.internal/project/issues?id=p&issues=K8' })]
    )
    assert.equal(d.kept.length, 0)
    assert.equal(d.duped[0]!.coveredBy, 'PRRT_1')
  })

  test('non-matching rows keep; done/other-source rows do not dedupe', () => {
    const rows = [sonar('K3'), sonar('K4', 'src/b.ts', 8)]
    const d = dedupeReviewThreads(rows, [
      thread({ path: 'src/z.ts', line: 5 }),
      { ...thread({ path: 'src/b.ts', line: 8 }), status: 'done' as const },
      { ...thread({ path: 'src/a.ts', line: 5 }), source: 'code-scanning' },
    ])
    assert.equal(d.kept.length, 2)
    assert.equal(d.duped.length, 0)
  })
})

describe('sonarKeyOf', () => {
  test('strips both prefixes', () => {
    assert.equal(sonarKeyOf('sonarcloud:AX'), 'AX')
    assert.equal(sonarKeyOf('sonarcloud:hotspot:HX'), 'HX')
  })
})
