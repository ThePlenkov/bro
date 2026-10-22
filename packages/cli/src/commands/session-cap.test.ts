/** The session cap at the call sites the admission does not cover (spec
 *  bro-bww9v): the guard plane's veto and the ACP surface's refusal. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearSessionPlanes,
  registerSessionPlane,
  sessionCapViews,
  type PreToolVerdict,
  type SessionPlane,
} from '@broject/core'
import {
  conductorSessionRefusal,
  sessionCapRefusalForHook,
  sessionCapVerdict,
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
      throw new Error('cannot count')
    }
    return opts.live ?? 0
  },
})

const ctx = { dir: process.cwd(), sessionId: 'sess-1' } as never

/** The guard's verdict for a command, under a given config. */
const verdictFor = (
  command: string,
  bags: Record<string, Record<string, unknown>>
): PreToolVerdict[] =>
  sessionCapVerdict(ctx, { tool: 'bash', input: { command } }, bags)

const withPlane = (plane: SessionPlane, fn: () => void): void => {
  clearSessionPlanes()
  try {
    registerSessionPlane(plane)
    fn()
  } finally {
    clearSessionPlanes()
  }
}

/** A scratch reservations dir — the claim files live here, never in the
 *  developer's real data home (a claim that outlives the test would
 *  count against the next run). */
const withReservations = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-cap-resv-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('sessionCapVerdict', () => {
  test('a start at the cap is vetoed', () => {
    withReservations((dir) => {
    withPlane(testPlane('fake', { live: 3 }), () => {
      const verdicts = verdictFor('fake-run --now', {
        fake: { maxSessions: 3, reservationsDir: dir },
      })
      assert.equal(verdicts.length, 1)
      assert.match(verdicts[0]!.block ?? '', /fake session quota reached/)
    })
    })
  })

  test('a start below the cap is allowed', () => {
    withReservations((dir) => {
      withPlane(testPlane('fake', { live: 1 }), () => {
        const verdicts = verdictFor('fake-run --now', {
          fake: { maxSessions: 3, reservationsDir: dir },
        })
        assert.deepEqual(verdicts, [])
      })
    })
  })

  test('a command no plane claims is never touched', () => {
    withPlane(testPlane('fake', { live: 99 }), () => {
      const verdicts = verdictFor('ls -la', { fake: { maxSessions: 3 } })
      assert.deepEqual(verdicts, [])
    })
  })

  test('a tool call without a command is never touched', () => {
    withPlane(testPlane('fake', { live: 99 }), () => {
      const verdicts = sessionCapVerdict(
        ctx,
        { tool: 'read', input: { file_path: '/x' } },
        { fake: { maxSessions: 3 } }
      )
      assert.deepEqual(verdicts, [])
    })
  })

  test('an unverifiable count fails OPEN — a hook never stalls the client', () => {
    withPlane(testPlane('fake', { fail: true }), () => {
      const verdicts = verdictFor('fake-run --now', { fake: { maxSessions: 3 } })
      assert.deepEqual(verdicts, [])
    })
  })

  test('an allowed start claims the slot — a burst shares one budget', () => {
    withReservations((dir) => {
      withPlane(testPlane('burst', { live: 0 }), () => {
        const bags = { burst: { maxSessions: 1, reservationsDir: dir } }
        // the cap is 1: the first start is allowed and claims the slot
        const first = verdictFor('burst-run --now', bags)
        assert.deepEqual(first, [])
        // the second start sees the claim and is refused
        const second = verdictFor('burst-run --now', bags)
        assert.equal(second.length, 1)
        assert.match(second[0]!.block ?? '', /burst session quota reached/)
      })
    })
  })
})

describe('sessionCapRefusalForHook', () => {
  test('the devin client vetoes a session start at the cap', () => {
    withReservations((dir) => {
      withPlane(testPlane('devin', { live: 3 }), () => {
        const refusal = sessionCapRefusalForHook(
          'devin-run --now',
          process.cwd(),
          'sess-1',
          { devin: { maxSessions: 3, reservationsDir: dir } }
        )
        assert.ok(refusal !== undefined)
        assert.match(refusal, /devin session quota reached/)
      })
    })
  })

  test('a command that starts nothing is never refused', () => {
    withReservations((dir) => {
      withPlane(testPlane('devin', { live: 3 }), () => {
        assert.equal(
          sessionCapRefusalForHook('ls -la', process.cwd(), 'sess-1', {
            devin: { maxSessions: 3, reservationsDir: dir },
          }),
          undefined
        )
      })
    })
  })
})

describe('conductorSessionRefusal', () => {
  test('the retained conversations count with the host', () => {
    const view = sessionCapViews('nope', { fake: { maxSessions: 3 } })[0]
    assert.equal(conductorSessionRefusal(undefined, 5), undefined)
    const v = { kind: 'fake', live: 1, cap: 3, starts: 1 }
    assert.equal(conductorSessionRefusal(v, 1), undefined)
    assert.ok(conductorSessionRefusal(v, 2) !== undefined)
  })
})
