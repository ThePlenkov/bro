/** The host-wide session cap — the policy, vendor-blind (spec bro-bww9v).
 *
 *  The policy asks the plane registry: which kind would this command
 *  start a session of, how many, and how many are live. No vendor name
 *  appears here — the plane owns the grammar and the count.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from './agents.ts'
import {
  clearSessionPlanes,
  registerSessionPlane,
  type SessionPlane,
} from './session-planes.ts'
import {
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
      })
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
