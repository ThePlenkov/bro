import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import {
  holdRoleLease,
  localLeaseStore,
  RoleLeaseAbortedError,
  type Lease,
  type LeaseStore,
} from './leases.ts'
import { tmpDir } from './testtmp.ts'

const root = tmpDir('bro-leases-')
let now = 1_000
const options = { stateHome: root, now: () => now, host: 'local', pidAlive: () => true }
const holder = { host: 'remote', pid: 10, rig: 'rig', agentId: 'agent' }

describe('local lease store', () => {
  test('acquires, renews, rebinds, and releases token-matched leases', () => {
    const store = localLeaseStore('project', options)
    const acquired = store.acquire('bead/a', holder, 100)
    assert.equal(acquired.ok, true)
    if (!acquired.ok) return
    assert.equal(store.read('bead/a')?.token, acquired.lease.token)
    now += 20
    const renewed = store.renew(acquired.lease, 200)
    assert.equal(renewed?.expiresAt, new Date(now + 200).toISOString())
    const rebound = store.rebind(renewed!, { pid: 22 })
    assert.equal(rebound?.holder.pid, 22)
    store.release(rebound!)
    assert.equal(store.read('bead/a'), undefined)
    store.release(rebound!)
  })

  test('expires and reclaims leases, with local PID checks only', () => {
    let clock = 1_000
    const store = localLeaseStore('expiry', {
      ...options,
      now: () => clock,
      pidAlive: () => false,
    })
    const first = store.acquire('dead', { ...holder, host: 'local' }, 500)
    assert.equal(first.ok, true)
    const reclaimed = store.acquire('dead', holder, 500)
    assert.equal(reclaimed.ok, true)
    const foreign = store.acquire('foreign', holder, 50)
    assert.equal(foreign.ok, true)
    if (foreign.ok) {
      assert.equal(store.acquire('foreign', holder, 50).ok, false)
      clock += 50
      assert.equal(store.acquire('foreign', holder, 50).ok, true)
    }
  })

  test('rejects mismatched tokens and encodes distinct keys', () => {
    const store = localLeaseStore('tokens', options)
    const acquired = store.acquire('a/b', holder, 100)
    assert.equal(acquired.ok, true)
    if (!acquired.ok) return
    const stale = { ...acquired.lease, token: 'stale' }
    assert.equal(store.renew(stale, 100), undefined)
    assert.equal(store.rebind(stale, { pid: 2 }), undefined)
    store.release(stale)
    assert.equal(store.read('a/b')?.token, acquired.lease.token)
    assert.equal(store.acquire('a%2Fb', holder, 100).ok, true)
    const dir = join(root, 'bro', 'projects', 'tokens', 'leases')
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.json')).sort(), [
      'a%252Fb.json',
      'a%2Fb.json',
    ])
  })

  test('force release, list, and file permissions', () => {
    const store = localLeaseStore('list', options)
    const a = store.acquire('bead/a', holder, 100)
    const b = store.acquire('role/loop', holder, 100)
    assert.equal(a.ok && b.ok, true)
    assert.deepEqual(store.list().map((lease) => lease.key).sort(), ['bead/a', 'role/loop'])
    const file = join(root, 'bro', 'projects', 'list', 'leases', 'bead%2Fa.json')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700)
    assert.equal(store.forceRelease('bead/a'), true)
    assert.equal(store.forceRelease('bead/a'), false)
    assert.equal(store.list().length, 1)
  })

  test('uses XDG_STATE_HOME and treats an empty value as unset', () => {
    const previousHome = process.env.HOME
    const previousState = process.env.XDG_STATE_HOME
    try {
      process.env.HOME = root
      process.env.XDG_STATE_HOME = join(root, 'xdg-state')
      localLeaseStore('xdg').acquire('x', holder, 100)
      assert.equal(
        existsSync(join(root, 'xdg-state', 'bro', 'projects', 'xdg', 'leases', 'x.json')),
        true
      )
      process.env.XDG_STATE_HOME = ''
      localLeaseStore('empty-xdg').acquire('x', holder, 100)
      assert.equal(
        existsSync(join(root, '.local', 'state', 'bro', 'projects', 'empty-xdg', 'leases', 'x.json')),
        true
      )
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousState === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousState
    }
  })

  test('corrupt leases read as empty and are repaired by acquire', () => {
    const store = localLeaseStore('repair', options)
    store.acquire('x', holder, 100)
    const file = join(root, 'bro', 'projects', 'repair', 'leases', 'x.json')
    writeFileSync(file, '{')
    assert.equal(store.read('x'), undefined)
    assert.equal(store.acquire('x', holder, 100).ok, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, 'x')
  })

  test('two processes racing acquire produce one winner', async () => {
    const project = 'race'
    const store = localLeaseStore(project, options)
    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'leases.ts')).href
    const script =
      `import { localLeaseStore } from ${JSON.stringify(moduleUrl)}; ` +
      `const s=localLeaseStore(process.env.PROJECT,{stateHome:process.env.STATE,host:'shared',pidAlive:()=>true}); ` +
      `const r=s.acquire('bead/race',{host:'other',pid:1,rig:'rig'},10000); ` +
      `process.stdout.write(r.ok?'yes':'no');`
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          env: { ...process.env, PROJECT: project, STATE: root },
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.once('error', reject)
        child.once('exit', (code) =>
          code === 0 ? resolve(output) : reject(new Error(`child exited ${code}`))
        )
      })
    assert.deepEqual((await Promise.all([run(), run()])).sort(), ['no', 'yes'])
    assert.equal(store.list().length, 1)
  })
})

describe('role lease helper', () => {
  test('waits for the first holder to release', async () => {
    const store = localLeaseStore('roles', options)
    const first = await holdRoleLease(store, 'loop', holder, 900)
    let standby = ''
    const waiting = holdRoleLease(store, 'loop', { ...holder, pid: 11 }, 900, {
      log: (line) => (standby = line),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.match(standby, /standby — role\/loop held by rig@remote pid 10/)
    first.release()
    const second = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('role lease timed out')), 1_000)),
    ])
    assert.equal(store.read('role/loop')?.holder.pid, 11)
    second.release()
  })

  test('renewal loss invokes the exit path with 75', async () => {
    const lease: Lease = {
      key: 'role/drive',
      token: 'token',
      holder,
      acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(10_000).toISOString(),
    }
    const store = {
      acquire: () => ({ ok: true as const, lease }),
      renew: () => undefined,
      release: () => undefined,
      read: () => undefined,
      rebind: () => undefined,
      forceRelease: () => false,
      list: () => [],
    } satisfies LeaseStore
    const exitCodes: number[] = []
    await holdRoleLease(store, 'drive', holder, 3, {
      exit: (code) => exitCodes.push(code),
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.deepEqual(exitCodes, [75])
  })

  test('aborts while waiting for another holder', async () => {
    const store = localLeaseStore('abort', options)
    const first = await holdRoleLease(store, 'drive', holder, 900)
    const controller = new AbortController()
    const waiting = holdRoleLease(store, 'drive', { ...holder, pid: 12 }, 900, {
      signal: controller.signal,
    })
    controller.abort()
    await assert.rejects(waiting, RoleLeaseAbortedError)
    first.release()
  })
})
