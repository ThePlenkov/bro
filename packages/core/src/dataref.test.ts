import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_REF,
  dataRefCommit,
  dataRefPull,
  dataRefPush,
  dataRefRoot,
} from './dataref.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim() // NOSONAR — test fixture
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-dataref-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  mkdirSync(join(dir, '.agents/review-debt'), { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '.agents/\n')
  writeFileSync(join(dir, '.agents/review-debt/ledger.jsonl'), '{"a":1}\n')
  git(dir, ['add', '.gitignore'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

function makeBare(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-dataref-remote-'))
  git(dir, ['init', '--bare', '-b', 'main'])
  return dir
}

function refPaths(root: string): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', DATA_REF]).split('\n')
}

describe('dataRefCommit', () => {
  test('commits ignored artifacts to the data ref, tracked files excluded', () => {
    const root = makeRepo()
    const sha = dataRefCommit(root, '.agents', 'test sync')
    assert.ok(sha)
    assert.deepEqual(refPaths(root), ['.agents/review-debt/ledger.jsonl'])
    // the ref lives outside refs/heads — it must not show up as a branch
    assert.equal(git(root, ['branch', '--list', 'bro/*']), '')
    // worktree status stays clean — plumbing never touches the index
    assert.equal(git(root, ['status', '--porcelain']), '')
  })

  test('unchanged tree is a no-op returning the existing head', () => {
    const root = makeRepo()
    const first = dataRefCommit(root, '.agents', 'one')
    const second = dataRefCommit(root, '.agents', 'two')
    assert.equal(second, first)
    assert.equal(git(root, ['rev-list', '--count', DATA_REF]), '1')
  })

  test('content change produces a child commit; deleted files drop out', () => {
    const root = makeRepo()
    const first = dataRefCommit(root, '.agents', 'one')
    writeFileSync(join(root, '.agents/review-debt/ledger.jsonl'), '{"a":1}\n{"b":2}\n')
    const second = dataRefCommit(root, '.agents', 'two')
    assert.notEqual(second, first)
    assert.equal(git(root, ['rev-parse', `${DATA_REF}^`]), first)
  })

  test('untracked non-ignored files never sync', () => {
    const root = makeRepo()
    writeFileSync(join(root, '.agents', 'stray.txt'), 'untracked but not ignored\n')
    // .agents/ is gitignored → stray IS ignored; use an unignored path instead
    writeFileSync(join(root, 'notes.txt'), 'plain untracked\n')
    dataRefCommit(root, '.', 'all')
    const paths = refPaths(root)
    assert.ok(paths.includes('.agents/review-debt/ledger.jsonl'))
    assert.ok(!paths.includes('notes.txt'))
    assert.ok(!paths.includes('.gitignore'))
  })
})

describe('dataRefPush / dataRefPull', () => {
  test('push publishes the ref; pull materializes files on a fresh clone', () => {
    const root = makeRepo()
    const remote = makeBare()
    git(root, ['remote', 'add', 'origin', remote])
    dataRefCommit(root, '.agents', 'sync')
    assert.equal(dataRefPush(root), true)
    git(remote, ['rev-parse', '--verify', DATA_REF])

    const clone = mkdtempSync(join(tmpdir(), 'bro-dataref-clone-'))
    git(clone, ['init', '-b', 'main'])
    git(clone, ['config', 'user.email', 't@t'])
    git(clone, ['config', 'user.name', 't'])
    git(clone, ['remote', 'add', 'origin', remote])
    assert.equal(dataRefPull(clone), 1)
    assert.equal(
      readFileSync(join(clone, '.agents/review-debt/ledger.jsonl'), 'utf8'),
      '{"a":1}\n'
    )
  })

  test('pull with no remote ref reports -1', () => {
    const root = makeRepo()
    const remote = makeBare()
    git(root, ['remote', 'add', 'origin', remote])
    assert.equal(dataRefPull(root), -1)
  })

  test('diverged replicas merge .jsonl by line union', () => {
    const remote = makeBare()
    const r1 = makeRepo()
    git(r1, ['remote', 'add', 'origin', remote])
    dataRefCommit(r1, '.agents', 'r1')
    assert.equal(dataRefPush(r1), true)

    // replica 2: pull, append b, push
    const r2 = mkdtempSync(join(tmpdir(), 'bro-dataref-r2-'))
    git(r2, ['init', '-b', 'main'])
    git(r2, ['config', 'user.email', 't@t'])
    git(r2, ['config', 'user.name', 't'])
    git(r2, ['remote', 'add', 'origin', remote])
    dataRefPull(r2)
    writeFileSync(
      join(r2, '.agents/review-debt/ledger.jsonl'),
      '{"a":1}\n{"b":2}\n'
    )
    dataRefCommit(r2, '.agents', 'r2')
    assert.equal(dataRefPush(r2), true)

    // replica 1 appends c on its stale head → push rejects → merge → retry
    writeFileSync(
      join(r1, '.agents/review-debt/ledger.jsonl'),
      '{"a":1}\n{"c":3}\n'
    )
    dataRefCommit(r1, '.agents', 'r1c')
    assert.equal(dataRefPush(r1), true)

    const merged = git(remote, ['show', `${DATA_REF}:.agents/review-debt/ledger.jsonl`])
    assert.deepEqual(
      merged.split('\n').filter(Boolean).sort(),
      ['{"a":1}', '{"b":2}', '{"c":3}']
    )
  })
})

describe('dataRefRoot', () => {
  test('null outside a worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-dataref-nowt-'))
    assert.equal(dataRefRoot(dir), null)
  })

  test('root inside a worktree', () => {
    const root = makeRepo()
    assert.equal(dataRefRoot(root), root)
  })
})
