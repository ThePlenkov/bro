/** `bro pulse` e2e — the real built CLI as a long-lived child: repeated
 *  beats, the armed want-marker, mailbox drops, the orchestrator
 *  refusal, `-- <cmd>` probe mode, mailer-role arbitration between two
 *  pulses (and the takeover when the holder dies), and the outside-repo
 *  metronome. Process-lifecycle behavior only exists at spawn
 *  distance — no chdir, the child takes `cwd`, the parent only kills. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_DIST, e2eEnv, initRepo, runCli, tmpDir } from './testrepo.ts'

interface PulseChild {
  child: ChildProcess
  out: () => string
  err: () => string
}

function startPulse(cwd: string, args: string[], env: Record<string, string> = {}): PulseChild {
  let out = ''
  let err = ''
  const child = spawn(process.execPath, [CLI_DIST, 'pulse', ...args], {
    cwd,
    env: e2eEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  child.stderr!.on('data', (d: Buffer) => {
    err += d.toString('utf8')
  })
  return { child, out: () => out, err: () => err }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) {
      return
    }
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** SIGKILL — an orphaned pulse outlives the fixture its caller rmSyncs;
 *  the leftover `pulse.lock` carrying a dead pid is exactly what the
 *  takeover test steals. An already-dead child resolves straight away
 *  (its 'exit' never refires). */
async function kill(p: PulseChild): Promise<void> {
  if (p.child.exitCode !== null || p.child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5_000)
    p.child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    p.child.kill('SIGKILL')
  })
}

const marker = (main: string): string => join(main, '.git', 'bro', 'pulse.json')

const pulseDrops = (main: string): string[] => {
  const mb = join(main, '.git', 'bro', 'notify')
  try {
    return readdirSync(mb).filter((f) => f.startsWith('pulse-'))
  } catch {
    return []
  }
}

describe('bro pulse e2e', () => {
  test('metronome — beats repeat on cadence, the marker arms, mail lands', async () => {
    const { root, main } = initRepo('bro-pulse-e2e-tick-')
    const p = startPulse(main, ['0.3'])
    try {
      await until(
        () => (p.out().match(/bro watch — /g) ?? []).length >= 2,
        10_000,
        `two snapshot beats — out: ${p.out()} err: ${p.err()}`
      )
      const want = JSON.parse(readFileSync(marker(main), 'utf8'))
      assert.equal(want.everySec, 0.3)
      await until(() => pulseDrops(main).length >= 1, 5_000, 'a pulse-* mailbox drop')
    } finally {
      await kill(p)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('BRO_AGENT_ID set — the orchestrator-only guard refuses with exit 2', () => {
    const { root, main } = initRepo('bro-pulse-e2e-guard-')
    try {
      const r = runCli(['pulse', '5'], { cwd: main, env: { BRO_AGENT_ID: 'agent-1' } })
      assert.equal(r.code, 2)
      assert.match(r.stderr, /BRO_AGENT_ID/)
      assert.equal(existsSync(marker(main)), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('-- <cmd> ticks the probe — stdout verbatim, failures are beat content', async () => {
    const { root, main } = initRepo('bro-pulse-e2e-cmd-')
    const p = startPulse(main, [
      '0.3',
      '--',
      process.execPath,
      '-e',
      'console.log("probe-out"); process.exit(3)',
    ])
    try {
      await until(
        () => p.out().includes('probe-out') && p.out().includes('(exit 3)'),
        10_000,
        `probe beats — out: ${p.out()} err: ${p.err()}`
      )
      // still beating after the failure — more beats keep arriving
      const n = (p.out().match(/bro pulse — /g) ?? []).length
      await until(
        () => (p.out().match(/bro pulse — /g) ?? []).length > n,
        5_000,
        'the next beat after a failed probe'
      )
      assert.ok((p.out().match(/bro pulse — /g) ?? []).length > n)
    } finally {
      await kill(p)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('one mailer per repo — a second pulse ticks without mailing, then takes over', async () => {
    const { root, main } = initRepo('bro-pulse-e2e-two-')
    const a = startPulse(main, ['0.3', '--json', '--', 'true'])
    let b: PulseChild | undefined
    try {
      await until(() => a.out().includes('"mailing":true'), 10_000, `A holds the mailer role`)
      b = startPulse(main, ['0.3', '--json', '--', 'true'])
      const other = b
      await until(
        () => other.out().includes('"mailing":false'),
        10_000,
        `B ticks as a non-holder — out: ${other.out()}`
      )
      await kill(a)
      // the dead incumbent's lock is stolen on B's next beat
      await until(
        () => other.out().includes('"mailing":true'),
        10_000,
        `B takes the mailer role over — out: ${other.out()}`
      )
      assert.ok(other.out().includes('"mailing":true'))
    } finally {
      await kill(a).catch(() => {})
      if (b !== undefined) {
        await kill(b).catch(() => {})
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('outside a repo — the metronome still beats, warnings once', async () => {
    const dir = tmpDir('bro-pulse-e2e-norepo-')
    const p = startPulse(dir, ['0.3', '--', 'true'])
    try {
      await until(
        () => (p.out().match(/bro pulse — /g) ?? []).length >= 2,
        10_000,
        `repoless beats — out: ${p.out()} err: ${p.err()}`
      )
      assert.match(p.err(), /git repository|mailbox/)
    } finally {
      await kill(p)
    }
  })
})
