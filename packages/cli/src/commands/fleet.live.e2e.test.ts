/** `bro fleet --live` under a real PTY — the Design's promises the
 *  frame unit tests can't cover (bro-6lqm): alt-screen enter and
 *  restore, key-driven quit, resize repaint, and non-TTY exit 2.
 *
 *  util-linux `script(1)` is the PTY harness — no node-pty dep: it
 *  allocates the pty, proxies our pipes to it, and gives the child a
 *  real controlling terminal. Resizing the slave via `stty -F` is a
 *  genuine TIOCSWINSZ — the kernel SIGWINCHes the foreground group
 *  exactly like a terminal emulator would. Linux-only: macOS
 *  script(1)/stty(1) spell these differently. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readlinkSync, rmSync } from 'node:fs'
import { CLI_DIST, e2eEnv, initRepo, installFakeBd, runCli } from './testrepo.ts'

const ALT_ON = '\u001b[?1049h'
const ALT_OFF = '\u001b[?1049l'
const HEADER = 'bro fleet — live'

// script allocates the pty; pgrep/stty drive the resize probe — any
// missing tool means skip, not fail
const HAS_TOOLS = ['script', 'pgrep', 'stty'].every(
  (c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0
)
const skip = { skip: process.platform !== 'linux' || !HAS_TOOLS }

interface LiveProc {
  proc: ChildProcess
  out: () => string
  done: Promise<{ code: number | null; out: string }>
}

/** `script -qefc <cmd> /dev/null` — quiet, flush, child's exit code. */
function runLive(args: string[], opts: { cwd: string; env?: Record<string, string> }): LiveProc {
  const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const cmd = [process.execPath, CLI_DIST, ...args].map(quoted).join(' ')
  const proc = spawn('script', ['-qefc', cmd, '/dev/null'], {
    cwd: opts.cwd,
    env: e2eEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  proc.stdout.on('data', (d) => (out += String(d)))
  proc.stderr.on('data', (d) => (out += String(d)))
  // 'close', not 'exit' — the restore bytes must have flushed before the
  // quit tests assert on `out` (exit can beat the last stdout chunk)
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    proc.on('close', (code) => resolve({ code, out }))
  })
  return { proc, out: () => out, done }
}

/** Bound a quit wait — a wedged live mode must fail the assert and let
 *  finally kill `script`, never park on a pending `done` (the test
 *  timeout reports but does not cancel the callback). */
async function boundedDone(live: LiveProc, ms = 15_000): Promise<{ code: number | null; out: string }> {
  const r = await Promise.race([
    live.done.then((v) => ({ ok: true as const, v })),
    new Promise<{ ok: false }>((res) => setTimeout(() => res({ ok: false }), ms)),
  ])
  assert.equal(r.ok, true, 'fleet --live did not exit within the bound')
  return r.ok ? r.v : { code: null, out: live.out() }
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) {
      return true
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/** The pid of the process script(1) spawned — the pty session leader
 *  whose stdin is the slave. */
async function liveChildPid(proc: ChildProcess): Promise<number | undefined> {
  let pid: number | undefined
  await waitFor(() => {
    const r = spawnSync('pgrep', ['-P', String(proc.pid), '-n'], { encoding: 'utf8' })
    const n = Number(r.stdout.trim())
    if (r.status === 0 && Number.isInteger(n) && n > 0) {
      pid = n
      return true
    }
    return false
  }, 5_000)
  return pid
}

/** The pty slave a pid has as stdin — `/proc/<pid>/fd/0` → /dev/pts/N. */
function slaveOf(pid: number): string | undefined {
  try {
    const link = readlinkSync(`/proc/${pid}/fd/0`)
    return link.startsWith('/dev/pts/') ? link : undefined
  } catch {
    return undefined
  }
}

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1

describe('bro fleet --live under a PTY', () => {
  // a wedged CLI must hit the timeout → finally kills the proc — never
  // stall the suite on a pending `done`
  const T = { ...skip, timeout: 60_000 }

  test('alt screen in, frames paint, resize repaints, q restores and exits 0', T, async () => {
    const { root, main } = initRepo('bro-fleet-live-')
    const { binDir, db } = installFakeBd(root, [])
    const live = runLive(['fleet', '--live', '--every', '30'], {
      cwd: main,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db },
    })
    try {
      // first frame — alt screen entered before any repaint
      assert.equal(await waitFor(() => live.out().includes(HEADER)), true, live.out())
      assert.ok(live.out().includes(ALT_ON), 'expected alt-screen enter')

      // a real winsize change on the slave → SIGWINCH → repaint: with
      // --every 30 the only frame source left is the resize handler
      const pid = await liveChildPid(live.proc)
      assert.ok(pid !== undefined, 'could not find the pty child')
      const pts = slaveOf(pid!)
      assert.ok(pts !== undefined, 'child stdin is not a pty')
      assert.equal(occurrences(live.out(), HEADER), 1)
      assert.equal(
        spawnSync('stty', ['-F', pts!, 'rows', '40', 'cols', '100']).status,
        0
      )
      assert.equal(
        await waitFor(() => occurrences(live.out(), HEADER) >= 2),
        true,
        'no repaint after resize'
      )

      // q quits: clean exit, primary screen restored
      live.proc.stdin!.write('q')
      const { code, out } = await boundedDone(live)
      assert.equal(code, 0, out)
      assert.ok(out.includes(ALT_OFF), 'expected alt-screen restore on quit')
      assert.ok(
        out.lastIndexOf(ALT_OFF) > out.indexOf(ALT_ON),
        'restore must follow enter'
      )
    } finally {
      live.proc.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Ctrl-C under raw mode quits with the screen restored', T, async () => {
    const { root, main } = initRepo('bro-fleet-live-')
    const { binDir, db } = installFakeBd(root, [])
    const live = runLive(['fleet', '--live'], {
      cwd: main,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_BD_DB: db },
    })
    try {
      assert.equal(await waitFor(() => live.out().includes(HEADER)), true, live.out())
      live.proc.stdin!.write('\x03') // raw mode delivers ^C as data
      const { code, out } = await boundedDone(live)
      assert.equal(code, 0, out)
      assert.ok(out.includes(ALT_OFF), 'expected alt-screen restore on ^C')
    } finally {
      live.proc.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-TTY stdout exits 2 with the watch pointer', () => {
    const { root, main } = initRepo('bro-fleet-live-')
    const prev = process.cwd()
    process.chdir(main)
    try {
      const r = runCli(['fleet', '--live'], { cwd: main })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /needs a TTY.*bro watch --every/)
    } finally {
      process.chdir(prev)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
