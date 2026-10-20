import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  foreignPushEvent,
  readHeadMemory,
  sessionArmedPrs,
  writeHeadMemory,
} from './foreign-push.ts'

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fpush-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A git repo with a common dir — the memory lives under it. */
const withRepo = (fn: (dir: string) => void): void => {
  withDir((root) => {
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'config', 'user.email', 't@t'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'config', 'user.name', 't'], { stdio: 'ignore' })
    fn(root)
  })
}

/** A live session marker: `<millis> [<pid> <start>]` then the details. */
const marker = (dir: string, session: string, aspect: string, details: string[]): void => {
  mkdirSync(dir, { recursive: true })
  const head = `${Date.now()} [${process.pid} ${Math.floor(Date.now() / 1000)}]`
  writeFileSync(join(dir, `${session}.${aspect}`), [head, ...details, ''].join('\n'))
}

describe('the head memory', () => {
  test('round-trips a head', () => {
    withRepo((root) => {
      assert.equal(readHeadMemory(root, 'o/r', 7), undefined)
      writeHeadMemory(root, 'o/r', 7, 'abc1234')
      assert.equal(readHeadMemory(root, 'o/r', 7), 'abc1234')
    })
  })

  test('a second PR keeps its own head', () => {
    withRepo((root) => {
      writeHeadMemory(root, 'o/r', 7, 'aaa')
      writeHeadMemory(root, 'o/r', 8, 'bbb')
      assert.equal(readHeadMemory(root, 'o/r', 7), 'aaa')
      assert.equal(readHeadMemory(root, 'o/r', 8), 'bbb')
    })
  })

  test('an unreadable memory is a miss, not a crash', () => {
    withRepo((root) => {
      writeHeadMemory(root, 'o/r', 7, 'abc1234')
      // corrupt it
      const path = join(root, '.git', 'bro', 'drive', 'heads', 'o%2Fr-7.json')
      writeFileSync(path, '{oops')
      assert.equal(readHeadMemory(root, 'o/r', 7), undefined)
    })
  })
})

describe('the armed sessions', () => {
  test('a live .act marker names the session that armed the PR', () => {
    withDir((hooks) => {
      marker(hooks, 'ses-a', 'act', ['#599'])
      assert.deepEqual(sessionArmedPrs(hooks, 599), ['ses-a'])
      assert.deepEqual(sessionArmedPrs(hooks, 600), [])
    })
  })

  test('the work aspect is not the act aspect', () => {
    withDir((hooks) => {
      marker(hooks, 'ses-a', 'work', ['codescene-debt'])
      assert.deepEqual(sessionArmedPrs(hooks, 599), [])
    })
  })

  test('two sessions on one PR both hear about it', () => {
    withDir((hooks) => {
      marker(hooks, 'ses-a', 'act', ['#599'])
      marker(hooks, 'ses-b', 'act', ['#599'])
      const sessions = sessionArmedPrs(hooks, 599).sort()
      assert.deepEqual(sessions, ['ses-a', 'ses-b'])
    })
  })
})

describe('the foreign-push event', () => {
  test('is addressed to the session and keyed per head', () => {
    const ev = foreignPushEvent({
      pr: 599,
      link: '[#599](https://github.com/o/r/pull/599)',
      from: 'aaaaaaaaaaaa',
      to: 'bbbbbbbbbbbb',
      session: 'ses-a',
    })
    assert.equal(ev.to, 'ses-a')
    assert.equal(ev.topic, 'drive')
    assert.equal(ev.kind, 'foreign-push')
    assert.equal(ev.key, 'foreign-push-599-bbbbbbbbbbbb')
    assert.equal(ev.source, 'drive')
    assert.match(String(ev.payload), /moved: head aaaaaaaa → bbbbbbbb/)
    // the bus reports; it does not tell the session what to do
    assert.doesNotMatch(String(ev.payload), /revert|reset the branch|git push/)
  })
})
