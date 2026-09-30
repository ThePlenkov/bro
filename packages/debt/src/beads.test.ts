import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBeads } from './beads.ts'

const WIN32 = process.platform === 'win32'

/** Scripted bd — `init` materializes .beads like `bd init --stealth`;
 *  reads fail with no-store until it exists. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd version 1.3.0 (fake)' ;;
  init) mkdir -p .beads ;;
  list|ready)
    [ -d .beads ] || { echo 'Error: no beads database found' >&2; exit 1; }
    echo '[]' ;;
  info) echo '{"schema_version":1}' ;;
  *) exit 1 ;;
esac
`

/** Fake bd on PATH, cwd = a repo dir, console.error captured into stderr. */
function withRepo(fn: (dir: string, stderr: string[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'bro-debt-beads-'))
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  mkdirSync(bin)
  mkdirSync(repo)
  writeFileSync(join(bin, 'bd'), FAKE_BD)
  chmodSync(join(bin, 'bd'), 0o755)
  const prevPath = process.env.PATH
  const prevCwd = process.cwd()
  const origError = console.error
  const stderr: string[] = []
  process.env.PATH = `${bin}:${prevPath}`
  process.chdir(repo)
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  }
  try {
    fn(repo, stderr)
  } finally {
    console.error = origError
    process.chdir(prevCwd)
    process.env.PATH = prevPath
    rmSync(root, { recursive: true, force: true })
  }
}

const announced = (stderr: string[]): boolean =>
  stderr.some((l) => /initialized \.beads/.test(l))

describe('checkBeads auto-init', { skip: WIN32 }, () => {
  test('announces the stealth init on first run', () => {
    withRepo((dir, stderr) => {
      checkBeads()
      assert.ok(existsSync(join(dir, '.beads')))
      assert.ok(announced(stderr))
    })
  })

  test('silent when .beads already exists', () => {
    withRepo((dir, stderr) => {
      mkdirSync(join(dir, '.beads'))
      checkBeads()
      assert.equal(announced(stderr), false)
    })
  })

  test('autoInit:false neither inits nor announces', () => {
    withRepo((dir, stderr) => {
      assert.throws(() => checkBeads({ autoInit: false }), /bd list failed.*bd init/s)
      assert.equal(existsSync(join(dir, '.beads')), false)
      assert.equal(announced(stderr), false)
    })
  })
})
