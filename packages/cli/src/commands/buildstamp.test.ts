/** build-stamp tests (bro-fatja) — the record's contract: a stamped
 *  write names its session, its HEAD, and its input fingerprint; the
 *  readers (doctor/status/`bro stamp`) must never guess "not yours". */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  inputsFingerprint,
  readStamp,
  stampSession,
  writeStamp,
} from './buildstamp.ts'
import { git, initRepo, inside } from './testrepo.ts'

const SESSION_VARS = [
  'BRO_SESSION_ID',
  'BRO_AGENT_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
]

/** Session env pins must not leak the dev's own session into fixtures —
 *  same isolation the e2e env whitelist gives spawned processes. */
function cleanSessionEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of SESSION_VARS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** A live ownerless session marker — fresh mtime, no pid. */
function liveMarker(hooksDir: string, sid: string): void {
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(join(hooksDir, `${sid}.work`), `${Date.now()}\n`)
}

describe('readStamp/writeStamp', () => {
  test('roundtrip — the record lands in the worktree git dir and reads back', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () => {
      assert.equal(readStamp(main), null)
      const head = git(['rev-parse', 'HEAD'], main).trim()
      const stamp = writeStamp(main, { via: 'build', session: 'ses-1' })!
      assert.equal(stamp.session, 'ses-1')
      assert.equal(stamp.via, 'build')
      assert.equal(stamp.head, head)
      assert.match(stamp.inputs, /^[0-9a-f]{64}$/)
      assert.ok(existsSync(join(main, '.git', 'bro', 'last-build.json')))
      const back = readStamp(main)!
      assert.deepEqual(back, stamp)
    })
  })

  test('a linked worktree stamps its own gitdir, not the common one', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () => {
      const wt2 = join(root, 'wt2')
      git(['worktree', 'add', '-q', wt2, '-b', 'wt2'], main)
      writeStamp(wt2, { via: 'patch', session: 'ses-2' })
      const stamp = readStamp(wt2)!
      assert.equal(stamp.via, 'patch')
      // the record must be under worktrees/<name>/bro — the shared
      // .git/bro would attribute one worktree's write to all of them
      assert.ok(!existsSync(join(main, '.git', 'bro', 'last-build.json')))
      assert.equal(readStamp(main), null)
    })
  })

  test('corrupt records read as "no stamp", never throw', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () => {
      mkdirSync(join(main, '.git', 'bro'))
      writeFileSync(join(main, '.git', 'bro', 'last-build.json'), '{ not json')
      assert.equal(readStamp(main), null)
      writeFileSync(join(main, '.git', 'bro', 'last-build.json'), '{"ts":"NaN"}')
      assert.equal(readStamp(main), null)
    })
  })
})

describe('stampSession', () => {
  test('env pin wins; BRO_AGENT_ID is the worker fallback', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () =>
      cleanSessionEnv(() => {
        process.env.BRO_SESSION_ID = 'ses-env'
        assert.equal(stampSession(main, process.env), 'ses-env')
        delete process.env.BRO_SESSION_ID
        process.env.BRO_AGENT_ID = 'agent-9'
        assert.equal(stampSession(main, process.env), 'agent-9')
      })
    )
  })

  test('marker scan: exactly one live session names it; zero or many abstain', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () =>
      cleanSessionEnv(() => {
        const hooks = join(main, '.git', 'bro', 'hooks')
        assert.equal(stampSession(main, process.env), undefined)
        liveMarker(hooks, 'ses-a')
        assert.equal(stampSession(main, process.env), 'ses-a')
        liveMarker(hooks, 'ses-b')
        assert.equal(stampSession(main, process.env), undefined)
      })
    )
  })
})

describe('inputsFingerprint', () => {
  test('stable when the tree is unchanged, moves on edits and commits', () => {
    const { root, main } = initRepo('bro-stamp-')
    inside(main, root, () => {
      const clean = inputsFingerprint(main)
      assert.equal(inputsFingerprint(main), clean)
      writeFileSync(join(main, 'dirty.txt'), 'x')
      const untracked = inputsFingerprint(main)
      assert.notEqual(untracked, clean)
      git(['add', 'dirty.txt'], main)
      assert.notEqual(inputsFingerprint(main), untracked) // ?? → A
      git(['commit', '-qm', 'dirty'], main)
      const committed = inputsFingerprint(main)
      assert.notEqual(committed, untracked) // head moved
      assert.equal(inputsFingerprint(main), committed) // clean again
    })
  })
})
