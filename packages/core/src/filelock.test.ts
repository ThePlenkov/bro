/** filelock — the lock is a DIRECTORY: `X.lock/` claimed by mkdir,
 *  the hold proven by the `h-<pid>` entry inside. Tests pin the two
 *  facts the old file shape couldn't give: an occupied instance can
 *  never go absent or rebind (rmdir refuses non-empty), and removal
 *  is name-precise — a release or steal can never hit a successor's
 *  entry. The multi-process tests put real barrier files between the
 *  exact steps of the old capture/restore race (spec bro-l8c4f.2). */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  acquireFileLock,
  awaitFileLock,
  holdFileLock,
  lockHolderPid,
  reapStaleLock,
  staleLock,
  withFileLock,
} from './filelock.ts'

const here = dirname(fileURLToPath(import.meta.url))

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bro-filelock-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A lock dir in the shape an acquirer leaves: `X.lock/h-<pid>`. */
function plantHold(lock: string, pid: number, token = `${pid}:planted`): void {
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, `h-${pid}`), token)
}

/** Poll for a marker file — npx child startup time varies, so tests
 *  never sleep fixed beats for cross-process sequencing. */
async function waitFor(path: string, tries = 100, ms = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (existsSync(path)) {
      return true
    }
    await new Promise((r) => setTimeout(r, ms))
  }
  return false
}

describe('filelock', () => {
  test("a dead holder's dir is stolen at once — liveness, not age, is the signal", () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, 99999999, '99999999:gone') // a pid that cannot be alive
      // a wait this short proves no stale window was waited out
      const release = acquireFileLock(lock, { waitMs: 500 })
      // the hold is real — a steal that skipped acquisition would pass
      // the "path absent after release" assertion without owning it
      assert.equal(lockHolderPid(lock), process.pid)
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test("a dead holder's LEGACY file is stolen at once — the pre-dir shape", () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '99999999:gone')
      const release = acquireFileLock(lock, { waitMs: 500 })
      assert.equal(lockHolderPid(lock), process.pid)
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a live holder is never robbed — the waiter times out instead of racing', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, process.pid, `${process.pid}:not-ours`) // alive, foreign claim
      const ino = statSync(lock).ino
      assert.throws(() => acquireFileLock(lock, { waitMs: 300, label: 'x lock' }), /held over/)
      // byte-for-byte: same dir, same entry, same content — never moved
      assert.equal(statSync(lock).ino, ino)
      assert.deepEqual(readdirSync(lock), [`h-${process.pid}`])
      assert.equal(readFileSync(join(lock, `h-${process.pid}`), 'utf8'), `${process.pid}:not-ours`)
    } finally {
      done()
    }
  })

  test('a live LEGACY file is never robbed — same verdict, pre-dir shape', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, `${process.pid}:not-ours`)
      assert.throws(() => acquireFileLock(lock, { waitMs: 300, label: 'x lock' }), /held over/)
      assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:not-ours`)
    } finally {
      done()
    }
  })

  test('a live OLD-DEBT dir hold (`pid` entry) is honored, a dead one stolen', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // the retired debt-store shape: a dir whose hold is a `pid` file
      // carrying the owner pid — a live one must block a new-version
      // acquirer, a dead one is stolen like any dead entry
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      const ino = statSync(lock).ino
      assert.equal(lockHolderPid(lock), process.pid)
      assert.throws(() => acquireFileLock(lock, { waitMs: 300 }), /held over/)
      assert.equal(statSync(lock).ino, ino)
      assert.deepEqual(readdirSync(lock), ['pid'])
      assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid))
      // dead owner — stolen on liveness, not age
      writeFileSync(join(lock, 'pid'), '99999999')
      const release = acquireFileLock(lock, { waitMs: 500 })
      assert.equal(lockHolderPid(lock), process.pid)
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a foreign live token survives a stale reap — reapStaleLock refuses', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, process.pid)
      const ino = statSync(lock).ino
      assert.equal(reapStaleLock(lock), false)
      assert.equal(statSync(lock).ino, ino)
      assert.deepEqual(readdirSync(lock), [`h-${process.pid}`])
    } finally {
      done()
    }
  })

  test('a symlinked lock path is foreign — steal/reap never descend it', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // the link target carries a dead-pid-named entry plus ordinary
      // files — a stat-following stealer would classify them as lock
      // junk and delete them through the link
      const target = join(dir, 'unrelated')
      mkdirSync(target)
      writeFileSync(join(target, 'h-99999999'), '99999999:dead')
      writeFileSync(join(target, 'keep.txt'), 'precious')
      symlinkSync(target, lock)
      assert.equal(lstatSync(lock).isSymbolicLink(), true)
      // stale judgement refuses it, reap refuses it, and an acquirer
      // times out rather than descend into the target
      assert.equal(staleLock(lock), false)
      assert.equal(reapStaleLock(lock), false)
      assert.throws(() => acquireFileLock(lock, { waitMs: 200 }), /held over/)
      // byte-for-byte: the link and every target file survive
      assert.equal(lstatSync(lock).isSymbolicLink(), true)
      assert.deepEqual(readdirSync(target).sort(), ['h-99999999', 'keep.txt'])
      assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'precious')
    } finally {
      done()
    }
  })

  test('a non-finite waitMs is rejected — a NaN deadline would hang forever', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // run in a child — a validation regression sends the NaN deadline
      // into an unbounded synchronous Atomics.wait the runner cannot
      // interrupt, so the spawn timeout is the guardrail
      const script = join(dir, 'wait.ts')
      writeFileSync(
        script,
        `import assert from 'node:assert/strict'\n` +
          `import { mkdirSync, writeFileSync } from 'node:fs'\n` +
          `import { join } from 'node:path'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `const lock = ${JSON.stringify(lock)}\n` +
          `mkdirSync(lock); writeFileSync(join(lock, 'h-' + process.pid), process.pid + ':held')\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: NaN }), RangeError)\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: Infinity }), RangeError)\n` +
          `assert.throws(() => acquireFileLock(lock, { waitMs: -1 }), RangeError)\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.error ? String(child.error) : child.stderr)
    } finally {
      done()
    }
  })

  test('a held lock is released on process.exit — finally-bypassing exits are covered', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const script = join(dir, 'hold.ts')
      writeFileSync(
        script,
        `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\nacquireFileLock(${JSON.stringify(lock)})\nprocess.exit(0)\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a crashed staged token is swept on acquire; a fresh one is not', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const old = join(dir, 'x.lock.1.aaaa.tmp')
      const fresh = join(dir, 'x.lock.2.bbbb.tmp')
      writeFileSync(old, 'gone')
      writeFileSync(fresh, 'inflight')
      const past = new Date(Date.now() - 120_000)
      utimesSync(old, past, past)
      const release = acquireFileLock(lock)
      release()
      assert.equal(existsSync(old), false)
      assert.equal(existsSync(fresh), true)
    } finally {
      done()
    }
  })

  test('an empty lock dir is in-flight while fresh, stealable when aged', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // the mkdir → entry-publish window: a FRESH empty dir is a
      // writer mid-publish — not stealable, so a contender waits out
      // its deadline rather than breaking the claim
      mkdirSync(lock)
      assert.equal(staleLock(lock), false)
      assert.throws(() => acquireFileLock(lock, { waitMs: 200 }), /held over/)
      assert.equal(existsSync(lock), true)
      // aged past the grace it's a crashed acquirer's leftover —
      // rmdir'd on sight, and the wait bound proves no grace was waited
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      assert.equal(staleLock(lock), true)
      const release = acquireFileLock(lock, { waitMs: 500 })
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('an empty LEGACY file is in-flight while fresh, stealable when aged (wx leftovers)', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '')
      assert.equal(staleLock(lock), false)
      assert.throws(() => acquireFileLock(lock, { waitMs: 200 }), /held over/)
      assert.equal(existsSync(lock), true)
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      assert.equal(staleLock(lock), true)
      const release = acquireFileLock(lock, { waitMs: 500 })
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('dir locks need no link(2) — acquire/steal/release work where hardlinks do not', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // fs.linkSync is mutable on the CJS exports object; assigning it
      // then calling syncBuiltinESMExports pushes the patch into the
      // builtin's ESM named bindings — the shape filelock.ts imports
      // (a bare mutation never reaches a named `import { linkSync }`)
      const script = join(dir, 'nolink.ts')
      writeFileSync(
        script,
        `import fs from 'node:fs'\n` +
          `import { syncBuiltinESMExports } from 'node:module'\n` +
          `fs.linkSync = () => { console.log('LINKTRIED'); throw Object.assign(new Error('link unsupported'), { code: 'EPERM' }) }\n` +
          `syncBuiltinESMExports()\n` +
          `import('node:fs').then((ns) => console.log('patch-visible:' + (ns.linkSync === fs.linkSync)))\n` +
          `import(${JSON.stringify(join(here, 'filelock.ts'))}).then((m) => {\n` +
          `  const release = m.acquireFileLock(${JSON.stringify(lock)}, { waitMs: 500 })\n` +
          `  console.log('held:' + fs.readdirSync(${JSON.stringify(lock)})[0])\n` +
          `  release()\n` +
          `  console.log('released')\n` +
          `})\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr)
      assert.match(child.stdout, /patch-visible:true/)
      assert.match(child.stdout, /held:h-\d+/)
      assert.match(child.stdout, /released/)
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a dead LEGACY file is stolen even where link(2) is missing — degraded path', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, '99999999:gone')
      const script = join(dir, 'nolink-steal.ts')
      writeFileSync(
        script,
        `import fs from 'node:fs'\n` +
          `import { syncBuiltinESMExports } from 'node:module'\n` +
          `fs.linkSync = () => { console.log('LINKTRIED'); throw Object.assign(new Error('link unsupported'), { code: 'ENOSYS' }) }\n` +
          `syncBuiltinESMExports()\n` +
          `import('node:fs').then((ns) => console.log('patch-visible:' + (ns.linkSync === fs.linkSync)))\n` +
          `import(${JSON.stringify(join(here, 'filelock.ts'))}).then((m) => {\n` +
          `  const release = m.acquireFileLock(${JSON.stringify(lock)}, { waitMs: 2_000 })\n` +
          `  console.log('held')\n` +
          `  release()\n` +
          `  console.log('released')\n` +
          `})\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr)
      // LINKTRIED proves the patch reached filelock's named import —
      // the steal then fell back to the no-link(2) degraded path
      assert.match(child.stdout, /patch-visible:true/)
      assert.match(child.stdout, /LINKTRIED/)
      assert.match(child.stdout, /held/)
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a live LEGACY file refuses the steal even where link(2) is missing', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      writeFileSync(lock, `${process.pid}:alien`)
      const script = join(dir, 'nolink-held.ts')
      writeFileSync(
        script,
        `import fs from 'node:fs'\n` +
          `import { syncBuiltinESMExports } from 'node:module'\n` +
          `fs.linkSync = () => { throw Object.assign(new Error('link unsupported'), { code: 'EPERM' }) }\n` +
          `syncBuiltinESMExports()\n` +
          `import('node:fs').then((ns) => console.log('patch-visible:' + (ns.linkSync === fs.linkSync)))\n` +
          `import(${JSON.stringify(join(here, 'filelock.ts'))}).then((m) => {\n` +
          `  try { m.acquireFileLock(${JSON.stringify(lock)}, { waitMs: 300 }); console.log('ACQUIRED') }\n` +
          `  catch (e) { console.log('ERR:' + e.name) }\n` +
          `})\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr)
      assert.match(child.stdout, /patch-visible:true/)
      assert.match(child.stdout, /ERR:LockTimeout/)
      assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:alien`)
    } finally {
      done()
    }
  })

  test('lockHolderPid reads the holder from a dir entry and legacy file tokens', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, 12345)
      assert.equal(lockHolderPid(lock), 12345)
      rmSync(lock, { recursive: true })
      writeFileSync(lock, '777')
      assert.equal(lockHolderPid(lock), 777)
      writeFileSync(lock, 'garbage')
      assert.equal(lockHolderPid(lock), null)
      rmSync(lock)
      assert.equal(lockHolderPid(lock), null)
    } finally {
      done()
    }
  })

  test('holdFileLock heartbeats the mtime — a live hold never reads stale', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        // age the hold past the abandoned bound — without the beat a
        // contender (or the janitor) would steal it while we live
        const past = new Date(Date.now() - 20 * 60_000)
        utimesSync(lock, past, past)
        assert.equal(staleLock(lock), true)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(staleLock(lock), false)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('holdFileLock re-claims a vanished lock dir with our entry', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        rmSync(lock, { recursive: true })
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(existsSync(lock), true)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
    } finally {
      done()
    }
  })

  test('the heartbeat never refreshes a foreign hold; a dead one is reclaimed', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        // a live foreign hold sits at the path — our beat must not
        // bump its mtime (refreshing it would mask the thief's own
        // abandonment age)
        rmSync(lock, { recursive: true })
        plantHold(lock, process.pid, `${process.pid}:alien`)
        const written = statSync(lock).mtimeMs
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(readFileSync(join(lock, `h-${process.pid}`), 'utf8'), `${process.pid}:alien`)
        assert.equal(statSync(lock).mtimeMs, written)
        // a dead holder is stealable — the beat steals it, then the
        // next beat reclaims the freed path with our own entry
        rmSync(lock, { recursive: true })
        plantHold(lock, 99999999, '99999999:alien')
        await new Promise((r) => setTimeout(r, 150))
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
    } finally {
      done()
    }
  })

  test('holdFileLock re-acquire in the same process is re-entrant', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      // same-process re-acquire is re-entrant (heldLocks) — contention
      // is proven cross-process in the awaitFileLock test below
      const again = acquireFileLock(lock, { waitMs: 0 })
      again()
      assert.equal(existsSync(lock), true)
      assert.equal(lockHolderPid(lock), process.pid)
      release()
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  // --- bro-l8c4f.2: the capture/restore race, replayed against the dir primitive ---
  // Every test below isolates one step of the old race — stale
  // precheck, successor publish, capture gap, restore, release of the
  // old handle — and proves the dir primitive can't reproduce it:
  // removal is name-precise and rmdir is conditional on empty.

  test('release of a stolen hold removes nothing of the successor — multi-process barriers', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const sigDir = join(dir, 'sig')
      mkdirSync(sigDir)
      const aReady = join(sigDir, 'a.ready')
      const aGo = join(sigDir, 'a.go')
      const aPidFile = join(sigDir, 'a.pid')
      // A: acquire, publish our entry name + pid, wait for the release
      // signal, release, exit — the old code's releaseLock would
      // capture-then-restore whatever sits at `lock` then
      const aScript = join(dir, 'a.ts')
      writeFileSync(
        aScript,
        `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `const release = acquireFileLock(${JSON.stringify(lock)})\n` +
          `writeFileSync(${JSON.stringify(aPidFile)}, String(process.pid))\n` +
          `writeFileSync(${JSON.stringify(aReady)}, '')\n` +
          `const iv = setInterval(() => {\n` +
          `  try { require('node:fs').accessSync(${JSON.stringify(aGo)}); clearInterval(iv); release(); process.exit(0) }\n` +
          `  catch {}\n` +
          `}, 20)\n`
      )
      const a = spawn('npx', ['tsx', aScript], { stdio: 'ignore' })
      assert.equal(await waitFor(aReady), true, 'A never acquired')
      const aPid = Number(readFileSync(aPidFile, 'utf8'))
      // simulate the steal the abandoned bound permits: A's entry is
      // unlinked and A's dir rmdir'd while A still believes it holds —
      // the exact mid-race state capture/restore used to "fix" by
      // putting the captured instance back over the successor
      rmSync(join(lock, `h-${aPid}`))
      rmdirSync(lock)
      // B now owns a fresh dir instance
      const bReady = join(sigDir, 'b.ready')
      const bPidFile = join(sigDir, 'b.pid')
      const bScript = join(dir, 'b.ts')
      writeFileSync(
        bScript,
        `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `acquireFileLock(${JSON.stringify(lock)}, { waitMs: 10_000 })\n` +
          `writeFileSync(${JSON.stringify(bPidFile)}, String(process.pid))\n` +
          `writeFileSync(${JSON.stringify(bReady)}, '')\n` +
          `setTimeout(() => {}, 30_000)\n`
      )
      const b = spawn('npx', ['tsx', bScript], { stdio: 'ignore' })
      assert.equal(await waitFor(bReady), true, 'B never acquired')
      const bPid = Number(readFileSync(bPidFile, 'utf8'))
      const bIno = statSync(lock).ino
      // A releases its stale handle — under the old code its restore
      // could rename-capture B's live instance and/or overwrite it;
      // here the release's only legal moves are unlink-by-our-name
      // (absent) and rmdir-if-ours-and-empty (foreign dir) — both no-ops
      writeFileSync(aGo, '')
      await new Promise((r) => a.once('exit', r))
      assert.equal(statSync(lock).ino, bIno, 'B instance moved or replaced by the loser release')
      assert.deepEqual(readdirSync(lock), [`h-${bPid}`])
      assert.ok(readFileSync(join(lock, `h-${bPid}`), 'utf8').startsWith(`${bPid}:`))
      b.kill('SIGKILL')
      await new Promise((r) => b.once('exit', r))
    } finally {
      done()
    }
  })

  test('mid-steal gap: entry unlinked, successor publishes, the conditional rmdir decides', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, 99999999, '99999999:dead')
      // stealer step 1: every entry inside the dead instance is
      // unlinked — done by hand so the gap between unlink and rmdir
      // is a real scheduling point, exactly where the old capture let
      // a successor in while the restored instance was on its way back
      unlinkSync(join(lock, 'h-99999999'))
      // a contender acquires through the gap: the empty dir is aged
      // past grace so its own contend rmdir's it, then mkdir+publish
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      const bRelease = acquireFileLock(lock, { waitMs: 500 })
      try {
        assert.deepEqual(readdirSync(lock), [`h-${process.pid}`])
        // the stealer's step 2 lands AFTER the successor published —
        // rmdir refuses the now-nonempty dir; the successor keeps its
        // instance byte-for-byte (the old restore would have replaced it)
        assert.throws(() => rmdirSync(lock), /ENOTEMPTY|ENOENT/)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        bRelease()
      }
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a stealer that empties a live hold gets aborted by the owner\'s re-publish', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const release = holdFileLock(lock, { heartbeatMs: 25 })
      try {
        // age our hold past the abandoned bound so a contender judges
        // it stealable — the judgement is allowed; the steal must fail
        const past = new Date(Date.now() - 20 * 60_000)
        utimesSync(lock, past, past)
        // stealer step 1: our live entry is unlinked (the abandoned
        // bound permits it) — then before its rmdir our heartbeat
        // re-publishes, and the conditional rmdir must refuse
        unlinkSync(join(lock, `h-${process.pid}`))
        const entry = join(lock, `h-${process.pid}`)
        for (let i = 0; i < 50 && !existsSync(entry); i++) {
          await new Promise((r) => setTimeout(r, 20))
        }
        assert.equal(existsSync(entry), true, 'heartbeat never re-published')
        assert.throws(() => rmdirSync(lock), /ENOTEMPTY/)
        assert.equal(lockHolderPid(lock), process.pid)
      } finally {
        release()
      }
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('a publish that lands in a foreign dir self-cleans its stray and retries', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // deterministic mid-publish swap: the child's own lstatSync patch
      // swaps the dir the instant our entry exists inside it — the
      // end-state of "our fresh dir was swept and re-bought mid-write".
      // lstatSync because that is the stat the lock code now uses;
      // syncBuiltinESMExports pushes the mutation into filelock's
      // named ESM binding.
      const script = join(dir, 'swap.ts')
      writeFileSync(
        script,
        `import fs from 'node:fs'\n` +
          `import { syncBuiltinESMExports } from 'node:module'\n` +
          `import { join } from 'node:path'\n` +
          `const lock = ${JSON.stringify(lock)}\n` +
          `const origLstat = fs.lstatSync\n` +
          `let swapped = false\n` +
          `fs.lstatSync = (p, o) => {\n` +
          `  if (!swapped && String(p) === lock && fs.existsSync(join(lock, 'h-' + process.pid))) {\n` +
          `    swapped = true\n` +
          `    console.log('swapped')\n` +
          `    fs.rmSync(lock, { recursive: true, force: true })\n` +
          `    fs.mkdirSync(lock)\n` +
          `    fs.writeFileSync(join(lock, 'h-99999999'), '99999999:dead')\n` + // the foreign dir's own (dead) entry
          `    fs.writeFileSync(join(lock, 'h-' + process.pid), process.pid + ':stray')\n` + // our publish, landed foreign
          `  }\n` +
          `  return origLstat(p, o)\n` +
          `}\n` +
          `syncBuiltinESMExports()\n` +
          `import('node:fs').then((ns) => console.log('patch-visible:' + (ns.lstatSync === fs.lstatSync)))\n` +
          `import(${JSON.stringify(join(here, 'filelock.ts'))}).then((m) => {\n` +
          `  const release = m.acquireFileLock(lock, { waitMs: 5_000 })\n` +
          `  // we hold: verify the stray was pulled from the foreign dir\n` +
          `  console.log('held')\n` +
          `  release()\n` +
          `  console.log('released')\n` +
          `})\n`
      )
      const child = spawnSync('npx', ['tsx', script], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr)
      // 'swapped' proves the interleaving actually ran — without the
      // patch reaching filelock the test would pass unexercised
      assert.match(child.stdout, /patch-visible:true/)
      assert.match(child.stdout, /swapped/)
      assert.match(child.stdout, /held/)
      assert.match(child.stdout, /released/)
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('concurrent acquirers serialize the critical section — max one owner', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      const csLog = join(dir, 'cs.log')
      const script = join(dir, 'contender.ts')
      writeFileSync(
        script,
        `import { appendFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `for (let i = 0; i < 5; i++) {\n` +
          `  const release = acquireFileLock(${JSON.stringify(lock)}, { waitMs: 15_000 })\n` +
          `  appendFileSync(${JSON.stringify(csLog)}, 'enter ' + process.pid + '\\n')\n` +
          `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)\n` +
          `  appendFileSync(${JSON.stringify(csLog)}, 'exit ' + process.pid + '\\n')\n` +
          `  release()\n` +
          `}\n`
      )
      const kids = [0, 1, 2].map(() => spawn('npx', ['tsx', script], { stdio: 'ignore' }))
      await Promise.all(
        kids.map(
          (k) =>
            new Promise<void>((resolve, reject) =>
              k.once('exit', (c) => (c === 0 ? resolve() : reject(new Error(`contender exited ${c}`))))
            )
        )
      )
      // strict pairing: every enter is followed by the same pid's exit
      // before any next enter — two owners would interleave
      const lines = readFileSync(csLog, 'utf8').trim().split('\n')
      assert.equal(lines.length, 30)
      let inside: string | null = null
      for (const l of lines) {
        const [op, pid] = l.split(' ')
        if (op === 'enter') {
          assert.equal(inside, null, `${pid} entered while ${inside} held the section`)
          inside = pid!
        } else {
          assert.equal(inside, pid, `${pid} exited a section ${inside} owned`)
          inside = null
        }
      }
      assert.equal(inside, null)
    } finally {
      done()
    }
  })

  test('awaitFileLock resolves at once over a dead holder — no standby', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      plantHold(lock, 99999999, '99999999:gone')
      const standby: Array<number | null> = []
      const release = await awaitFileLock(lock, {
        waitMs: 500,
        onStandby: (pid) => standby.push(pid),
      })
      // prove the resolve actually holds — a steal-without-acquire
      // would pass the no-standby assertion while owning nothing
      assert.equal(lockHolderPid(lock), process.pid)
      release()
      assert.deepEqual(standby, [])
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })

  test('awaitFileLock stands by behind a live foreign holder, then takes over', async () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      // a foreign process holds the lock ~1.2s, then exits — the
      // standby must report the incumbent and acquire once it releases
      const pidFile = join(dir, 'incumbent.pid')
      const script = join(dir, 'incumbent.ts')
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs'\n` +
          `import { acquireFileLock } from ${JSON.stringify(join(here, 'filelock.ts'))}\n` +
          `acquireFileLock(${JSON.stringify(lock)})\n` +
          // the holder's real pid — npx spawns a grandchild, so
          // child.pid is the wrapper's, not the lock token's
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
          `setTimeout(() => {}, 1200)\n`
      )
      const child = spawn('npx', ['tsx', script], { stdio: 'ignore' })
      for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(existsSync(pidFile), 'incumbent never acquired')
      const standby: Array<number | null> = []
      const release = await awaitFileLock(lock, {
        waitMs: 100,
        heartbeatMs: 25,
        onStandby: (pid) => standby.push(pid),
      })
      release()
      assert.ok(standby.length >= 1, 'standby never reported')
      const holderPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(standby[0], holderPid)
      if (child.exitCode === null) {
        await new Promise((r) => child.once('exit', r))
      }
    } finally {
      done()
    }
  })

  test('withFileLock releases on fn throw', () => {
    const { dir, done } = tmp()
    try {
      const lock = join(dir, 'x.lock')
      assert.throws(
        () =>
          withFileLock(lock, () => {
            throw new Error('boom')
          }),
        /boom/
      )
      assert.equal(existsSync(lock), false)
    } finally {
      done()
    }
  })
})
