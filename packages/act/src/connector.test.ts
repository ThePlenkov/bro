import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actConnector } from './connector.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-act-conn-'))
  execFileSync('git', ['init', '-q', dir])
  dirs.push(dir)
  return dir
}

/** A dead-pid supervisor heartbeat — the state a killed `bro <kind>`
 *  leaves behind for the next session start. */
function deadSupervisor(dir: string, kind: string, merge: boolean): void {
  const wd = join(dir, '.git', 'bro', 'watches')
  mkdirSync(wd, { recursive: true })
  writeFileSync(
    join(wd, `7-${kind}-2000000000.json`),
    JSON.stringify({
      pr: 7,
      link: '[#7](https://github.com/o/r/pull/7)',
      pid: 2_000_000_000,
      merge,
      startedAt: Date.now(),
      timeoutMin: 45,
    })
  )
}

const start = (dir: string) => actConnector.hooks!({ dir }).sessionStart!({ dir })

describe('act connector — stale supervisor restart hints', () => {
  test('a dead --no-merge drive marker restarts with --no-merge', async () => {
    const dir = repo()
    deadSupervisor(dir, 'drive', false)
    const stale = (await start(dir)).find((l) => l.includes('stale act watch'))
    assert.ok(stale)
    assert.match(stale, /`bro drive --every --no-merge`/)
  })

  test('a dead merge drive marker restarts plain --every', async () => {
    const dir = repo()
    deadSupervisor(dir, 'drive', true)
    const stale = (await start(dir)).find((l) => l.includes('stale act watch'))
    assert.ok(stale)
    assert.match(stale, /`bro drive --every`/)
    assert.ok(!stale.includes('--no-merge'))
  })

  test('a dead loop marker restarts as `bro loop`', async () => {
    const dir = repo()
    deadSupervisor(dir, 'loop', true)
    const stale = (await start(dir)).find((l) => l.includes('stale act watch'))
    assert.ok(stale)
    assert.match(stale, /`bro loop`/)
  })
})
