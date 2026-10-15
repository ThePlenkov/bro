/** `bro pulse` (bro-ijffz; spec specs/bro-pulse.md) — arg parsing, the
 *  mailer-role try-lock, and one in-process beat. The never-exits loop
 *  itself is e2e-only; here: the pieces at unit distance. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mailboxDir } from '@broject/core'
import { initRepo, tmpDir } from './testrepo.ts'
import {
  pulseArgs,
  pulseMailer,
  pulseMailerRetry,
  pulseTick,
  type PulseMailer,
} from './pulse.ts'
import { pulseLive, pulseLockPath } from './watch-pulse.ts'

const DEAD = 1 << 30

const lock = (main: string, content: string): void => {
  const p = pulseLockPath(main)!
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** Capture console output — a beat's print IS the contract (stdout
 *  liveness for non-holders too), so tests read it instead of spraying. */
async function captured(fn: () => Promise<void>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const oLog = console.log
  const oErr = console.error
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '))
  try {
    await fn()
    return { out, err }
  } finally {
    console.log = oLog
    console.error = oErr
  }
}

const drops = (main: string): string[] => {
  const mb = mailboxDir(main)!
  try {
    return readdirSync(mb).filter((f) => f.startsWith('pulse-'))
  } catch {
    return []
  }
}

describe('pulseArgs', () => {
  test('defaults — cadence from config, notify on, no probe', () => {
    assert.deepEqual(pulseArgs([]), { sec: undefined, notify: true, json: false, cmd: [] })
  })

  test('the one positional is the cadence; flags parse', () => {
    assert.deepEqual(pulseArgs(['30']), { sec: 30, notify: true, json: false, cmd: [] })
    assert.deepEqual(pulseArgs(['0.5', '--no-notify', '--json']), {
      sec: 0.5,
      notify: false,
      json: true,
      cmd: [],
    })
  })

  test('a non-number or out-of-range cadence fails closed', () => {
    assert.throws(() => pulseArgs(['abc']), /<seconds>/)
    assert.throws(() => pulseArgs(['0']), /<seconds>/)
    assert.throws(() => pulseArgs([String(0x7fffffff)]), /<seconds>/)
  })

  test('a second positional is a usage error', () => {
    assert.throws(() => pulseArgs(['5', '10']), /at most one/)
  })

  test('--notify and --no-notify conflict', () => {
    assert.throws(() => pulseArgs(['--notify', '--no-notify']), /conflict/)
  })

  test("everything after '--' is the probe, never parsed as flags", () => {
    const a = pulseArgs(['5', '--', 'echo', '--json'])
    assert.deepEqual(a.cmd, ['echo', '--json'])
    assert.equal(a.json, false)
    assert.equal(a.sec, 5)
  })

  test("a bare trailing '--' is a usage error", () => {
    assert.throws(() => pulseArgs(['--']), /command/)
  })

  test('an unknown flag fails loudly — a typo never disarms the wake', () => {
    assert.throws(() => pulseArgs(['--notfy']), /unknown option --notfy/)
    assert.throws(() => pulseArgs(['--json=yes']), /takes no value/)
  })
})

describe('mailer role', () => {
  test('outside a repo there is no lock to take — ticks still print', () => {
    const dir = tmpDir('bro-pulse-norepo-')
    const m = pulseMailer(dir)
    assert.equal(m.release, null)
  })

  test('no incumbent — the hold lands and pulseLive sees a live pulse', () => {
    const { root, main } = initRepo('bro-pulse-mail-')
    const m = pulseMailer(main)
    try {
      assert.notEqual(m.release, null)
      assert.deepEqual(pulseLive(main), { live: true, pid: process.pid })
    } finally {
      m.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live foreign holder keeps the role — we still tick, never mail', () => {
    const { root, main } = initRepo('bro-pulse-held-')
    try {
      lock(main, `${process.pid}:foreign-token`)
      const m = pulseMailer(main)
      assert.equal(m.release, null)
      // retry stays refused while the incumbent lives
      assert.equal(pulseMailerRetry(main, m), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a dead holder is stolen from — the contender becomes the mailer', () => {
    const { root, main } = initRepo('bro-pulse-steal-')
    const m: PulseMailer = { release: null }
    try {
      lock(main, `${DEAD}:tok`)
      assert.equal(pulseMailerRetry(main, m), true)
      assert.notEqual(m.release, null)
      assert.deepEqual(pulseLive(main), { live: true, pid: process.pid })
    } finally {
      m.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pulseTick', () => {
  test('one snapshot beat prints and mails as the lock holder', async () => {
    const { root, main } = initRepo('bro-pulse-tick-')
    const mailer = pulseMailer(main)
    try {
      const { out } = await captured(() =>
        pulseTick(main, { sec: 60, notify: true, json: false, cmd: [] }, mailer, mailboxDir(main))
      )
      assert.match(out.join('\n'), /^bro watch — /)
      assert.equal(drops(main).length, 1)
    } finally {
      mailer.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a non-holder still prints every beat but mails nothing', async () => {
    const { root, main } = initRepo('bro-pulse-silent-')
    try {
      lock(main, `${process.pid}:foreign-token`)
      const mailer: PulseMailer = { release: null }
      const { out } = await captured(() =>
        pulseTick(
          main,
          { sec: 60, notify: true, json: false, cmd: [process.execPath, '-e', ''] },
          mailer,
          mailboxDir(main)
        )
      )
      assert.match(out.join('\n'), /^bro pulse — /)
      assert.equal(drops(main).length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('-- <cmd> echoes output; a failing probe is beat content, not a kill', async () => {
    const { root, main } = initRepo('bro-pulse-cmd-')
    const mailer = pulseMailer(main)
    try {
      const { out } = await captured(() =>
        pulseTick(
          main,
          {
            sec: 60,
            notify: true,
            json: false,
            cmd: [process.execPath, '-e', 'console.log("hi"); process.exit(3)'],
          },
          mailer,
          mailboxDir(main)
        )
      )
      const text = out.join('\n')
      assert.match(text, /bro pulse — .* \(exit 3\)/)
      assert.match(text, /hi/)
      assert.equal(drops(main).length, 1)
    } finally {
      mailer.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--no-notify holds the lock (liveness) but drops no mail', async () => {
    const { root, main } = initRepo('bro-pulse-nomail-')
    const mailer = pulseMailer(main)
    try {
      await captured(() =>
        pulseTick(main, { sec: 60, notify: false, json: false, cmd: [] }, mailer, mailboxDir(main))
      )
      assert.equal(drops(main).length, 0)
      assert.deepEqual(pulseLive(main), { live: true, pid: process.pid })
    } finally {
      mailer.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--json emits one object carrying the pulse record', async () => {
    const { root, main } = initRepo('bro-pulse-json-')
    const mailer = pulseMailer(main)
    try {
      const { out } = await captured(() =>
        pulseTick(main, { sec: 7, notify: false, json: true, cmd: [] }, mailer, mailboxDir(main))
      )
      const beat = JSON.parse(out.join(''))
      assert.deepEqual(beat.pulse, { sec: 7, mailing: true })
      assert.equal(typeof beat.ts, 'string')
    } finally {
      mailer.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
