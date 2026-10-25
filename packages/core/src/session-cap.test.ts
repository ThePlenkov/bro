/** The host-wide session cap — the policy, vendor-blind (spec bro-bww9v).
 *
 *  The policy asks the plane registry: which kind would this command
 *  start a session of, how many, and how many are live. No vendor name
 *  appears here — the plane owns the grammar and the count.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from './agents.ts'
import { LockTimeout } from './filelock.ts'
import {
  clearSessionPlanes,
  countSessionReservations,
  registerSessionPlane,
  reserveSessionSlot,
  type SessionPlane,
} from './session-planes.ts'
import {
  admitSessionStart,
  planeStartingSessions,
  sessionCapRefusal,
  sessionCapRefusalFor,
  sessionCapViews,
} from './session-cap.ts'

/** A plane that claims a command by a marker word and counts a
 *  scripted number of live sessions. */
const testPlane = (
  kind: string,
  opts: { live?: number; starts?: number; fail?: boolean } = {}
): SessionPlane => ({
  kind,
  detectsCli: (cli) => cli === `${kind}-cli`,
  startsSessions: (command) =>
    command.includes(`${kind}-run`) ? (opts.starts ?? 1) : 0,
  countLive: () => {
    if (opts.fail === true) {
      throw new SpawnError(`cannot count ${kind}`, 'unavailable')
    }
    return opts.live ?? 0
  },
})

const withPlane = (plane: SessionPlane, fn: () => void): void => {
  clearSessionPlanes()
  try {
    registerSessionPlane(plane)
    fn()
  } finally {
    clearSessionPlanes()
  }
}

/** A reservations dir the cap reads — the count includes what bro holds
 *  for in-flight starts. */
const withSlots = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-cap-slots-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('sessionCapViews', () => {
  test('a kind whose plane claims the command contributes a view', () => {
    withPlane(testPlane('alpha', { live: 2 }), () => {
      const views = sessionCapViews('alpha-run --now', {
        alpha: { maxSessions: 5, reservationsDir: '/nonexistent' },
      })
      assert.equal(views.length, 1)
      assert.equal(views[0]?.kind, 'alpha')
      assert.equal(views[0]?.live, 2)
      assert.equal(views[0]?.cap, 5)
      assert.equal(views[0]?.starts, 1)
    })
  })

  test('a command no plane claims contributes nothing', () => {
    withPlane(testPlane('alpha', { live: 9 }), () => {
      assert.deepEqual(sessionCapViews('other-thing', { alpha: { maxSessions: 1 } }), [])
    })
  })

  test('a kind with no cap armed contributes nothing', () => {
    withPlane(testPlane('alpha', { live: 9 }), () => {
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: {} }), [])
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: { maxSessions: 0 } }), [])
      assert.deepEqual(sessionCapViews('alpha-run', undefined), [])
    })
  })

  test('a plane without startsSessions never claims a command', () => {
    const plane: SessionPlane = {
      kind: 'alpha',
      detectsCli: () => true,
      countLive: () => 0,
    }
    withPlane(plane, () => {
      assert.deepEqual(sessionCapViews('alpha-run', { alpha: { maxSessions: 1 } }), [])
    })
  })

  test('reservations count with the live sessions', () => {
    withSlots((dir) => {
      withPlane(testPlane('alpha', { live: 1 }), () => {
        const views = sessionCapViews('alpha-run', {
          alpha: { maxSessions: 5, reservationsDir: dir },
        })
        // no reservation files yet — the count is the live one
        assert.equal(views[0]?.live, 1)
        // a claimed slot (a start in flight) counts with it
        reserveSessionSlot(dir, 'alpha-guard', 'interactive')
        const claimed = sessionCapViews('alpha-run', {
          alpha: { maxSessions: 5, reservationsDir: dir },
        })
        assert.equal(claimed[0]?.live, 2)
      })
    })
  })

  test('a malformed cap refuses — a typo is never an uncapped kind', () => {
    withPlane(testPlane('alpha', { live: 0 }), () => {
      assert.throws(
        () => sessionCapViews('alpha-run', { alpha: { maxSessions: 'six' } }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'config'
      )
    })
  })

  test('an unverifiable count throws — the caller decides', () => {
    withPlane(testPlane('alpha', { fail: true }), () => {
      assert.throws(
        () => sessionCapViews('alpha-run', { alpha: { maxSessions: 5 } }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'unavailable'
      )
    })
  })
})

describe('sessionCapRefusal', () => {
  test('a start that fits is allowed', () => {
    assert.equal(
      sessionCapRefusal({ kind: 'alpha', live: 2, cap: 3, starts: 1 }),
      undefined
    )
  })

  test('a start that would cross the cap is refused, with the numbers', () => {
    const refusal = sessionCapRefusal({ kind: 'alpha', live: 3, cap: 3, starts: 1 })
    assert.ok(refusal !== undefined)
    assert.match(refusal, /alpha/)
    assert.match(refusal, /3 live \+ 1 starting > 3/)
    assert.match(refusal, /agents\.alpha\.maxSessions/)
  })

  test('a command starting several sessions is judged against all of them', () => {
    // 1 live + 2 starting = 3 → fits a cap of 3
    assert.equal(
      sessionCapRefusal({ kind: 'alpha', live: 1, cap: 3, starts: 2 }),
      undefined
    )
    // 2 live + 2 starting = 4 → over a cap of 3
    const over = sessionCapRefusal({ kind: 'alpha', live: 2, cap: 3, starts: 2 })
    assert.ok(over !== undefined)
    assert.match(over, /2 live \+ 2 starting > 3/)
  })

  test('an uncapped kind is never refused', () => {
    assert.equal(
      sessionCapRefusal({ kind: 'alpha', live: 99, cap: 0, starts: 5 }),
      undefined
    )
  })
})

describe('sessionCapRefusalFor', () => {
  test('the first refusal among the kinds wins', () => {
    clearSessionPlanes()
    try {
      registerSessionPlane(testPlane('alpha', { live: 9 }))
      registerSessionPlane(testPlane('beta', { live: 9 }))
      const refusal = sessionCapRefusalFor('alpha-run beta-run', {
        alpha: { maxSessions: 1 },
        beta: { maxSessions: 1 },
      })
      assert.ok(refusal !== undefined)
      assert.match(refusal, /alpha/)
    } finally {
      clearSessionPlanes()
    }
  })
})

describe('planeStartingSessions', () => {
  test('the plane that claims the command is found', () => {
    withPlane(testPlane('alpha'), () => {
      assert.equal(planeStartingSessions('alpha-run')?.kind, 'alpha')
      assert.equal(planeStartingSessions('nope'), undefined)
    })
  })
})

describe('admitSessionStart', () => {
  test('a start below the cap is admitted and its slot claimed', () => {
    withSlots((dir) => {
      const plane = testPlane('alpha', { live: 1 })
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 3, reservationsDir: dir } },
          key: 'call-1',
        })
        assert.ok(admitted !== undefined)
        assert.equal(admitted.refusal, undefined)
        assert.equal(admitted.fresh, true)
        // the claim landed — the next start sees it in the count
        assert.equal(countSessionReservations(dir), 1)
        assert.equal(admitted.paths.length, 1)
      })
    })
  })

  test('a burst shares one budget — the second start sees the first claim', () => {
    withSlots((dir) => {
      const plane = testPlane('alpha', { live: 0 })
      withPlane(plane, () => {
        const bags = { alpha: { maxSessions: 1, reservationsDir: dir } }
        const first = admitSessionStart({ plane, command: 'alpha-run', agents: bags, key: 'call-1' })
        assert.equal(first?.refusal, undefined)
        const second = admitSessionStart({ plane, command: 'alpha-run', agents: bags, key: 'call-2' })
        assert.ok(second !== undefined)
        assert.match(second.refusal ?? '', /alpha session quota reached — 1 live \+ 1 starting > 1/)
        // the refused claim was dropped — the budget holds only the admitted one
        assert.equal(countSessionReservations(dir), 1)
      })
    })
  })

  test('a repeat event of the same call claims no second slot and is judged once', () => {
    withSlots((dir) => {
      const plane = testPlane('alpha', { live: 0 })
      withPlane(plane, () => {
        const bags = { alpha: { maxSessions: 1, reservationsDir: dir } }
        assert.equal(
          admitSessionStart({ plane, command: 'alpha-run', agents: bags, key: 'call-1' })?.refusal,
          undefined
        )
        // the second hook event of the same call: its earlier claim is
        // inside the count — judging starts again would double-count
        const repeat = admitSessionStart({ plane, command: 'alpha-run', agents: bags, key: 'call-1' })
        assert.ok(repeat !== undefined)
        assert.equal(repeat.fresh, false)
        assert.equal(repeat.refusal, undefined)
        assert.equal(countSessionReservations(dir), 1)
      })
    })
  })

  test('extraLive counts sessions the caller holds that the plane cannot see', () => {
    withSlots((dir) => {
      const plane = testPlane('alpha', { live: 0 })
      withPlane(plane, () => {
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 2, reservationsDir: dir } },
          key: 'call-1',
          extraLive: 2,
        })
        assert.match(admitted?.refusal ?? '', /2 live \+ 1 starting > 2/)
      })
    })
  })

  test('a command the plane does not claim, or an unarmed cap, admits nothing', () => {
    const plane = testPlane('alpha', { live: 9 })
    withPlane(plane, () => {
      assert.equal(
        admitSessionStart({
          plane,
          command: 'other-thing',
          agents: { alpha: { maxSessions: 1 } },
          key: 'call-1',
        }),
        undefined
      )
      assert.equal(
        admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: {} },
          key: 'call-1',
        }),
        undefined
      )
    })
  })

  test('a malformed cap refuses config under the lock too', () => {
    const plane = testPlane('alpha', { live: 0 })
    withPlane(plane, () => {
      assert.throws(
        () =>
          admitSessionStart({
            plane,
            command: 'alpha-run',
            agents: { alpha: { maxSessions: 'six' } },
            key: 'call-1',
          }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'config'
      )
    })
  })

  test('an unverifiable count throws — the caller decides', () => {
    const plane = testPlane('alpha', { fail: true })
    withPlane(plane, () => {
      assert.throws(
        () =>
          admitSessionStart({
            plane,
            command: 'alpha-run',
            agents: { alpha: { maxSessions: 1 } },
            key: 'call-1',
          }),
        (err: unknown) => err instanceof SpawnError && err.kind === 'unavailable'
      )
    })
  })

  test('a live mutex holder outlasting the wait throws LockTimeout — the caller owns the fallback', () => {
    withSlots((dir) => {
      const plane = testPlane('alpha', { live: 0 })
      withPlane(plane, () => {
        // a live holder (this pid) parks on the kind's admission mutex
        const mutex = join(dir, 'admission.mutex')
        writeFileSync(mutex, String(process.pid), { flag: 'wx' })
        try {
          assert.throws(
            () =>
              admitSessionStart({
                plane,
                command: 'alpha-run',
                agents: { alpha: { maxSessions: 1, reservationsDir: dir } },
                key: 'call-1',
                waitMs: 150,
              }),
            (err: unknown) => err instanceof LockTimeout
          )
        } finally {
          rmSync(mutex, { force: true })
        }
      })
    })
  })

  test('the cap waits on the same mutex a spawn admission takes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-cap-mutex-'))
    try {
      const plane = testPlane('alpha', { live: 0 })
      // a child plants the admission mutex with its own live pid and
      // holds it ~600ms — the cap's admit must wait, then succeed
      const mutex = join(dir, 'admission.mutex')
      const child = spawn(
        process.execPath,
        [
          '-e',
          `const fs=require('fs');fs.writeFileSync(${JSON.stringify(mutex)},String(process.pid),{flag:'wx'});setTimeout(()=>process.exit(0),600)`,
        ],
        { stdio: 'ignore' }
      )
      await new Promise<void>((res) => {
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
      clearSessionPlanes()
      try {
        registerSessionPlane(plane)
        const admitted = admitSessionStart({
          plane,
          command: 'alpha-run',
          agents: { alpha: { maxSessions: 4, reservationsDir: dir } },
          key: 'call-1',
        })
        assert.equal(admitted?.refusal, undefined)
      } finally {
        clearSessionPlanes()
      }
      // admitted only after the child's hold ended — serialization
      // visible in wall time (same proof the spawn admission's test runs)
      assert.ok(
        Date.now() - started >= 400,
        `admit returned in ${Date.now() - started}ms — the mutex was not honored`
      )
      await new Promise<void>((res) => child.on('exit', res))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
