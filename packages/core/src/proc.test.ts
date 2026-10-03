import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pidAlive, procStat } from './proc.ts'

describe('pidAlive', () => {
  test('pid 0 is dead — kill(0) would signal our own process group', () => {
    assert.equal(pidAlive(0), false)
    assert.equal(pidAlive(0, '1'), false)
  })

  test('negative pids are dead — kill(-pid) signals a process group', () => {
    assert.equal(pidAlive(-1), false)
    assert.equal(pidAlive(-42), false)
  })

  test('non-integer pids are dead input, not live processes', () => {
    assert.equal(pidAlive(Number.NaN), false)
    assert.equal(pidAlive(1.5), false)
  })

  test('a live pid reports alive', () => {
    assert.equal(pidAlive(process.pid), true)
  })

  test('a live pid with a mismatched start is a different process', () => {
    const start = procStat(process.pid)?.start
    assert.notEqual(start, undefined)
    assert.equal(pidAlive(process.pid, '1'), false)
    assert.equal(pidAlive(process.pid, start), true)
  })

  test('an impossible pid reports dead', () => {
    assert.equal(pidAlive(2000000000), false)
  })
})

describe('procStat', () => {
  test('reads state and start of a live process', () => {
    const st = procStat(process.pid)
    assert.notEqual(st, null)
    assert.notEqual(st!.start, '')
    assert.notEqual(st!.state, 'Z')
  })

  test('an unreadable pid is null', () => {
    assert.equal(procStat(2000000000), null)
  })
})
