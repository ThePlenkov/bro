/** GitLab stacks facade — platform-owned retarget, no mergeChain
 *  (per-layer PUT merge IS the platform flow). Pure contract, no glab. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { gitlabStacks } from './stacks.ts'

describe('gitlab stacks', () => {
  test('openHint is the glab create line against the member base', () => {
    const s = gitlabStacks('/any')
    assert.equal(
      s.openHint?.({ branch: 'stack/s/2-b', base: 'stack/s/1-a' }),
      'glab mr create --target-branch stack/s/1-a'
    )
  })

  test('the platform owns retarget but never rewrites remote branches', () => {
    const c = gitlabStacks('/any').cascade?.({ branch: 'stack/s/2-b', pr: 7 })
    assert.deepEqual(c, { retarget: true, rebase: false })
  })

  test('a PR-less member is always manual', () => {
    const c = gitlabStacks('/any').cascade?.({ branch: 'stack/s/2-b' })
    assert.deepEqual(c, { retarget: false, rebase: false })
  })

  test('no mergeChain — bottom-up PUT merge is the platform flow', () => {
    assert.equal(gitlabStacks('/any').mergeChain, undefined)
  })
})
