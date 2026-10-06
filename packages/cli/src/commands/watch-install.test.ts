/** `bro watch install|uninstall` unit tests — scheduler text is
 *  generated, never executed: the runner is injected and HOME/XDG
 *  point at tmpdirs, so no real systemctl or crontab is touched. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRepo } from './testrepo.ts'
import {
  cronLine,
  cronTag,
  detectBackend,
  installWatch,
  printArtifacts,
  systemdService,
  systemdTimer,
  uninstallWatch,
  unitName,
  watchCommonDir,
  watchUnitHash,
  type SchedRun,
  type SchedRunner,
} from './watch-install.ts'

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
/** Neither scheduler — nothing to install onto. */
const noneRun = () => fakeRun({ systemctl: dead(), crontab: dead() })

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bro-watch-sched-'))

describe('naming', () => {
  test('unit name + cron tag hash the common dir, 8 hex', () => {
    const h = watchUnitHash('/repo/.git')
    assert.match(h, /^[0-9a-f]{8}$/)
    assert.equal(unitName('/repo/.git'), `bro-watch-${h}`)
    assert.equal(cronTag('/repo/.git'), `# bro-watch-${h}`)
    assert.notEqual(unitName('/repo/.git'), unitName('/other/.git'))
  })
})

describe('systemd text', () => {
  test('service pins cwd, PATH, and the bro→npx invocation', () => {
    const s = systemdService('/repo', '1.2.3', '/p/bin:/usr/bin')
    assert.match(s, /WorkingDirectory=\/repo/)
    assert.match(s, /Environment="PATH=\/p\/bin:\/usr\/bin"/)
    assert.match(
      s,
      /ExecStart=\/bin\/sh -c 'bro watch --once --notify \|\| npx -y --prefer-offline "@broject\/bro@1\.2\.3" watch --once --notify'/
    )
    assert.match(s, /Type=oneshot/)
  })

  test('% is specifier-escaped in paths', () => {
    assert.match(systemdService('/r%po', '1', '/p'), /WorkingDirectory=\/r%%po/)
  })

  test('timer fires on boot and on a cadence', () => {
    const t = systemdTimer('bro-watch-deadbeef', 90)
    assert.match(t, /OnBootSec=90s/)
    assert.match(t, /OnUnitActiveSec=90s/)
    assert.match(t, /Unit=bro-watch-deadbeef\.service/)
    assert.match(t, /WantedBy=timers\.target/)
  })
})

describe('cron line', () => {
  test('minute granularity rounds up, tag is the identity', () => {
    assert.match(cronLine('/repo', 60, '/p/bin', '/repo/.git', '1.2.3'), /^\* \* \* \* \* /)
    const l5 = cronLine('/repo', 300, '/p/bin', '/repo/.git', '1.2.3')
    assert.ok(l5.startsWith('*/5 * * * * '))
    assert.ok(l5.endsWith(cronTag('/repo/.git')))
    assert.match(
      l5,
      /cd '\/repo' && PATH='\/p\/bin' sh -c 'bro watch --once --notify \|\| npx -y --prefer-offline "@broject\/bro@1\.2\.3" watch --once --notify' >\/dev\/null 2>&1 /
    )
  })

  test('sub-minute cadences still schedule every minute', () => {
    assert.match(cronLine('/r', 30, '/p', '/r/.git', '1'), /^\* \* \* \* \* /)
  })

  test('intervals ≥60min move to the hour field — never faster than configured', () => {
    // 90min → every 2h on the hour (rounds up), not a bogus */90
    assert.match(cronLine('/r', 5400, '/p', '/r/.git', '1'), /^0 \*\/2 \* \* \* /)
    assert.match(cronLine('/r', 3600, '/p', '/r/.git', '1'), /^0 \*\/1 \* \* \* /)
    // a day or more moves to the day field — a 2-day step ranges from
    // day 2, since `*/2` would fire on the 31st and the 1st (a 1-day gap)
    assert.match(cronLine('/r', 86400, '/p', '/r/.git', '1'), /^0 0 \*\/1 \* \* /)
    assert.match(cronLine('/r', 172800, '/p', '/r/.git', '1'), /^0 0 2-31\/2 \* \* /)
  })

  test('non-divisor steps range from the step value — a field reset cannot fire early', () => {
    // */7 would fire :56 then :00 — a 4-minute gap on a 7-minute cadence
    assert.match(cronLine('/r', 420, '/p', '/r/.git', '1'), /^7-59\/7 \* \* \* \* /)
    // */5 hours would fire 20:00 then 00:00 — a 4-hour gap on a 5-hour cadence
    assert.match(cronLine('/r', 18000, '/p', '/r/.git', '1'), /^0 5-23\/5 \* \* \* /)
    // divisor steps keep the `*/N` form — they wrap evenly
    assert.match(cronLine('/r', 900, '/p', '/r/.git', '1'), /^\*\/15 \* \* \* \* /)
    assert.match(cronLine('/r', 21600, '/p', '/r/.git', '1'), /^0 \*\/6 \* \* \* /)
  })

  test('a newline in the checkout path refuses — cron cannot quote it', () => {
    assert.throws(() => cronLine('/r\n* * * * * /bin/evil', 60, '/p', '/r/.git', '1'), /newline/)
  })

  test('% in a path is escaped — a bare % ends the cron command field', () => {
    const l = cronLine('/r%po', 60, '/p', '/r/.git', '1')
    assert.match(l, /cd '\/r\\%po'/)
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
  test('a non-repo refuses — no mailbox for --notify', () => {
    const dir = tmp()
    try {
      const r = installWatch(dir, { everySec: 60 }, systemdRun())
      assert.equal(r.state, 'error')
      assert.match(r.detail, /not a git repository/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('systemd install writes both units and enables the timer', () => {
    const { root, main } = initRepo('bro-watch-inst-')
    const home = tmp()
    const { calls, run } = systemdRun()
    try {
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      const r = installWatch(main, { everySec: 120 }, { run, home, env: { PATH: '/p/bin' } })
      assert.equal(r.state, 'installed')
      assert.equal(r.backend, 'systemd')
      const unitDir = join(home, '.config', 'systemd', 'user')
      assert.match(
        readFileSync(join(unitDir, `${unit}.service`), 'utf8'),
        /bro watch --once --notify/
      )
      assert.match(readFileSync(join(unitDir, `${unit}.timer`), 'utf8'), /OnUnitActiveSec=120s/)
      assert.ok(
        calls.some((c) => c.cmd === 'systemctl' && c.args.join(' ').includes('daemon-reload'))
      )
      assert.ok(calls.some((c) => c.args.join(' ').includes('enable --now')))
      // idempotent — same artifacts report already
      const again = installWatch(main, { everySec: 120 }, { run, home, env: { PATH: '/p/bin' } })
      assert.equal(again.state, 'already')
      // a cadence change rewrites — updated, not already
      const faster = installWatch(main, { everySec: 30 }, { run, home, env: { PATH: '/p/bin' } })
      assert.equal(faster.state, 'updated')
      assert.match(readFileSync(join(unitDir, `${unit}.timer`), 'utf8'), /OnUnitActiveSec=30s/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('cron install appends one tagged line, keeps foreign lines', () => {
    const { root, main } = initRepo('bro-watch-cron-')
    const home = tmp()
    const crontabs: string[] = []
    const { run } = fakeRun({
      systemctl: dead(),
      crontab: (args, stdin) => {
        if (args[0] === '-l') {
          return { code: 0, out: '0 0 * * * /usr/bin/foreign\n', err: '' }
        }
        if (args[0] === '-') {
          crontabs.push(stdin ?? '')
          return ok()
        }
        return ok()
      },
    })
    try {
      const r = installWatch(main, { everySec: 60 }, { run, home, env: { PATH: '/p/bin' } })
      assert.equal(r.state, 'installed')
      assert.equal(r.backend, 'cron')
      assert.equal(crontabs.length, 1)
      assert.match(crontabs[0]!, /foreign/)
      assert.match(crontabs[0]!, /# bro-watch-[0-9a-f]{8}/)

      // identical line → already, no rewrite
      const { run: run2, calls: calls2 } = fakeRun({
        systemctl: dead(),
        crontab: (args) => (args[0] === '-l' ? { code: 0, out: crontabs[0]!, err: '' } : ok()),
      })
      const again = installWatch(main, { everySec: 60 }, { run: run2, home, env: { PATH: '/p/bin' } })
      assert.equal(again.state, 'already')
      assert.ok(!calls2.some((c) => c.args[0] === '-'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed crontab read is an error — never a blind write over existing jobs', () => {
    const { root, main } = initRepo('bro-watch-cr-')
    const home = tmp()
    const writes: string[] = []
    const { run } = fakeRun({
      systemctl: dead(),
      crontab: (args, stdin) => {
        if (args[0] === '-l') {
          return { code: 1, out: '', err: 'crontab: permission denied' }
        }
        if (args[0] === '-') {
          writes.push(stdin ?? '')
          return ok()
        }
        return ok()
      },
    })
    try {
      const r = installWatch(main, { everySec: 60 }, { run, home, env: { PATH: '/p' } })
      assert.equal(r.state, 'error')
      assert.match(r.detail, /permission denied/)
      assert.equal(writes.length, 0) // nothing written over the user's table
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a failed crontab strip blocks the systemd install — no double tick', () => {
    const { root, main } = initRepo('bro-watch-dbl-')
    const home = tmp()
    const common = watchCommonDir(main)!
    const table = `0 0 * * * /usr/bin/foreign\n${cronLine(main, 60, '/p', common, '1')}\n`
    const { calls, run } = fakeRun({
      'systemctl --user is-system-running': ok('running\n'),
      crontab: (args) =>
        args[0] === '-l'
          ? { code: 0, out: table, err: '' }
          : { code: 1, out: '', err: 'read-only crontab' },
    })
    try {
      const r = installWatch(main, { everySec: 60 }, { run, home, env: { PATH: '/p' } })
      assert.equal(r.state, 'error')
      assert.match(r.detail, /double-schedule/)
      assert.ok(!calls.some((c) => c.args.join(' ').includes('enable --now')))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('cron install reloads systemd after removing stale units, warns on disable failure', () => {
    const { root, main } = initRepo('bro-watch-mig-')
    const home = tmp()
    try {
      // pre-seed stale units for this repo
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      const unitDir = join(home, '.config', 'systemd', 'user')
      const { calls, run } = fakeRun({
        systemctl: (args) =>
          args.includes('is-system-running')
            ? dead()
            : args.includes('disable')
              ? { code: 1, out: '', err: 'bus not found' }
              : ok(),
        crontab: (args) => (args[0] === '-l' ? { code: 0, out: '', err: '' } : ok()),
      })
      // systemd present enough to probe, user bus dead → cron backend
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(unitDir, `${unit}.service`), 'x')
      writeFileSync(join(unitDir, `${unit}.timer`), 'x')
      const r = installWatch(main, { everySec: 60 }, { run, home, env: { PATH: '/p' } })
      assert.equal(r.state, 'installed')
      assert.match(r.detail, /stale systemd timer may still fire/)
      assert.ok(
        calls.some((c) => c.cmd === 'systemctl' && c.args.join(' ').includes('daemon-reload'))
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--print is pure — artifacts out, nothing installed', () => {
    const { root, main } = initRepo('bro-watch-print-')
    const home = tmp()
    const { calls, run } = systemdRun()
    try {
      const r = installWatch(main, { everySec: 60, print: true }, { run, home, env: { PATH: '/p' } })
      assert.equal(r.state, 'printed')
      assert.match(r.detail, /\[Timer\]/)
      assert.match(r.detail, /bro-watch-[0-9a-f]{8}\.service/)
      assert.match(r.detail, /# bro-watch-[0-9a-f]{8}/)
      assert.ok(!existsSync(join(home, '.config')))
      assert.ok(!calls.some((c) => c.args.includes('enable')))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no scheduler → error that carries the manual artifacts', () => {
    const { root, main } = initRepo('bro-watch-none-')
    const home = tmp()
    try {
      const r = installWatch(main, { everySec: 60 }, { ...noneRun(), home, env: {} })
      assert.equal(r.state, 'error')
      assert.match(r.detail, /no scheduler found/)
      assert.match(r.detail, /\[Timer\]/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('uninstallWatch', () => {
  test('removes the systemd units, reports removed', () => {
    const { root, main } = initRepo('bro-watch-un-')
    const home = tmp()
    const { run } = systemdRun()
    try {
      const common = watchCommonDir(main)!
      const unit = unitName(common)
      installWatch(main, { everySec: 60 }, { run, home, env: { PATH: '/p' } })
      const r = uninstallWatch(main, { run, home, env: {} })
      assert.equal(r.state, 'removed')
      const unitDir = join(home, '.config', 'systemd', 'user')
      assert.ok(!existsSync(join(unitDir, `${unit}.service`)))
      assert.ok(!existsSync(join(unitDir, `${unit}.timer`)))
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
      const table = `0 0 * * * /usr/bin/foreign\n${cronLine(main, 60, '/p', common, '1')}\n`
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

  test('a failed crontab write reports error — never absent while the line remains', () => {
    const { root, main } = initRepo('bro-watch-uwf-')
    const home = tmp()
    try {
      const common = watchCommonDir(main)!
      const table = `${cronLine(main, 60, '/p', common, '1')}\n`
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

describe('printArtifacts', () => {
  test('emits systemd units and the cron line, labeled', () => {
    const { root, main } = initRepo('bro-watch-pa-')
    try {
      const out = printArtifacts(main, 60, '9.9.9', { home: tmp(), env: { PATH: '/p' } })
      assert.equal(typeof out, 'string')
      if (typeof out === 'string') {
        assert.match(out, /bro-watch-[0-9a-f]{8}\.service/)
        assert.match(out, /@broject\/bro@9\.9\.9/)
        assert.match(out, /# or a crontab line/)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
