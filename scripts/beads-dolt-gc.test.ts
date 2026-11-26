import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, commandsFor, storesUnder } from './beads-dolt-gc.ts'

function fixture(): string {
  const beads = mkdtempSync(join(tmpdir(), 'bro-dolt-gc-'))
  writeFileSync(join(beads, 'metadata.json'), '{}')
  mkdirSync(join(beads, 'embeddeddolt', 'main', '.dolt'), { recursive: true })
  mkdirSync(join(beads, 'dolt-mirror-origin.git'), { recursive: true })
  writeFileSync(join(beads, 'dolt-mirror-origin.git', 'HEAD'), 'ref: refs/heads/main\n')
  return beads
}

test('discovers embedded stores and the origin mirror maintenance commands', () => {
  const beads = fixture()
  try {
    assert.deepEqual(storesUnder(beads), [join(beads, 'embeddeddolt', 'main')])
    assert.deepEqual(commandsFor(beads), [
      { cwd: join(beads, 'embeddeddolt', 'main'), args: ['gc'], label: `dolt gc (${join(beads, 'embeddeddolt', 'main')})` },
      { cwd: join(beads, 'dolt-mirror-origin.git'), args: ['gc', '--prune=now'], label: `git gc (${join(beads, 'dolt-mirror-origin.git')})` },
    ])
  } finally { rmSync(beads, { recursive: true, force: true }) }
})

test('lock is released and can be acquired again', () => {
  const beads = fixture()
  try {
    const release = acquireLock(beads)
    assert.equal(readFileSync(join(beads, '.bro-dolt-gc.lock', 'pid'), 'utf8').trim(), String(process.pid))
    release()
    const releaseAgain = acquireLock(beads)
    releaseAgain()
  } finally { rmSync(beads, { recursive: true, force: true }) }
})
