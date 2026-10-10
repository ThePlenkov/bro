import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from './agents.ts'
import {
  admitSessionSlot,
  clearSessionPlanes,
  countSessionReservations,
  registerSessionPlane,
  releaseSessionSlot,
  reserveSessionSlot,
  SESSION_SLOT_TTL_MS,
  sessionPlane,
  sessionPlaneForCli,
  sessionPlanes,
  sessionQuotaConfig,
  sessionSlotsDir,
  type SessionPlane,
} from './session-planes.ts'

/** A test plane — no vendor state, countLive reads a scripted number. */
const testPlane = (kind: string, live = 0): SessionPlane => ({
  kind,
  detectsCli: (cli) => cli === `${kind}-cli`,
  countLive: () => live,
})

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-slots-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('session plane registry', () => {
  test('register / lookup / list / clear', () => {
    clearSessionPlanes()
    try {
      const p = testPlane('testkind')
      registerSessionPlane(p)
      assert.equal(sessionPlane('testkind'), p)
      assert.deepEqual(sessionPlanes(), [p])
      assert.equal(sessionPlaneForCli('testkind-cli'), p)
      assert.equal(sessionPlaneForCli('other'), undefined)
      assert.equal(sessionPlane('missing'), undefined)
    } finally {
      clearSessionPlanes()
    }
  })

  test('a plane detecting one cli does not claim another', () => {
    clearSessionPlanes()
    try {
      registerSessionPlane(testPlane('aa'))
      registerSessionPlane(testPlane('bb'))
      assert.equal(sessionPlaneForCli('bb-cli')?.kind, 'bb')
      assert.equal(sessionPlaneForCli('zzz'), undefined)
    } finally {
      clearSessionPlanes()
    }
  })
})

describe('sessionQuotaConfig', () => {
  test('absent bag or explicit 0 → undefined (the deliberate off)', () => {
    assert.equal(sessionQuotaConfig(undefined, 'k'), undefined)
    assert.equal(sessionQuotaConfig({}, 'k'), undefined)
    assert.equal(sessionQuotaConfig({ k: {} }, 'k'), undefined)
    assert.equal(sessionQuotaConfig({ k: { maxSessions: 0 } }, 'k'), undefined)
    assert.equal(sessionQuotaConfig({ k: { maxWorkers: 0 } }, 'k'), undefined)
    assert.equal(sessionQuotaConfig({ k: { maxSessions: 0, maxWorkers: 0 } }, 'k'), undefined)
  })

  test('a present-but-malformed cap flags invalid — a typo must never silently unguard', () => {
    assert.equal(sessionQuotaConfig({ k: { maxSessions: '6' } }, 'k')?.invalid, true)
    assert.equal(sessionQuotaConfig({ k: { maxSessions: 6.5 } }, 'k')?.invalid, true)
    assert.equal(sessionQuotaConfig({ k: { maxSessions: -2 } }, 'k')?.invalid, true)
    assert.equal(sessionQuotaConfig({ k: { maxWorkers: '2' } }, 'k')?.invalid, true)
    assert.equal(sessionQuotaConfig({ k: { maxWorkers: -1 } }, 'k')?.invalid, true)
  })

  test('the malformed knob is named — sessions vs workers', () => {
    assert.equal(
      sessionQuotaConfig({ k: { maxSessions: 'x', maxWorkers: 2 } }, 'k')?.invalidKey,
      'maxSessions'
    )
    assert.equal(
      sessionQuotaConfig({ k: { maxSessions: 6, maxWorkers: 'x' } }, 'k')?.invalidKey,
      'maxWorkers'
    )
  })

  test('maxWorkers alone arms the quota — sessions lane stays uncapped', () => {
    assert.deepEqual(sessionQuotaConfig({ k: { maxWorkers: 2 } }, 'k'), {
      maxSessions: 0,
      maxWorkers: 2,
      reservationsDir: undefined,
    })
  })

  test('a positive integer cap + the dir override pass through', () => {
    assert.deepEqual(sessionQuotaConfig({ k: { maxSessions: 6, reservationsDir: '/tmp/r' } }, 'k'), {
      maxSessions: 6,
      reservationsDir: '/tmp/r',
    })
    assert.deepEqual(
      sessionQuotaConfig({ k: { maxSessions: 6, maxWorkers: 2, reservationsDir: '/tmp/r' } }, 'k'),
      { maxSessions: 6, maxWorkers: 2, reservationsDir: '/tmp/r' }
    )
  })
})

describe('sessionSlotsDir', () => {
  test('explicit override wins; XDG_DATA_HOME otherwise', () => {
    assert.equal(sessionSlotsDir('k', '/tmp/x'), '/tmp/x')
    const prev = process.env['XDG_DATA_HOME']
    try {
      process.env['XDG_DATA_HOME'] = '/tmp/xdg'
      assert.equal(sessionSlotsDir('k'), join('/tmp/xdg', 'bro', 'session-slots', 'k'))
    } finally {
      if (prev === undefined) {
        delete process.env['XDG_DATA_HOME']
      } else {
        process.env['XDG_DATA_HOME'] = prev
      }
    }
  })
})

describe('session slot reservations', () => {
  test('reserve counts, release frees, a missing dir reads as zero', () => {
    assert.equal(countSessionReservations(join(tmpdir(), 'bro-resv-absent-')), 0)
    withDir((dir) => {
      const key = reserveSessionSlot(dir, 'native-abc123')
      assert.equal(countSessionReservations(dir), 1)
      releaseSessionSlot(key)
      assert.equal(countSessionReservations(dir), 0)
    })
  })

  test('expired reservations are reaped, not counted', () => {
    withDir((dir) => {
      reserveSessionSlot(dir, 'native-old')
      const [f] = readdirSync(dir)
      const stale = join(dir, f)
      const past = new Date(Date.now() - SESSION_SLOT_TTL_MS - 60_000)
      utimesSync(stale, past, past)
      assert.equal(countSessionReservations(dir), 0)
      assert.equal(readdirSync(dir).length, 0) // reaped, not just skipped
    })
  })

  test('same-id spawns still claim two slots — no cross-repo clobber', () => {
    withDir((dir) => {
      // two bro processes minting the same agentId in different repos
      // must each hold a slot — a shared filename would double-admit
      reserveSessionSlot(dir, 'native-abc123')
      reserveSessionSlot(dir, 'native-abc123')
      assert.equal(countSessionReservations(dir), 2)
    })
  })

  test('the admission mutex never counts as a reservation', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'admission.mutex'), String(process.pid), { flag: 'wx' })
      try {
        assert.equal(countSessionReservations(dir), 0)
      } finally {
        rmSync(join(dir, 'admission.mutex'), { force: true })
      }
    })
  })
})

describe('admitSessionSlot', () => {
  const plane = testPlane('testkind')

  test('uncapped lane admits nothing — no mutex, no reservation', () => {
    withDir((dir) => {
      assert.equal(
        admitSessionSlot(plane, { testkind: { reservationsDir: dir } }, { key: 'a-1' }),
        undefined
      )
      assert.equal(readdirSync(dir).length, 0)
    })
  })

  test('admits under the cap, refuses at it, releases the slot', () => {
    withDir((resv) => {
      const agents = { testkind: { maxSessions: 1, reservationsDir: resv } }
      const key = admitSessionSlot(plane, agents, { key: 'native-aa' })
      assert.equal(countSessionReservations(resv), 1)
      // the held reservation fills the cap — the next admit refuses
      assert.throws(
        () => admitSessionSlot(plane, agents, { key: 'native-bb', molStep: 'fx-2' }),
        (e: unknown) =>
          e instanceof SpawnError && e.kind === 'cap' && /1\/1 live sessions.*fx-2/.test(e.message)
      )
      releaseSessionSlot(key!)
      assert.doesNotThrow(() => admitSessionSlot(plane, agents, { key: 'native-bb' }))
    })
  })

  test('the plane live count plus reservations share the same count', () => {
    withDir((resv) => {
      const agents = { testkind: { maxSessions: 2, reservationsDir: resv } }
      admitSessionSlot(testPlane('testkind', 1), agents, { key: 'native-aa' })
      // 1 live + 1 reservation = 2/2 — full
      assert.throws(
        () => admitSessionSlot(testPlane('testkind', 1), agents, { key: 'native-bb' }),
        (e: unknown) => e instanceof SpawnError && e.kind === 'cap'
      )
    })
  })

  test('a malformed cap refuses config, never a silent admit', () => {
    withDir((resv) => {
      const agents = { testkind: { maxSessions: 'x', reservationsDir: resv } }
      assert.throws(
        () => admitSessionSlot(plane, agents, { key: 'native-aa', molStep: 'fx-9' }),
        (e: unknown) => e instanceof SpawnError && e.kind === 'config' && /fx-9/.test(e.message)
      )
      assert.equal(countSessionReservations(resv), 0)
    })
  })

  test('a malformed maxWorkers names the right knob in the refusal', () => {
    withDir((resv) => {
      const agents = { testkind: { maxWorkers: 'x', reservationsDir: resv } }
      assert.throws(
        () => admitSessionSlot(plane, agents, { key: 'native-aa' }),
        (e: unknown) =>
          e instanceof SpawnError && e.kind === 'config' && /maxWorkers/.test(e.message)
      )
    })
  })

  test('interactive sessions never fill the worker lane — the split that fixes starvation', () => {
    withDir((resv) => {
      // 4 live sessions, none of them workers — a maxWorkers=1 spawn
      // must still admit under any maxSessions headroom
      const interactive: SessionPlane = {
        kind: 'testkind',
        detectsCli: () => true,
        countLive: () => 4,
        countWorkers: () => 0,
      }
      const agents = { testkind: { maxWorkers: 1, reservationsDir: resv } }
      assert.doesNotThrow(() => admitSessionSlot(interactive, agents, { key: 'native-aa' }))
      // the held reservation IS a worker — the next spawn hits 1+0=1/1
      assert.throws(
        () => admitSessionSlot(interactive, agents, { key: 'native-bb', molStep: 'fx-3' }),
        (e: unknown) =>
          e instanceof SpawnError &&
          e.kind === 'cap' &&
          /1\/1 live workers.*fx-3/.test(e.message)
      )
    })
  })

  test('both lanes guard — the session ceiling still trips first when full', () => {
    withDir((resv) => {
      const p: SessionPlane = {
        kind: 'testkind',
        detectsCli: () => true,
        countLive: () => 6,
        countWorkers: () => 0,
      }
      const agents = { testkind: { maxSessions: 6, maxWorkers: 4, reservationsDir: resv } }
      assert.throws(
        () => admitSessionSlot(p, agents, { key: 'native-aa' }),
        (e: unknown) => e instanceof SpawnError && e.kind === 'cap' && /sessions/.test(e.message)
      )
    })
  })

  test('maxWorkers on a plane that cannot count workers refuses config', () => {
    withDir((resv) => {
      const agents = { testkind: { maxWorkers: 2, reservationsDir: resv } }
      assert.throws(
        () => admitSessionSlot(plane, agents, { key: 'native-aa', molStep: 'fx-7' }),
        (e: unknown) =>
          e instanceof SpawnError &&
          e.kind === 'config' &&
          /cannot distinguish worker sessions.*fx-7/.test(e.message)
      )
      assert.equal(countSessionReservations(resv), 0)
    })
  })

  test('a plane count failure propagates as unavailable — fails closed', () => {
    withDir((resv) => {
      const blind: SessionPlane = {
        kind: 'testkind',
        detectsCli: () => true,
        countLive: () => {
          throw new SpawnError('state dir unreadable', 'unavailable')
        },
      }
      const agents = { testkind: { maxSessions: 4, reservationsDir: resv } }
      assert.throws(
        () => admitSessionSlot(blind, agents, { key: 'native-aa' }),
        (e: unknown) => e instanceof SpawnError && e.kind === 'unavailable'
      )
      assert.equal(countSessionReservations(resv), 0)
    })
  })

  test('a live mutex holder in ANOTHER process serializes the admit', async () => {
    const resv = mkdtempSync(join(tmpdir(), 'bro-admit-resv-'))
    try {
      // a child plants the admission mutex with its own live pid and
      // holds it ~600ms — the parent's admit must wait, then succeed
      const mutex = join(resv, 'admission.mutex')
      const child = spawn(
        process.execPath,
        [
          '-e',
          `const fs=require('fs');fs.writeFileSync(${JSON.stringify(mutex)},String(process.pid),{flag:'wx'});setTimeout(()=>process.exit(0),600)`,
        ],
        { stdio: 'ignore' }
      )
      await new Promise<void>((res) => {
        // hand the child a beat to plant the file
        const t0 = Date.now()
        const tick = (): void => {
          if (existsSync(mutex) || Date.now() - t0 > 3000) {
            res()
          } else {
            setTimeout(tick, 20)
          }
        }
        tick()
      })
      const started = Date.now()
      const key = admitSessionSlot(
        plane,
        { testkind: { maxSessions: 4, reservationsDir: resv } },
        { key: 'native-aa' }
      )
      // admitted only after the child's hold ended — serialization visible in wall time
      assert.ok(
        Date.now() - started >= 400,
        `admit returned in ${Date.now() - started}ms — the mutex was not honored`
      )
      releaseSessionSlot(key!)
      await new Promise<void>((res) => child.on('exit', res))
    } finally {
      rmSync(resv, { recursive: true, force: true })
    }
  })
})
