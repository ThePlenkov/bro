/** GitHub stacks facade — `gh stack merge` dispatch and the `.stack`
 *  cascade probe against a scripted gh on PATH. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StackChainMember } from '@broject/core'
import { githubStacks } from './stacks.ts'

/** Scripted gh — `extension list` echoes $FAKE_GH_EXTENSIONS, `stack
 *  merge` exits $FAKE_GH_STACK_MERGE_CODE (default 0), the PR read and
 *  `repo view` answer the facade's other probes. argv lands in the log. */
const FAKE_GH = `#!/bin/sh
echo "$@" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "extension list") printf '%s\\n' "$FAKE_GH_EXTENSIONS" ;;
  "stack merge") if [ -n "$FAKE_GH_STACK_MERGE_ERR" ]; then echo "$FAKE_GH_STACK_MERGE_ERR" >&2; fi
      if [ -n "$FAKE_GH_STACK_MERGE_CODE" ]; then exit "$FAKE_GH_STACK_MERGE_CODE"; fi
      exit 0 ;;
  "repo view") echo '{"owner":{"login":"acme"},"name":"widgets"}' ;;
  "api repos/"*) if [ -n "$FAKE_GH_PULL_ERR" ]; then echo 'gh: API rate limit exceeded' >&2; exit 1; fi
      printf '%s\\n' "$FAKE_GH_PULL" ;;
esac
`

function withFakeGh(env: Record<string, string>, fn: (dir: string, log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gh-stacks-'))
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  const prevPath = process.env.PATH
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  process.env.PATH = `${dir}:${prevPath ?? ''}`
  Object.assign(process.env, { FAKE_GH_LOG: log }, env)
  try {
    fn(dir, log)
  } finally {
    process.env.PATH = prevPath
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = saved[k]
      }
    }
    delete process.env.FAKE_GH_LOG
    rmSync(dir, { recursive: true, force: true })
  }
}

const member = (branch: string, over: Partial<StackChainMember> = {}): StackChainMember => ({
  branch,
  base: 'main',
  pr: 42,
  ...over,
})

const CHAIN: StackChainMember[] = [
  member('stack/s/1-a', { pr: 41 }),
  member('stack/s/2-b', { pr: 42 }),
]

const EXT_INSTALLED = { FAKE_GH_EXTENSIONS: 'gh stack\tgithub/gh-stack\tv0.1.0' }

describe('github stacks mergeChain', () => {
  test('declines when the gh-stack extension is not installed', () => {
    withFakeGh({ FAKE_GH_EXTENSIONS: '' }, (dir) => {
      const r = githubStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
      assert.equal(r, undefined)
    })
  })

  test('declines an --admin merge — gh-stack cannot bypass requirements', () => {
    withFakeGh(EXT_INSTALLED, (dir) => {
      const r = githubStacks(dir).mergeChain?.(CHAIN, { method: 'squash', admin: true })
      assert.equal(r, undefined)
    })
  })

  test('runs `gh stack merge <top> --yes --method` and reports every layer landed', () => {
    withFakeGh(EXT_INSTALLED, (dir, log) => {
      const r = githubStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
      assert.deepEqual(r?.merged, ['stack/s/1-a', 'stack/s/2-b'])
      assert.ok(r?.lines.some((l) => l.includes('atomically')))
      const calls = readFileSync(log, 'utf8')
      assert.match(calls, /stack merge 42 --yes --squash/)
    })
  })

  test('declines on exit 2 (not in a stack) and 9 (stacks unavailable)', () => {
    for (const code of ['2', '9']) {
      withFakeGh({ ...EXT_INSTALLED, FAKE_GH_STACK_MERGE_CODE: code }, (dir) => {
        const r = githubStacks(dir).mergeChain?.(CHAIN, { method: 'squash' })
        assert.equal(r, undefined, `exit ${code} should decline`)
      })
    }
  })

  test('throws with stderr on a real merge failure', () => {
    withFakeGh(
      { ...EXT_INSTALLED, FAKE_GH_STACK_MERGE_CODE: '1', FAKE_GH_STACK_MERGE_ERR: 'merge conflict' },
      (dir) => {
        assert.throws(
          () => githubStacks(dir).mergeChain?.(CHAIN, { method: 'squash' }),
          /gh stack merge failed \(1\): merge conflict/
        )
      }
    )
  })

  test('declines a chain with no PRs at all', () => {
    withFakeGh(EXT_INSTALLED, (dir) => {
      const r = githubStacks(dir).mergeChain?.(
        [member('stack/s/1-a', { pr: undefined })],
        { method: 'squash' }
      )
      assert.equal(r, undefined)
    })
  })
})

describe('github stacks cascade', () => {
  const STACKED_PULL = { FAKE_GH_PULL: '{"stack":{"size":3},"base":{"ref":"main"}}' }

  test('a `.stack` PR means the platform owns retarget AND remote rebase', () => {
    withFakeGh(STACKED_PULL, (dir) => {
      const c = githubStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 42 })
      assert.deepEqual(c, { retarget: true, rebase: true })
    })
  })

  test('a plain PR means the manual cascade', () => {
    withFakeGh({ FAKE_GH_PULL: '{"base":{"ref":"main"}}' }, (dir) => {
      const c = githubStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 42 })
      assert.deepEqual(c, { retarget: false, rebase: false })
    })
  })

  test('a failed probe reads manual — the safe answer', () => {
    withFakeGh({ FAKE_GH_PULL: '', FAKE_GH_PULL_ERR: '1' }, (dir) => {
      const c = githubStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 42 })
      assert.deepEqual(c, { retarget: false, rebase: false })
    })
  })

  test('a PR-less member is always manual', () => {
    withFakeGh(STACKED_PULL, (dir) => {
      const c = githubStacks(dir).cascade?.({ branch: 'stack/s/2-b' })
      assert.deepEqual(c, { retarget: false, rebase: false })
    })
  })
})

describe('github stacks openHint', () => {
  test('is the gh create line against the member base', () => {
    withFakeGh({}, (dir) => {
      assert.equal(
        githubStacks(dir).openHint?.({ branch: 'stack/s/2-b', base: 'stack/s/1-a' }),
        'gh pr create --base stack/s/1-a'
      )
    })
  })
})
