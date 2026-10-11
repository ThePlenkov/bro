import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncAfterAudit } from './loop.ts'
import { runSyncCommand } from './sync.ts'
import { initRepo, inside, tmpDir } from './testrepo.ts'

/** process.exit stubbed into a throw — `runSyncCommand` runs in-process
 *  inside the loop's exit audit, so a hard exit anywhere on its path
 *  would kill the calling runner mid-write (bro-qjbwq). Failures must
 *  surface as throws; an exit attempt surfaces here as ExitSignal so a
 *  reintroduced process.exit fails the assertion, not the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

/** Run fn() capturing console lines; any process.exit throws ExitSignal. */
const capture = (fn: () => void): { out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  console.log = (m?: unknown) => out.push(String(m))
  console.error = (m?: unknown) => err.push(String(m))
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit
  try {
    fn()
  } finally {
    console.log = origLog
    console.error = origErr
    process.exit = origExit
  }
  return { out, err }
}

/** Threw a real error, not an exit attempt — the in-process contract. */
const threwNotExited = (match: RegExp) => (e: unknown) =>
  e instanceof Error && !(e instanceof ExitSignal) && match.test(e.message)

describe('runSyncCommand', () => {
  // artifactDirs reads BRO_DEBT_DIR — an ambient pin would add a second
  // sync dir outside the fixture and make assertions env-dependent
  const ambientDebtDir = process.env.BRO_DEBT_DIR
  delete process.env.BRO_DEBT_DIR
  after(() => {
    if (ambientDebtDir !== undefined) process.env.BRO_DEBT_DIR = ambientDebtDir
  })

  test('outside a worktree it throws — never exits the host process', () => {
    const dir = tmpDir('bro-sync-norepo-')
    inside(dir, dir, () => {
      assert.throws(() => capture(() => runSyncCommand([])), threwNotExited(/not inside a git worktree/))
    })
  })

  test('a mid-write crash throws — the audit degrades it to a warning', () => {
    const { root, main } = initRepo('bro-sync-enospc-')
    inside(main, root, () => {
      // .agents/ gives sync something to commit; a dead tmpdir makes the
      // data-ref write crash the same way a full /tmp did (mkdtemp
      // ENOSPC — same propagation, different errno)
      mkdirSync(join(main, '.agents'), { recursive: true })
      const tmp = process.env.TMPDIR
      process.env.TMPDIR = join(main, 'no-such-dir')
      try {
        assert.throws(() => capture(() => runSyncCommand([])), threwNotExited(/ENOENT|no such file/i))
      } finally {
        if (tmp === undefined) {
          delete process.env.TMPDIR
        } else {
          process.env.TMPDIR = tmp
        }
      }
    })
  })

  test('a repo sync commits artifacts without throwing or exiting', () => {
    const { root, main } = initRepo('bro-sync-ok-', (m) =>
      writeFileSync(join(m, '.gitignore'), '.agents\n')
    )
    inside(main, root, () => {
      mkdirSync(join(main, '.agents'), { recursive: true })
      writeFileSync(join(main, '.agents', 'x.jsonl'), '{"a":1}\n')
      const { out } = capture(() => runSyncCommand([]))
      assert.ok(
        out.some((l) => /bro sync: \.agents → refs\/bro\/data/.test(l)),
        out.join('\n')
      )
    })
  })
})

describe('syncAfterAudit', () => {
  test('a throw from the sync degrades to a warning line', () => {
    const { err, out } = capture(() =>
      syncAfterAudit({ json: false }, () => {
        throw new Error('ENOSPC: no space left on device')
      })
    )
    assert.deepEqual(err, [])
    assert.ok(
      out.some((l) => /warning: bro sync failed — ENOSPC: no space left on device/.test(l)),
      out.join('\n')
    )
  })

  test('a process.exit inside the sync degrades to a warning — the runner survives', () => {
    const { out } = capture(() =>
      syncAfterAudit({ json: false }, () => {
        process.exit(7)
      })
    )
    assert.ok(
      out.some((l) => /warning: bro sync failed — bro sync called process\.exit\(7\)/.test(l)),
      out.join('\n')
    )
  })

  test('a clean sync prints no warning', () => {
    const { out } = capture(() => syncAfterAudit({ json: false }, () => {}))
    assert.deepEqual(out, [])
  })
})
