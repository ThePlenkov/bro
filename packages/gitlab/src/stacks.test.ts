/** GitLab stacks facade — the retarget claim is gated on the host's
 *  version (auto-retarget arrived in 19.1), probed lazily through
 *  `glab api version`. A scripted glab on PATH answers the probe. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitlabStacks } from './stacks.ts'

/** Scripted glab — `api version` echoes $FAKE_GLAB_VERSION verbatim
 *  (unset/empty → invalid JSON, the probe's failure path). */
const FAKE_GLAB = `#!/bin/sh
if [ "$1 $2" = "api version" ]; then printf '%s\\n' "$FAKE_GLAB_VERSION"; exit 0; fi
exit 1
`

function withFakeGlab(version: string | undefined, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gl-stacks-'))
  writeFileSync(join(dir, 'glab'), FAKE_GLAB)
  chmodSync(join(dir, 'glab'), 0o755)
  const prevPath = process.env.PATH
  const prevVer = process.env.FAKE_GLAB_VERSION
  process.env.PATH = `${dir}:${prevPath ?? ''}`
  if (version === undefined) {
    delete process.env.FAKE_GLAB_VERSION
  } else {
    process.env.FAKE_GLAB_VERSION = version
  }
  try {
    fn(dir)
  } finally {
    process.env.PATH = prevPath
    if (prevVer === undefined) {
      delete process.env.FAKE_GLAB_VERSION
    } else {
      process.env.FAKE_GLAB_VERSION = prevVer
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('gitlab stacks', () => {
  test('openHint is the glab create line against the member base', () => {
    const s = gitlabStacks('/any')
    assert.equal(
      s.openHint?.({ branch: 'stack/s/2-b', base: 'stack/s/1-a' }),
      'glab mr create --target-branch stack/s/1-a'
    )
  })

  test('openHint quotes a base carrying shell metacharacters', () => {
    const s = gitlabStacks('/any')
    assert.equal(
      s.openHint?.({ branch: 'stack/s/2-b', base: 'x$(id);y' }),
      `glab mr create --target-branch 'x$(id);y'`
    )
  })

  test('GL 19.1+ — the platform owns retarget but never remote branches', () => {
    for (const version of ['19.1.0', '19.4.2-ee', '20.0.0']) {
      withFakeGlab(`{"version":"${version}","revision":"abc"}`, (dir) => {
        const c = gitlabStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 7 })
        assert.deepEqual(c, { retarget: true, rebase: false }, version)
      })
    }
  })

  test('GL <19.1 — no auto-retarget, the cascade stays manual', () => {
    for (const version of ['18.4.2-ee', '19.0.9']) {
      withFakeGlab(`{"version":"${version}"}`, (dir) => {
        const c = gitlabStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 7 })
        assert.deepEqual(c, { retarget: false, rebase: false }, version)
      })
    }
  })

  test('a failed version probe reads manual — the safe answer', () => {
    withFakeGlab(undefined, (dir) => {
      const c = gitlabStacks(dir).cascade?.({ branch: 'stack/s/2-b', pr: 7 })
      assert.deepEqual(c, { retarget: false, rebase: false })
    })
  })

  test('a PR-less member is always manual — it never probes', () => {
    // no fake glab at all: the member answers before the probe runs
    const c = gitlabStacks('/any').cascade?.({ branch: 'stack/s/2-b' })
    assert.deepEqual(c, { retarget: false, rebase: false })
  })

  test('no mergeChain — bottom-up PUT merge is the platform flow', () => {
    assert.equal(gitlabStacks('/any').mergeChain, undefined)
  })
})
