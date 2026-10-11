/** `bro watch install|uninstall` unit tests — install arms the
 *  session-pulse marker; both verbs strip legacy scheduler entries.
 *  Scheduler interaction is generated, never executed: the runner is
 *  injected and HOME/XDG point at tmpdirs, so no real systemctl or
 *  crontab is touched. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { initRepo } from './testrepo.ts'
import {
  detectBackend,
  installWatch,
  uninstallWatch,
  unitName,
  watchCommonDir,
  watchUnitHash,
  cronTag,
  type SchedRun,
  type SchedRunner,
} from './watch-install.ts'
import { pulseLockPath, pulseMarkerPath } from './watch-pulse.ts'

const ok = (out = ''): SchedRun => ({ code: 0, out, err: '' })
const dead = (): SchedRun => ({ code: 127, out: '', err: 'missing' })

interface Call {
  cmd: string
  args: string[]
  stdin?: string
}

function fakeRun(
  handlers: Record<string, SchedRun | ((args: string[], stdin?: string) => SchedRun)>
): { calls: Call[]; run: SchedRunner } {
  const calls: Call[] = []
  return {
    calls,
    run: (cmd, args, stdin) => {
      calls.push({ cmd, args, stdin })
      const h =
        handlers[`${cmd} ${args.join(' ')}`] ?? handlers[`${cmd} ${args[0] ?? ''}`] ?? handlers[cmd]
      if (h === undefined) {
        return ok()
      }
      return typeof h === 'function' ? h(args, stdin) : h
    },
  }
}

/** systemctl --user answers, crontab is irrelevant — systemd wins. */
const systemdRun = () =>
  fakeRun({ 'systemctl --user': ok('running\n'), 'systemctl --version': ok('s\n') })
/** Neither scheduler — nothing to strip from. */
const noneRun = () => fakeRun({ systemctl: dead(), crontab: dead() })

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bro-watch-sched-'))

/** A legacy managed crontab line — only the tag is the identity. */
const legacyCronLine = (common: string): string =>
  `*/2 * * * * cd '/repo' && sh -c 'bro watch --once --notify' >/dev/null 2>&1 ${cronTag(common)}`

describe('naming', () => {
  test('unit name + cron tag hash the common dir, 8 hex', () => {
    const h = watchUnitHash('/repo/.git')
    assert.match(h, /^[0-9a-f]{8}$/)
    assert.equal(unitName('/repo/.git'), `bro-watch-${h}`)
    assert.equal(cronTag('/repo/.git'), `# bro-watch-${h}`)
    assert.notEqual(unitName('/repo/.git'), unitName('/other/.git'))
  })
})

describe('detectBackend', () => {
  test('systemd --user wins, degraded still counts', () => {
    assert.equal(detectBackend(systemdRun().run), 'systemd')
    assert.equal(
      detectBackend(
        fakeRun({ 'systemctl --user': { code: 1, out: 'degraded\n', err: '' } }).run
      ),
      'systemd'
    )
  })

  test('crontab is the fallback, absence is honest', () => {
    const cron = fakeRun({ systemctl: dead(), crontab: { code: 1, out: '', err: 'no crontab' } })
    assert.equal(detectBackend(cron.run), 'cron')
    assert.equal(detectBackend(noneRun().run), null)
  })
})

describe('installWatch', () => {
  test('a non-repo refuses — the marker has no common dir', () => {
    const dir = tmp()
    try {
      const r = installWatch(dir, { everySec: 60, pulseSec: 900 }, systemdRun())
      assert.equal(r.state, 'error')
      assert.match(r.detail, /not a git repository/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('install writes the pulse marker — no scheduler artifacts', () => {
    const { root, main } = initRepo('bro-watch-inst-')
    const home = tmp()
    const { calls, run } = systemdRun()
    try {
      const r = installWatch(main, { everySec: 120, pulseSec: 900 }, { run, home, env: { PATH: '/p/bin' } })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /bro watch --every 120 --for 900 --notify/)
      const marker = JSON.parse(readFileSync(pulseMarkerPath(main)!, 'utf8'))
      assert.equal(marker.everySec, 120)
      // nothing written to any scheduler — no units, no crontab writes
      assert.ok(!existsSync(join(home, '.config')))
      assert.ok(!calls.some((c) => c.args.join(' ').includes('enable --now')))
      assert.ok(!calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'))
      // idempotent — same cadence reports already
      const again = installWatch(main, { everySec: 120, pulseSec: 900 }, { run, home, env: {} })
      assert.equal(again.state, 'already')
      // a cadence change rewrites — updated, not already
      const faster = installWatch(main, { everySec: 30, pulseSec: 900 }, { run, home, env: {} })
      assert.equal(faster.state, 'updated')
      assert.equal(JSON.parse(readFileSync(pulseMarkerPath(main)!, 'utf8')).everySec, 30)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('install strips legacy systemd units — the migration path', () => {
    const { root, main } = initRepo('bro-watch-mig-')
    const home = tmp()
    const { calls, run } = systemdRun()
    try {
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      const unitDir = join(home, '.config', 'systemd', 'user')
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(unitDir, `${unit}.service`), 'x')
      writeFileSync(join(unitDir, `${unit}.timer`), 'x')
      const r = installWatch(main, { everySec: 60, pulseSec: 900 }, { run, home, env: {} })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /legacy scheduler entry removed/)
      assert.ok(!existsSync(join(unitDir, `${unit}.service`)))
      assert.ok(!existsSync(join(unitDir, `${unit}.timer`)))
      assert.ok(existsSync(pulseMarkerPath(main)!))
      assert.ok(
        calls.some((c) => c.cmd === 'systemctl' && c.args.join(' ').includes('daemon-reload'))
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('install strips a legacy cron line, keeps foreign lines', () => {
    const { root, main } = initRepo('bro-watch-migc-')
    const home = tmp()
    try {
      const common = watchCommonDir(main)!
      const table = `0 0 * * * /usr/bin/foreign\n${legacyCronLine(common)}\n`
      const writes: string[] = []
      const { run } = fakeRun({
        systemctl: dead(),
        crontab: (args, stdin) => {
          if (args[0] === '-l') {
            return { code: 0, out: table, err: '' }
          }
          if (args[0] === '-') {
            writes.push(stdin ?? '')
            return ok()
          }
          return ok()
        },
      })
      const r = installWatch(main, { everySec: 60, pulseSec: 900 }, { run, home, env: {} })
      assert.equal(r.state, 'installed')
      assert.equal(writes.length, 1)
      assert.match(writes[0]!, /foreign/)
      assert.ok(!writes[0]!.includes('# bro-watch-'))
      assert.ok(existsSync(pulseMarkerPath(main)!))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed crontab read refuses the arm — a surviving line would double-tick', () => {
    const { root, main } = initRepo('bro-watch-dbl-')
    const home = tmp()
    try {
      const { run } = fakeRun({
        systemctl: dead(),
        crontab: (args) =>
          args[0] === '-l' ? { code: 1, out: '', err: 'permission denied' } : ok(),
      })
      const r = installWatch(main, { everySec: 60, pulseSec: 900 }, { run, home, env: {} })
      assert.equal(r.state, 'error')
      assert.match(r.detail, /line may remain/)
      assert.ok(!existsSync(pulseMarkerPath(main)!))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--print is pure — marker payload + rearm command, nothing written', () => {
    const { root, main } = initRepo('bro-watch-print-')
    const home = tmp()
    const { calls, run } = systemdRun()
    try {
      const r = installWatch(main, { everySec: 60, pulseSec: 900, print: true }, { run, home, env: {} })
      assert.equal(r.state, 'printed')
      assert.match(r.detail, /pulse\.json/)
      assert.match(r.detail, /bro watch --every 60 --for 900 --notify/)
      assert.ok(!existsSync(pulseMarkerPath(main)!))
      assert.ok(!existsSync(join(home, '.config')))
      assert.equal(calls.length, 0)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('uninstallWatch', () => {
  test('removes marker + systemd units, reports removed', () => {
    const { root, main } = initRepo('bro-watch-un-')
    const home = tmp()
    const { run } = systemdRun()
    try {
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      const unitDir = join(home, '.config', 'systemd', 'user')
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(unitDir, `${unit}.service`), 'x')
      installWatch(main, { everySec: 60, pulseSec: 900 }, { run, home, env: {} })
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'removed')
      assert.match(r.detail, /pulse disarmed/)
      assert.ok(!existsSync(join(unitDir, `${unit}.service`)))
      assert.ok(!existsSync(pulseMarkerPath(main)!))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('strips the cron tag and leaves foreign lines', () => {
    const { root, main } = initRepo('bro-watch-unc-')
    const home = tmp()
    try {
      const common = watchCommonDir(main)!
      const table = `0 0 * * * /usr/bin/foreign\n${legacyCronLine(common)}\n`
      const writes: string[] = []
      const { run } = fakeRun({
        systemctl: dead(),
        crontab: (args, stdin) => {
          if (args[0] === '-l') {
            return { code: 0, out: table, err: '' }
          }
          if (args[0] === '-') {
            writes.push(stdin ?? '')
            return ok()
          }
          return ok()
        },
      })
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'removed')
      assert.equal(writes.length, 1)
      assert.match(writes[0]!, /foreign/)
      assert.ok(!writes[0]!.includes('# bro-watch-'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('nothing installed → absent, not an error', () => {
    const { root, main } = initRepo('bro-watch-abs-')
    const home = tmp()
    try {
      const r = uninstallWatch(main, { ...noneRun(), home, env: {} })
      assert.equal(r.state, 'absent')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a live pulse is reported — disarm does not stop a running process', () => {
    const { root, main } = initRepo('bro-watch-ulp-')
    const home = tmp()
    const { run } = systemdRun()
    try {
      installWatch(main, { everySec: 60, pulseSec: 900 }, { run, home, env: {} })
      const lock = pulseLockPath(main)!
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, `${process.pid}:tok`)
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'removed')
      assert.match(r.detail, /live pulse still running/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed crontab write reports error — never absent while the line remains', () => {
    const { root, main } = initRepo('bro-watch-uwf-')
    const home = tmp()
    try {
      const common = watchCommonDir(main)!
      const table = `${legacyCronLine(common)}\n`
      const { run } = fakeRun({
        systemctl: dead(),
        crontab: (args) =>
          args[0] === '-l'
            ? { code: 0, out: table, err: '' }
            : { code: 1, out: '', err: 'permission denied' },
      })
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'error')
      assert.match(r.detail, /line may remain/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed systemd disable removes files but warns — the timer may linger', () => {
    const { root, main } = initRepo('bro-watch-uwd-')
    const home = tmp()
    try {
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      const unitDir = join(home, '.config', 'systemd', 'user')
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(unitDir, `${unit}.service`), 'x')
      const { run } = fakeRun({
        'systemctl --user': (args) =>
          args.includes('is-system-running')
            ? ok('running\n')
            : args.includes('disable')
              ? { code: 1, out: '', err: 'bus gone' }
              : ok(),
        crontab: (args) =>
          args[0] === '-l' ? { code: 1, out: '', err: 'no crontab for me' } : ok(),
      })
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'removed') // files ARE gone
      assert.match(r.detail, /live timer may linger/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
