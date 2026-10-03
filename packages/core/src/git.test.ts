import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  gitDriftRef,
  gitIsAncestor,
  gitIsShallow,
  gitLogStamp,
} from './git.ts'

/** A test run inside another repo still carries its repo-location env —
 *  strip it so child git only sees the fixture's cwd (same scrub as the
 *  cli testrepo fixture). */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_INDEX_FILE: _i,
    GIT_COMMON_DIR: _c,
    ...env
  } = process.env
  return env
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { // NOSONAR — test fixture
    encoding: 'utf8',
    env: cleanEnv(),
  }).trim()
}

/** mkdtemp repo on `branch` with git identity and one commit. */
function makeRepo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-git-'))
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  git(dir, ['commit', '-qm', 'init', '--allow-empty'])
  return dir
}

function commit(dir: string, subject: string, files: Record<string, string>): string {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', subject])
  return git(dir, ['rev-parse', 'HEAD'])
}

function withRepo<T>(fn: (dir: string) => T, branch = 'main'): T {
  const dir = makeRepo(branch)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('gitDriftRef', () => {
  test('origin/HEAD wins when the remote default is set', () => {
    withRepo((dir) => {
      const remote = mkdtempSync(join(tmpdir(), 'bro-git-remote-'))
      try {
        git(remote, ['init', '-q', '--bare', '-b', 'main'])
        git(dir, ['remote', 'add', 'origin', remote])
        git(dir, ['push', '-q', 'origin', 'main'])
        git(dir, ['remote', 'set-head', 'origin', 'main'])
        assert.equal(gitDriftRef(dir), 'refs/remotes/origin/HEAD')
      } finally {
        rmSync(remote, { recursive: true, force: true })
      }
    })
  })

  test('no remote falls back to local main, then master, then HEAD', () => {
    withRepo((dir) => assert.equal(gitDriftRef(dir), 'refs/heads/main'))
    withRepo((dir) => assert.equal(gitDriftRef(dir), 'refs/heads/master'), 'master')
    withRepo((dir) => {
      git(dir, ['checkout', '-qb', 'develop'])
      git(dir, ['branch', '-qD', 'main'])
      assert.equal(gitDriftRef(dir), 'HEAD')
    })
  })

  test('a tag named main cannot stand in for the branch', () => {
    withRepo((dir) => {
      git(dir, ['checkout', '-qb', 'develop'])
      git(dir, ['branch', '-qD', 'main'])
      git(dir, ['tag', 'main'])
      assert.equal(gitDriftRef(dir), 'HEAD')
    })
  })

  test('remote-tracking main covers a checkout with no local default branch', () => {
    withRepo((dir) => {
      const remote = mkdtempSync(join(tmpdir(), 'bro-git-remote-'))
      try {
        git(remote, ['init', '-q', '--bare', '-b', 'main'])
        git(dir, ['remote', 'add', 'origin', remote])
        git(dir, ['push', '-q', 'origin', 'main'])
        git(dir, ['fetch', '-q', 'origin'])
        // a CI checkout shape: remote-tracking main exists but no
        // origin/HEAD symref (recent git auto-creates it on fetch —
        // symbolic-ref -d drops the symref; update-ref -d would
        // dereference and delete origin/main itself)
        git(dir, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'])
        git(dir, ['checkout', '-qb', 'develop'])
        git(dir, ['branch', '-qD', 'main'])
        assert.equal(gitDriftRef(dir), 'refs/remotes/origin/main')
      } finally {
        rmSync(remote, { recursive: true, force: true })
      }
    })
  })

  test('unborn history resolves nothing — null, not a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-'))
    try {
      git(dir, ['init', '-q', '-b', 'main'])
      assert.equal(gitDriftRef(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitLogStamp', () => {
  test('newest commit over the pathspecs, sha + ts + iso', () => {
    withRepo((dir) => {
      commit(dir, 'one', { 'src/a.ts': 'a\n' })
      const newer = commit(dir, 'two', { 'src/b.ts': 'b\n' })
      const r = gitLogStamp(dir, 'HEAD', ['src/'])
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`)
      }
      assert.equal(r.stamp.sha, newer)
      assert.ok(r.stamp.ts > 0)
      assert.ok(!Number.isNaN(Date.parse(r.stamp.iso)))
    })
  })

  test('exclude pathspecs subtract their commits from the result', () => {
    withRepo((dir) => {
      const kept = commit(dir, 'code', { 'src/a.ts': 'a\n' })
      commit(dir, 'spec', { 'specs/x.md': '# x\n' })
      const r = gitLogStamp(dir, 'HEAD', ['.', ':(exclude,literal)specs/x.md'])
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`)
      }
      assert.equal(r.stamp.sha, kept)
    })
  })

  test('a path with no commits is none — missing spec file stays honest', () => {
    withRepo((dir) => {
      assert.deepEqual(gitLogStamp(dir, 'HEAD', ['specs/never.md']), { state: 'none' })
    })
  })

  test('empty pathspecs are an error — never a whole-repo audit', () => {
    withRepo((dir) => {
      const r = gitLogStamp(dir, 'HEAD', [])
      assert.equal(r.state, 'error')
      assert.match(r.state === 'error' ? r.err : '', /empty pathspecs/)
    })
  })

  test('a dash-prefixed ref is an error, not a git log option', () => {
    withRepo((dir) => {
      commit(dir, 'one', { 'src/a.ts': 'a\n' })
      assert.equal(gitLogStamp(dir, '--all', ['src/']).state, 'error')
    })
  })

  test('a bad ref and unborn history are error, not throw', () => {
    withRepo((dir) => {
      const r = gitLogStamp(dir, 'nonexistent-ref', ['src/'])
      assert.equal(r.state, 'error')
    })
    const dir = mkdtempSync(join(tmpdir(), 'bro-git-'))
    try {
      git(dir, ['init', '-q', '-b', 'main'])
      assert.equal(gitLogStamp(dir, 'HEAD', ['.']).state, 'error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a renamed spec still yields its newest touch, not none', () => {
    withRepo((dir) => {
      commit(dir, 'spec', { 'specs/x.md': '# x\n' })
      mkdirSync(join(dir, 'specs', 'x'), { recursive: true })
      renameSync(join(dir, 'specs', 'x.md'), join(dir, 'specs', 'x', 'spec.md'))
      const renamed = commit(dir, 'move spec', {})
      // `log -1` always surfaces the newest touch, so --follow can't be
      // differentially observed here — the spec still mandates it. The
      // checkable contract: the renamed path's stamp is the rename
      // commit, and the pre-rename name reads that same commit as its
      // last touch (the delete half of the rename) — never a throw
      const r = gitLogStamp(dir, 'HEAD', ['specs/x/spec.md'], { follow: true })
      if (r.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(r)}`)
      }
      assert.equal(r.stamp.sha, renamed)
      const old = gitLogStamp(dir, 'HEAD', ['specs/x.md'])
      if (old.state !== 'commit') {
        assert.fail(`expected commit, got ${JSON.stringify(old)}`)
      }
      assert.equal(old.stamp.sha, renamed)
    })
  })
})

describe('gitIsAncestor', () => {
  test('true, false, and null for an unknown object', () => {
    withRepo((dir) => {
      const first = git(dir, ['rev-parse', 'HEAD'])
      const second = commit(dir, 'two', { 'a.ts': 'a\n' })
      assert.equal(gitIsAncestor(dir, first, second), true)
      assert.equal(gitIsAncestor(dir, second, first), false)
      assert.equal(gitIsAncestor(dir, first, 'deadbeef'.repeat(5)), null)
    })
  })
})

describe('gitIsShallow', () => {
  test('false on a full repo, true on a depth-1 clone', () => {
    withRepo((dir) => {
      assert.equal(gitIsShallow(dir), false)
      const clone = mkdtempSync(join(tmpdir(), 'bro-git-shallow-'))
      try {
        execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, join(clone, 'c')], {
          env: cleanEnv(),
        })
        assert.equal(gitIsShallow(join(clone, 'c')), true)
      } finally {
        rmSync(clone, { recursive: true, force: true })
      }
    })
  })
})
