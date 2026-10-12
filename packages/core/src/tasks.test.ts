import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTasks, getTasksAsync, taskStore, type TaskStore, type TaskStoreAsync } from './tasks.ts'

const WIN32 = process.platform === 'win32'

/** Scripted bd on PATH — records argv to $FAKE_BD_LOG, answers by $1. */
const FAKE_BD = `#!/bin/sh
echo "$@" >> "$FAKE_BD_LOG"
case "$1" in
  list) if [ "$FAKE_BD_DRIFT" = "envelope" ]; then echo '{"issues":[{"id":"t1"}]}'; else echo '[{"id":"t1","status":"open"}]'; fi ;;
  ready) echo '[{"id":"t1"}]' ;;
  show) if [ "$FAKE_BD_SHOW" = "missing" ]; then echo 'Issue t1 not found' >&2; exit 1;
        elif [ "$FAKE_BD_SHOW" = "broken" ]; then echo 'database is locked' >&2; exit 1;
        elif [ "$FAKE_BD_SHOW" = "allmiss" ]; then echo '{"error":"no issues found matching the provided IDs","schema_version":1}';
        elif [ "$FAKE_BD_SHOW" = "partial" ]; then echo '[{"id":"t2","status":"open"}]';
        elif [ "$FAKE_BD_DRIFT" = "norow" ]; then echo '[{"name":"t1"}]'; else echo '[{"id":"t1","status":"in_progress"}]'; fi ;;
  create) if [ "$FAKE_BD_CREATE_EMPTY" = "1" ]; then echo '[]'; else echo '{"id":"t9","status":"open"}'; fi ;;
  dep) echo '[{"issue_id":"t2","depends_on_id":"t1","type":"parent-child"}]' ;;
  config) if [ "$FAKE_BD_CONFIG_FAIL" = "1" ]; then echo 'db gone' >&2; exit 1; fi
          echo "issue_prefix = $FAKE_BD_PREFIX" ;;
  dolt) if [ "$FAKE_BD_NO_DOLT" = "1" ]; then exit 1; fi
        if [ "$3" = "list" ]; then printf '%s\n' "\${FAKE_BD_REMOTES:-[]}"; fi ;;
  where) printf '{"path":"%s"}\n' "$FAKE_BD_BEADS" ;;
  sync) printf '%s\n' "$FAKE_BD_SYNC_OUT" ;;
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

  test('get returns undefined for a missing id', () => {
    withFakeBd({ FAKE_BD_SHOW: 'missing' }, () => {
      assert.equal(taskStore().get('t1'), undefined)
    })
  })

  test('get propagates a backend failure — never reports it as absent', () => {
    withFakeBd({ FAKE_BD_SHOW: 'broken' }, () => {
      assert.throws(() => taskStore().get('t1'), /locked|Command failed/)
    })
  })

  test('getMany answers the found rows in ONE bd show', () => {
    withFakeBd({ FAKE_BD_SHOW: 'partial' }, (log) => {
      const rows = taskStore().getMany?.(['t1', 't2']) ?? []
      assert.deepEqual(rows.map((r) => r.id), ['t2'])
      const calls = logLines(log).filter((l) => l.startsWith('show '))
      assert.equal(calls.length, 1)
      assert.ok(calls[0]!.includes('t1') && calls[0]!.includes('t2'), calls[0])
    })
  })

  test('getMany folds a total miss to [] — the error envelope is not drift', () => {
    withFakeBd({ FAKE_BD_SHOW: 'allmiss' }, () => {
      assert.deepEqual(taskStore().getMany?.(['t9', 't8']), [])
    })
  })

  test('getMany folds a single-id miss to [] — same contract as get', () => {
    withFakeBd({ FAKE_BD_SHOW: 'missing' }, () => {
      assert.deepEqual(taskStore().getMany?.(['t1']), [])
    })
  })

  test('getMany propagates a backend failure like get does', () => {
    withFakeBd({ FAKE_BD_SHOW: 'broken' }, () => {
      assert.throws(() => taskStore().getMany?.(['t1', 't2']), /locked|Command failed/)
    })
  })

  test('getMany on empty ids never spawns', () => {
    withFakeBd({}, (log) => {
      assert.deepEqual(taskStore().getMany?.([]), [])
      assert.equal(logLines(log).filter((l) => l.startsWith('show')).length, 0)
    })
  })

  test('getTasks degrades to serial get without the capability', () => {
    const calls: string[] = []
    const serial = {
      get: (id: string) => {
        calls.push(id)
        return id === 'gone' ? undefined : { id }
      },
    } as unknown as TaskStore
    assert.deepEqual(getTasks(serial, ['a', 'gone', 'b']).map((r) => r.id), ['a', 'b'])
    assert.deepEqual(calls, ['a', 'gone', 'b'])
    // and a store WITH the verb never falls back to get
    const batched = {
      getMany: (ids: string[]) => ids.map((id) => ({ id })),
      get: () => {
        throw new Error('get must not run when getMany exists')
      },
    } as unknown as TaskStore
    assert.deepEqual(getTasks(batched, ['x', 'y']).map((r) => r.id), ['x', 'y'])
  })

  test('getTasksAsync degrades to overlapping get without the capability', async () => {
    const calls: string[] = []
    const serial = {
      get: (id: string) => {
        calls.push(id)
        return Promise.resolve(id === 'gone' ? undefined : { id })
      },
    } as unknown as TaskStoreAsync
    assert.deepEqual((await getTasksAsync(serial, ['a', 'gone', 'b'])).map((r) => r.id), [
      'a',
      'b',
    ])
    assert.deepEqual(calls, ['a', 'gone', 'b'])
    // and a store WITH the verb never falls back to get
    const batched = {
      getMany: (ids: string[]) => Promise.resolve(ids.map((id) => ({ id }))),
      get: () => Promise.reject(new Error('get must not run when getMany exists')),
    } as unknown as TaskStoreAsync
    assert.deepEqual((await getTasksAsync(batched, ['x', 'y'])).map((r) => r.id), ['x', 'y'])
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
      taskStore().deps(['t1', 't2'], { rel: 'parent', direction: 'up' })
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
        /bd create returned no row/
      )
    })
  })

  test('drifted list payload throws a compat error, not a TypeError', () => {
    withFakeBd({ FAKE_BD_DRIFT: 'envelope' }, () => {
      assert.throws(() => taskStore().list(), (err: unknown) => {
        assert.equal((err as Error).name, 'BdCompatError')
        assert.match((err as Error).message, /expected an array/)
        return true
      })
    })
  })

  test('drifted show row (missing id) throws a compat error', () => {
    withFakeBd({ FAKE_BD_DRIFT: 'norow' }, () => {
      assert.throws(() => taskStore().get('t1'), /non-row shape/)
    })
  })

  test('actor resolves the bd claim identity', () => {
    withFakeBd({ BEADS_ACTOR: 'agent-x' }, () => {
      assert.equal(taskStore().actor?.(), 'agent-x')
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

  test('sync runs bare bd sync when remotes cannot be listed', () => {
    withFakeBd({ FAKE_BD_NO_DOLT: '1', FAKE_BD_SYNC_OUT: 'synced' }, (log) => {
      const out = taskStore().sync?.() ?? ''
      const call = logLines(log).find((l) => l.startsWith('sync')) ?? ''
      assert.equal(call, 'sync')
      assert.match(out, /synced/)
    })
  })

  test('sync targets a bridged file-mirror remote with --remote', () => {
    // a real bare upstream + mirror on local paths — no network needed
    const dir = mkdtempSync(join(tmpdir(), 'bro-sync-bridge-'))
    try {
      const upstream = join(dir, 'upstream.git')
      const mirror = join(dir, 'mirror.git')
      const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' })
      git('init', '--bare', '-q', upstream)
      const tree = execFileSync('git', ['-C', upstream, 'mktree', '--missing', '-z'], { encoding: 'utf8', input: '' }).trim()
      const head = git('-C', upstream, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', tree, '-m', 'x').trim()
      git('-C', upstream, 'update-ref', 'refs/dolt/data', head)
      git('init', '--bare', '-q', mirror)
      git('-C', mirror, 'remote', 'add', 'origin', upstream)
      const remotes = JSON.stringify([{ name: 'origin', url: `git+file://${mirror}` }])
      withFakeBd({ FAKE_BD_REMOTES: remotes, FAKE_BD_SYNC_OUT: 'synced', FAKE_BD_BEADS: dir }, (log) => {
        const out = taskStore().sync?.() ?? ''
        const call = logLines(log).find((l) => l.startsWith('sync')) ?? ''
        assert.equal(call, 'sync --remote origin')
        assert.match(out, /synced/)
        // the bridge's fetch leg landed the upstream dolt ref in the mirror
        assert.equal(git('-C', mirror, 'rev-parse', 'refs/dolt/data').trim(), head)
        // and no repoint — an already-file remote is honored in place
        assert.ok(
          !logLines(log).some((l) => /remote (add|remove)/.test(l)),
          logLines(log).join('\n')
        )
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('sync repoints a git+https remote at a managed mirror', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-sync-repoint-'))
    try {
      // a guaranteed-unresolvable host — the fetch leg fails on DNS in
      // ms, not on a connect timeout (filtered ports stall for minutes)
      const remotes = JSON.stringify([{ name: 'origin', url: 'git+https://nonexistent.invalid/x.git' }])
      withFakeBd({ FAKE_BD_REMOTES: remotes, FAKE_BD_SYNC_OUT: 'synced', FAKE_BD_BEADS: dir }, (log) => {
        const out = taskStore().sync?.() ?? ''
        const lines = logLines(log)
        assert.ok(lines.some((l) => l === 'dolt remote remove origin'), lines.join('\n'))
        const add = lines.find((l) => l.startsWith('dolt remote add origin ')) ?? ''
        const mirror = join(dir, 'dolt-mirror-origin.git')
        assert.equal(add, `dolt remote add origin git+file://${mirror}`)
        assert.ok(readFileSync(join(mirror, 'config'), 'utf8').includes('nonexistent.invalid/x.git'))
        const call = lines.find((l) => l.startsWith('sync')) ?? ''
        assert.equal(call, 'sync --remote origin')
        // the dead upstream's fetch leg warns without breaking the sync
        assert.match(out, /bridge fetch .* failed|repointed origin/)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
