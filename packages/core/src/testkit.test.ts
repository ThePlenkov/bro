import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubEnv, testGit, testGitEnv, testGitSpawn } from './testkit.ts'

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv())

describe('testGitEnv', () => {
  test('strips repo-location and config-injection vars, pins null config', () => {
    const env = testGitEnv({
      PATH: '/x',
      GIT_DIR: '/other/.git',
      GIT_WORK_TREE: '/other',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/pwned'",
      GIT_TEMPLATE_DIR: '/t',
      GIT_AUTHOR_DATE: '2026-01-01',
      GIT_COMMITTER_DATE: '2026-01-01',
    })
    assert.equal(env.PATH, '/x')
    assert.equal(env.GIT_DIR, undefined)
    assert.equal(env.GIT_WORK_TREE, undefined)
    assert.equal(env.GIT_CONFIG_COUNT, undefined)
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
    assert.equal(env.GIT_TEMPLATE_DIR, undefined)
    // fixtures pin commit dates through the AUTHOR/COMMITTER family —
    // not repo-location, not config-injection: survives the scrub
    assert.equal(env.GIT_AUTHOR_DATE, '2026-01-01')
    assert.equal(env.GIT_COMMITTER_DATE, '2026-01-01')
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(env.GIT_CONFIG_GLOBAL, devNull)
  })
})

describe('testGit/testGitSpawn', () => {
  test('a poisoned ambient env cannot inject config into a fixture git child', () => {
    // a pinned core.hooksPath riding GIT_CONFIG_* is the hook-injection
    // class the bead closes — the scrubbed child must answer 'unset'
    const env = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/pwned-hooks',
    }
    const r = testGitSpawn(['config', '--get', 'core.hooksPath'], { env })
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
  })

  test('a caller env whitelist stays a whitelist plus the null pins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-testkit-'))
    try {
      const env = { PATH: process.env.PATH!, GIT_DIR: '/other/.git' }
      testGit(['init', '-q', dir], { env })
      // GIT_DIR in the caller env was stripped: init landed at dir, not /other
      const r = testGitSpawn(['-C', dir, 'rev-parse', '--git-dir'], { env })
      assert.equal(r.status, 0)
      assert.match(r.stdout.trim(), /\.git$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scrubEnv', () => {
  test('deletes ambient pins, sets null-config pins, restores on close', () => {
    // the file-level after(scrubEnv()) may already hold the pins —
    // assert restore returns to whatever was there, not to a guess
    const beforeDir = process.env.GIT_DIR
    const beforeNosystem = process.env.GIT_CONFIG_NOSYSTEM
    const beforeGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_DIR = '/x'
    process.env.BRO_EDWTN_TEST = '1'
    const restore = scrubEnv(['EDWTN_EXTRA_LATE'])
    try {
      assert.equal(process.env.GIT_DIR, undefined)
      assert.equal(process.env.BRO_EDWTN_TEST, undefined)
      assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
      assert.equal(process.env.GIT_CONFIG_GLOBAL, devNull)
      // vars the code-under-test sets mid-window — extra-named or
      // pattern-matched — must not leak past the restore
      process.env.EDWTN_EXTRA_LATE = 'late'
      process.env.BRO_EDWTN_LATE = 'late'
    } finally {
      restore()
    }
    assert.equal(process.env.GIT_DIR, '/x')
    assert.equal(process.env.BRO_EDWTN_TEST, '1')
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, beforeNosystem)
    assert.equal(process.env.GIT_CONFIG_GLOBAL, beforeGlobal)
    assert.equal(process.env.EDWTN_EXTRA_LATE, undefined)
    assert.equal(process.env.BRO_EDWTN_LATE, undefined)
    if (beforeDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = beforeDir
    delete process.env.BRO_EDWTN_TEST
    delete process.env.EDWTN_EXTRA_LATE
    delete process.env.BRO_EDWTN_LATE
  })
})
