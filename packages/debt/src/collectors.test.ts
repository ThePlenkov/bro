import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectCodeScanning,
  collectDependabot,
  collectFailedCi,
  collectSecretScanning,
  collectStalePrs,
  parseSources,
  resolvedThreadIds,
} from './collectors.ts'
import type { DebtRecord } from './types.ts'

const CTX = { repo: 'acme/widgets', runId: 't', harvestedAt: '2026-01-02T00:00:00Z' }

/** Scripted gh on PATH — answers by argv substring via a JSON map file. */
function withFakeGh(cases: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-gh-'))
  const mapPath = join(dir, 'map.json')
  writeFileSync(mapPath, JSON.stringify(cases))
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env node',
      'const map = JSON.parse(require("fs").readFileSync(process.env.FAKE_GH_MAP, "utf8"))',
      'const args = process.argv.slice(2).join(" ")',
      'for (const [k, v] of Object.entries(map)) {',
      '  if (args.includes(k)) { console.log(v); process.exit(0) }',
      '}',
      'console.log("[]")',
    ].join('\n')
  )
  chmodSync(join(dir, 'gh'), 0o755)
  const prevPath = process.env.PATH
  const prevMap = process.env.FAKE_GH_MAP
  process.env.PATH = `${dir}:${prevPath}`
  process.env.FAKE_GH_MAP = mapPath
  try {
    fn()
  } finally {
    process.env.PATH = prevPath
    if (prevMap === undefined) {
      delete process.env.FAKE_GH_MAP
    } else {
      process.env.FAKE_GH_MAP = prevMap
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const DEPENDABOT_ALERT = {
  number: 7,
  html_url: 'https://github.com/acme/widgets/security/dependabot/7',
  created_at: '2026-01-01T00:00:00Z',
  dependency: { manifest_path: 'packages/app/package.json' },
  security_vulnerability: {
    severity: 'high',
    package: { name: 'lodash' },
    summary: 'Prototype pollution in lodash',
  },
}

describe('collectDependabot', () => {
  test('open alert → record with source + severity priority', () => {
    withFakeGh({ 'dependabot/alerts': JSON.stringify([DEPENDABOT_ALERT]) }, () => {
      const rows = collectDependabot(CTX)
      assert.equal(rows.length, 1)
      const r = rows[0]!
      assert.equal(r.thread_id, 'dependabot:7')
      assert.equal(r.source, 'dependabot')
      assert.equal(r.priority, 'blocking')
      assert.equal(r.path, 'packages/app/package.json')
    })
  })

  test('alert with an open dependabot PR is skipped (the PR is the work item)', () => {
    withFakeGh(
      {
        'dependabot/alerts': JSON.stringify([DEPENDABOT_ALERT]),
        'pr list': JSON.stringify([
          { number: 42, headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21', url: 'u' },
        ]),
      },
      () => {
        assert.equal(collectDependabot(CTX).length, 0)
      }
    )
  })

  test('medium severity maps to scan priority', () => {
    const a = { ...DEPENDABOT_ALERT, security_vulnerability: { ...DEPENDABOT_ALERT.security_vulnerability, severity: 'medium' } }
    withFakeGh({ 'dependabot/alerts': JSON.stringify([a]) }, () => {
      assert.equal(collectDependabot(CTX)[0]!.priority, 'scan')
    })
  })
})

describe('collectCodeScanning', () => {
  test('open alert maps rule + location', () => {
    const alert = {
      number: 3,
      html_url: 'u',
      created_at: '2026-01-01T00:00:00Z',
      rule: { id: 'js/xss', description: 'XSS sink', severity: 'error' },
      most_recent_instance: { location: { path: 'src/render.ts' } },
    }
    withFakeGh({ 'code-scanning/alerts': JSON.stringify([alert]) }, () => {
      const r = collectCodeScanning(CTX)[0]!
      assert.equal(r.thread_id, 'code-scanning:3')
      assert.equal(r.priority, 'blocking')
      assert.equal(r.path, 'src/render.ts')
    })
  })
})

describe('collectSecretScanning', () => {
  test('secret alert is always blocking', () => {
    const alert = { number: 1, html_url: 'u', created_at: 'x', secret_type: 'npm' }
    withFakeGh({ 'secret-scanning/alerts': JSON.stringify([alert]) }, () => {
      const r = collectSecretScanning(CTX)[0]!
      assert.equal(r.priority, 'blocking')
      assert.equal(r.thread_id, 'secret-scanning:1')
    })
  })
})

describe('collectStalePrs', () => {
  const stale = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const fresh = new Date().toISOString()

  test('idle > staleDays → nit row', () => {
    const pr = { number: 9, title: 'old', url: 'u', updatedAt: stale, isDraft: false, statusCheckRollup: [] }
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      const r = collectStalePrs(CTX, 14)[0]!
      assert.equal(r.thread_id, 'stale-pr:9')
      assert.equal(r.priority, 'nit')
      assert.match(r.body, /idle \d+d/)
    })
  })

  test('failing checks → blocking even when fresh', () => {
    const pr = {
      number: 10,
      title: 'red',
      url: 'u',
      updatedAt: fresh,
      isDraft: true,
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    }
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      assert.equal(collectStalePrs(CTX, 14)[0]!.priority, 'blocking')
    })
  })

  test('quiet WIP draft is not debt', () => {
    const pr = { number: 11, title: 'wip', url: 'u', updatedAt: stale, isDraft: true, statusCheckRollup: [] }
    withFakeGh({ 'pr list': JSON.stringify([pr]) }, () => {
      assert.equal(collectStalePrs(CTX, 14).length, 0)
    })
  })
})

describe('collectFailedCi', () => {
  test('latest default-branch run failed → one stable row', () => {
    withFakeGh(
      {
        'repos/acme/widgets"': '{"default_branch":"main"}',
        'actions/runs': JSON.stringify({
          workflow_runs: [{ id: 55, name: 'CI', html_url: 'u', conclusion: 'failure', created_at: 'x' }],
        }),
      },
      () => {
        const r = collectFailedCi(CTX)[0]!
        assert.equal(r.thread_id, 'failed-ci:main')
        assert.equal(r.priority, 'blocking')
      }
    )
  })

  test('green default branch → nothing', () => {
    withFakeGh(
      {
        'repos/acme/widgets"': '{"default_branch":"main"}',
        'actions/runs': JSON.stringify({
          workflow_runs: [{ id: 55, name: 'CI', html_url: 'u', conclusion: 'success', created_at: 'x' }],
        }),
      },
      () => {
        assert.equal(collectFailedCi(CTX).length, 0)
      }
    )
  })
})

describe('parseSources', () => {
  test('default is review-threads only', () => {
    assert.deepEqual(parseSources(undefined), ['review-threads'])
    assert.deepEqual(parseSources([]), ['review-threads'])
  })
  test('unknown sources drop out', () => {
    assert.deepEqual(parseSources(['dependabot', 'bogus']), ['dependabot'])
  })
})

describe('resolvedThreadIds', () => {
  const rec = (id: string, status = 'open'): DebtRecord =>
    ({ thread_id: id, status, source: 'dependabot' }) as DebtRecord

  test('open row absent from fresh fetch resolves upstream', () => {
    assert.deepEqual(resolvedThreadIds([rec('dependabot:1'), rec('dependabot:2')], 'dependabot', [rec('dependabot:1')]), ['dependabot:2'])
  })

  test('rows of other sources and non-open rows untouched', () => {
    const other = { ...rec('x:1'), source: 'code-scanning' }
    const done = rec('dependabot:3', 'done')
    assert.deepEqual(resolvedThreadIds([other, done], 'dependabot', []), [])
  })
})
