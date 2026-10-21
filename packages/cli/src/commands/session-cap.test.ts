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
import { conductorSessionRefusal, sessionCapVerdict } from './session-cap.ts'

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

/** A scratch data home — the reservation dir lives under it. */
const withDataHome = (fn: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), 'bro-cap-home-'))
  const prev = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = home
  try {
    fn(home)
  } finally {
    if (prev === undefined) {
      delete process.env['XDG_DATA_HOME']
    } else {
      process.env['XDG_DATA_HOME'] = prev
    }
    rmSync(home, { recursive: true, force: true })
  }
}

describe('sessionCapVerdict', () => {
  test('a start at the cap is vetoed', () => {
    withPlane(testPlane('fake', { live: 3 }), () => {
      const verdicts = verdictFor('fake-run --now', { fake: { maxSessions: 3 } })
      assert.equal(verdicts.length, 1)
      assert.match(verdicts[0]!.block ?? '', /fake session quota reached/)
    })
  })

  test('a start below the cap is allowed', () => {
    withPlane(testPlane('fake', { live: 1 }), () => {
      const verdicts = verdictFor('fake-run --now', { fake: { maxSessions: 3 } })
      assert.deepEqual(verdicts, [])
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
    withDataHome(() => {
      withPlane(testPlane('burst', { live: 0 }), () => {
        // the cap is 1: the first start is allowed and claims the slot
        const first = verdictFor('burst-run --now', { burst: { maxSessions: 1 } })
        assert.deepEqual(first, [])
        // the second start sees the claim and is refused
        const second = verdictFor('burst-run --now', { burst: { maxSessions: 1 } })
        assert.equal(second.length, 1)
        assert.match(second[0]!.block ?? '', /burst session quota reached/)
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
