import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskStore } from './tasks.ts'

const WIN32 = process.platform === 'win32'

/** Scripted bd on PATH — records argv to $FAKE_BD_LOG, answers by $1. */
const FAKE_BD = `#!/bin/sh
echo "$@" >> "$FAKE_BD_LOG"
case "$1" in
  list) echo '[{"id":"t1","status":"open"}]' ;;
  ready) echo '[{"id":"t1"}]' ;;
  show) echo '[{"id":"t1","status":"in_progress"}]' ;;
  create) if [ "$FAKE_BD_CREATE_EMPTY" = "1" ]; then echo '[]'; else echo '{"id":"t9","status":"open"}'; fi ;;
  dep) echo '[{"issue_id":"t2","depends_on_id":"t1","type":"parent-child"}]' ;;
  config) if [ "$FAKE_BD_CONFIG_FAIL" = "1" ]; then echo 'db gone' >&2; exit 1; fi
          echo "issue_prefix = $FAKE_BD_PREFIX" ;;
  update|close|reopen|note|link) : ;;
  delete) : ;;
esac
`

function withFakeBd(env: Record<string, string>, fn: (log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'))
  const log = join(dir, 'bd.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'bd'), FAKE_BD)
  chmodSync(join(dir, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevEnv = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]])
  )
  process.env.PATH = `${dir}:${prevPath}`
  Object.assign(process.env, { FAKE_BD_LOG: log, ...env })
  try {
    fn(log)
  } finally {
    process.env.PATH = prevPath
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete process.env.FAKE_BD_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

function logLines(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n')
}

describe('taskStore', { skip: WIN32 }, () => {
  test('list maps the filter onto bd list args', () => {
    withFakeBd({}, (log) => {
      const rows = taskStore().list({
        status: 'open',
        labels: ['debt'],
        excludeLabels: ['wisp'],
        all: true,
        limit: 0,
        type: 'bug',
      })
      assert.equal(rows[0]?.id, 't1')
      const call = logLines(log)[0] ?? ''
      for (const part of [
        'list',
        '--json',
        '--status open',
        '-l debt',
        '--exclude-label wisp',
        '--all',
        '-n 0',
        '--type bug',
      ]) {
        assert.ok(call.includes(part), `missing "${part}" in: ${call}`)
      }
    })
  })

  test('get unwraps the array bd show returns', () => {
    withFakeBd({}, () => {
      assert.equal(taskStore().get('t1')?.status, 'in_progress')
    })
  })

  test('create maps the typed input onto bd create args', () => {
    withFakeBd({}, (log) => {
      const row = taskStore().create({
        title: 'fix it',
        description: 'd',
        type: 'bug',
        priority: 2,
        labels: ['debt', 'p1'],
        deps: ['discovered-from:t1'],
        parent: 't0',
        externalRef: 'th_1',
        metadata: { k: 'v' },
        noInheritLabels: true,
      })
      assert.equal(row.id, 't9')
      const call = logLines(log)[0] ?? ''
      for (const part of [
        'create',
        '--title fix it',
        '-d d',
        '-t bug',
        '-p 2',
        '-l debt',
        '--deps discovered-from:t1',
        '--parent t0',
        '--no-inherit-labels',
        '--external-ref th_1',
        '--metadata {"k":"v"}',
      ]) {
        assert.ok(call.includes(part), `missing "${part}" in: ${call}`)
      }
    })
  })

  test("update emits 'true' as a bare flag, strings as --k v", () => {
    withFakeBd({}, (log) => {
      taskStore().update('t1', { status: 'open', claim: 'true', priority: 1 })
      const call = logLines(log)[0] ?? ''
      assert.ok(call.includes('--status open'), call)
      assert.ok(call.includes('--claim'), call)
      assert.ok(!call.includes('--claim true'), call)
      assert.ok(call.includes('--priority 1'), call)
    })
  })

  test('deps narrows by type and direction', () => {
    withFakeBd({}, (log) => {
      taskStore().deps(['t1', 't2'], { type: 'parent-child', direction: 'up' })
      const call = logLines(log)[0] ?? ''
      assert.ok(call.includes('dep list t1 t2'), call)
      assert.ok(call.includes('-t parent-child'), call)
      assert.ok(call.includes('--direction=up'), call)
    })
  })

  test('create on an empty-array reply throws, not crashes on .id', () => {
    withFakeBd({ FAKE_BD_CREATE_EMPTY: '1' }, () => {
      assert.throws(
        () => taskStore().create({ title: 'x' }),
        /task create returned no row/
      )
    })
  })

  test('prefix parses the config value', () => {
    withFakeBd({ FAKE_BD_PREFIX: 'bro' }, () => {
      assert.equal(taskStore().prefix(), 'bro')
    })
  })

  test('prefix returns undefined when unset', () => {
    withFakeBd({ FAKE_BD_PREFIX: '' }, () => {
      assert.equal(taskStore().prefix(), undefined)
    })
  })

  test('prefix throws on backend failure — fail closed', () => {
    withFakeBd({ FAKE_BD_CONFIG_FAIL: '1' }, () => {
      assert.throws(() => taskStore().prefix(), /task store unreachable/)
    })
  })
})
