import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceSkipped } from './collectors.ts'
import {
  codacyKeyOf,
  collectCodacy,
  dedupeCodacyThreads,
  resolveCodacyRepo,
} from './codacy.ts'
import type { DebtRecord } from './types.ts'

const CTX = { repo: 'acme/widgets', runId: 't', harvestedAt: '2026-01-02T00:00:00Z' }

/** Scripted curl on PATH — answers by URL substring via a JSON map file.
 *  Absent key → `{"data":[]}` so paging loops terminate. */
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
      'console.log("{\\"data\\":[]}")',
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

/** Env vars set for fn, restored after — the skip path is tested by
 *  deleting them explicitly. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
}

const ISSUE = {
  issueId: 'issue_123',
  commitIssue: {
    patternInfo: { id: 'p1', level: 'Error', title: 'Avoid this' },
    toolInfo: { name: 'Semgrep' },
    filePath: 'src/app.ts',
    lineNumber: 42,
    message: 'Avoid this pattern',
    commitInfo: { timestamp: '2026-01-01T00:00:00Z' },
  },
}
const body = (data: unknown[], cursor?: string) =>
  JSON.stringify({ data, pagination: cursor === undefined ? {} : { cursor } })

describe('resolveCodacyRepo', () => {
  test('owner/repo splits at the last slash; defaults gh + api.codacy.com', () => {
    const r = resolveCodacyRepo('acme/widgets', {})
    assert.equal(r.org, 'acme')
    assert.equal(r.repo, 'widgets')
    assert.equal(r.provider, 'gh')
    assert.equal(r.host, 'https://api.codacy.com')
    assert.equal(r.uiHost, 'https://app.codacy.com')
  })

  test('gitlab subgroup keeps the full group path as the org', () => {
    const r = resolveCodacyRepo('group/sub/widgets', { provider: 'gl' })
    assert.equal(r.org, 'group/sub')
    assert.equal(r.repo, 'widgets')
    assert.equal(r.provider, 'gl')
  })

  test('a self-hosted host wins and carries the UI links', () => {
    const r = resolveCodacyRepo('acme/widgets', { host: 'https://codacy.internal/' })
    assert.equal(r.host, 'https://codacy.internal')
    assert.equal(r.uiHost, 'https://codacy.internal')
  })
})

describe('collectCodacy', () => {
  test('missing both tokens skips the source', () =>
    withEnv({ CODACY_API_TOKEN: '', CODACY_PROJECT_TOKEN: '' }, () => {
      delete process.env.CODACY_API_TOKEN
      delete process.env.CODACY_PROJECT_TOKEN
      assert.throws(() => collectCodacy(CTX, {}), SourceSkipped)
    }))

  test('issues map to stable rows; level maps priority', () =>
    withEnv({ CODACY_API_TOKEN: 'ct_test' }, () =>
      withFakeCurl(
        {
          'issues/search': body([
            ISSUE,
            {
              ...ISSUE,
              issueId: 'issue_warn',
              commitIssue: { ...ISSUE.commitIssue, patternInfo: { level: 'Warning' } },
            },
            {
              ...ISSUE,
              issueId: 'issue_info',
              commitIssue: { ...ISSUE.commitIssue, patternInfo: { level: 'Info' } },
            },
          ]),
        },
        () => {
          const rows = collectCodacy(CTX)
          assert.equal(rows.length, 3)
          const err = rows.find((r) => r.thread_id === 'codacy:issue_123')!
          assert.equal(err.source, 'codacy')
          assert.equal(err.priority, 'blocking')
          assert.equal(err.path, 'src/app.ts')
          assert.equal(err.line, 42)
          assert.match(err.body, /\[Error\] Semgrep: Avoid this/)
          assert.match(err.thread_url, /app\.codacy\.com\/gh\/acme\/widgets\/issues/)
          const pri = new Map(rows.map((r) => [r.thread_id, r.priority]))
          assert.equal(pri.get('codacy:issue_warn'), 'scan')
          assert.equal(pri.get('codacy:issue_info'), 'nit')
        }
      )
    ))

  test('a repo-scoped token alone also authorizes', () =>
    withEnv({ CODACY_PROJECT_TOKEN: 'cpt_test' }, () => {
      delete process.env.CODACY_API_TOKEN
      withFakeCurl({ 'issues/search': body([ISSUE]) }, () => {
        const rows = collectCodacy(CTX)
        assert.equal(rows.length, 1)
      })
    }))

  // map order matters — the fake answers the FIRST matching key, so the
  // page-2-only substring must precede the key every URL contains
  test('cursor pagination follows until the cursor runs out', () =>
    withEnv({ CODACY_API_TOKEN: 't' }, () =>
      withFakeCurl(
        {
          'cursor=c2': body([{ ...ISSUE, issueId: 'P2' }]),
          'issues/search': body([{ ...ISSUE, issueId: 'P1' }], 'c2'),
        },
        () => {
          const ids = collectCodacy(CTX)
            .map((r) => r.thread_id)
            .sort()
          assert.deepEqual(ids, ['codacy:P1', 'codacy:P2'])
        }
      )
    ))

  test('a repeating cursor terminates instead of looping', () =>
    withEnv({ CODACY_API_TOKEN: 't' }, () =>
      withFakeCurl(
        {
          'cursor=cX': body([{ ...ISSUE, issueId: 'P2' }], 'cX'),
          'issues/search': body([{ ...ISSUE, issueId: 'P1' }], 'cX'),
        },
        () => {
          const ids = collectCodacy(CTX)
            .map((r) => r.thread_id)
            .sort()
          assert.deepEqual(ids, ['codacy:P1', 'codacy:P2'])
        }
      )
    ))

  test('unkeyed issues are dropped — they cannot dedup across collects', () =>
    withEnv({ CODACY_API_TOKEN: 't' }, () =>
      withFakeCurl(
        { 'issues/search': body([{ commitIssue: ISSUE.commitIssue }, ISSUE]) },
        () => {
          const rows = collectCodacy(CTX)
          assert.equal(rows.length, 1)
          assert.equal(rows[0]!.thread_id, 'codacy:issue_123')
        }
      )
    ))

  test('a non-loopback http host skips before any request', () =>
    withEnv({ CODACY_API_TOKEN: 't' }, () =>
      assert.throws(
        () => collectCodacy(CTX, { cfg: { host: 'http://codacy.internal' } }),
        /cleartext/
      )
    ))
})

describe('dedupeCodacyThreads', () => {
  const codacy = (id: string, path = 'src/a.ts', line: number | null = 5): DebtRecord =>
    ({
      thread_id: `codacy:${id}`,
      path,
      line,
      status: 'open',
      source: 'codacy',
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

  test('same path+line on an open review thread drops the codacy row', () => {
    const d = dedupeCodacyThreads([codacy('I1')], [thread({ path: 'src/a.ts', line: 5 })])
    assert.equal(d.kept.length, 0)
    assert.equal(d.duped[0]!.coveredBy, 'PRRT_1')
  })

  test('issueId in a link param covers', () => {
    const d = dedupeCodacyThreads(
      [codacy('I2', 'src/other.ts', 9)],
      [thread({ path: 'src/other.ts', line: 1, body: 'see https://app.codacy.com/gh/o/r/issues?issueId=I2&x=1' })]
    )
    assert.equal(d.kept.length, 0)
  })

  test('a bare id mention in prose does not cover', () => {
    const d = dedupeCodacyThreads(
      [codacy('I3', 'src/c.ts', 3)],
      [thread({ path: 'src/c.ts', line: 1, body: 'codacy flagged I3 here too' })]
    )
    assert.equal(d.kept.length, 1)
  })

  test('done/other-source rows do not dedupe', () => {
    const d = dedupeCodacyThreads([codacy('I4')], [
      { ...thread({ path: 'src/a.ts', line: 5 }), status: 'done' as const },
      { ...thread({ path: 'src/a.ts', line: 5 }), source: 'code-scanning', thread_id: 'X' },
    ])
    assert.equal(d.kept.length, 1)
  })
})

describe('codacyKeyOf', () => {
  test('strips the prefix', () => {
    assert.equal(codacyKeyOf('codacy:issue_9'), 'issue_9')
  })
})
