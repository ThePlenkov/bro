import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { writeStamp } from './buildstamp.ts'
import { collectStatus } from './status.ts'
import { tmpDir } from './testrepo.ts'

// bd resolves BEADS_DIR before any .beads discovery — a session that
// pinned it (agent env) would leak the real store into the bare-repo
// fixture. Point it at a guaranteed-empty dir for this file.
process.env.BEADS_DIR = tmpDir('bro-status-beads-')

function gitRepo(): string {
  const dir = tmpDir('bro-status-')
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'a')
  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

describe('collectStatus', () => {
  test('a bare repo answers — empty sections, never errors', () => {
    const s = collectStatus(gitRepo())
    assert.equal(s.branch, 'main')
    assert.equal(s.dirty, 0)
    assert.deepEqual(s.beads, { inProgress: [], ready: [], readyTotal: 0 })
    assert.deepEqual(s.fleet.agents, [])
    assert.equal(s.drill.frame, null)
    assert.equal(s.act, undefined)
  })

  test('dirty count reflects porcelain — untracked included', () => {
    const dir = gitRepo()
    writeFileSync(join(dir, 'untracked.txt'), 'x')
    assert.equal(collectStatus(dir).dirty, 1)
    execFileSync('git', ['add', 'untracked.txt'], { cwd: dir })
    assert.equal(collectStatus(dir).dirty, 1)
    execFileSync('git', ['commit', '-m', 'x'], { cwd: dir })
    assert.equal(collectStatus(dir).dirty, 0)
  })

  test('the heartbeat file surfaces as the watch row; absent is null', () => {
    const dir = gitRepo()
    assert.equal(collectStatus(dir).watch, null)
    const bro = join(dir, '.git', 'bro')
    mkdirSync(bro, { recursive: true })
    const ts = new Date(Date.now() - 4 * 60_000).toISOString()
    writeFileSync(
      join(bro, 'heartbeat.json'),
      JSON.stringify({ ts, attention: ['x', 'y'] })
    )
    const w = collectStatus(dir).watch
    assert.equal(w?.ts, ts)
    assert.equal(w?.attention, 2)
    assert.ok(w !== null && w.ageMs >= 4 * 60_000)
  })

  test('build field reads the worktree stamp — null until one lands (bro-fatja)', () => {
    const dir = gitRepo()
    assert.equal(collectStatus(dir).build, null)
    writeStamp(dir, { via: 'build', session: 'ses-x' })
    const s = collectStatus(dir)
    assert.equal(s.build?.via, 'build')
    assert.equal(s.build?.session, 'ses-x')
    assert.equal(s.build?.behind, false)
    // a bare status tick can't attribute the stamp to a resolved
    // caller — clear the pins so the ambient session can't leak in
    const vars = ['BRO_SESSION_ID', 'BRO_AGENT_ID', 'DEVIN_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'OPENCODE_SESSION_ID']
    const saved = vars.map((k) => [k, process.env[k]] as const)
    for (const k of vars) delete process.env[k]
    try {
      assert.equal(collectStatus(dir).build?.mine, null)
      process.env.BRO_SESSION_ID = 'ses-x'
      assert.equal(collectStatus(dir).build?.mine, true)
      process.env.BRO_SESSION_ID = 'ses-y'
      assert.equal(collectStatus(dir).build?.mine, false)
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
