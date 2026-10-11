import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { diskFloorBreach, diskFloorBytes, MB } from './capacity.ts'

const cfg = { worktreeMb: 400, diskMinSlots: 2 }
const probe = (path: string, mb: number) => ({ path, freeBytes: mb * MB })

describe('diskFloorBytes', () => {
  test('the floor is N slots priced at worktreeMb', () => {
    assert.equal(diskFloorBytes(cfg), 800 * MB)
    assert.equal(diskFloorBytes({ worktreeMb: 350, diskMinSlots: 1 }), 350 * MB)
  })

  test('an absurd product saturates at MAX_SAFE_INTEGER — no garbage math', () => {
    assert.equal(
      diskFloorBytes({ worktreeMb: 1e20, diskMinSlots: 1e20 }),
      Number.MAX_SAFE_INTEGER
    )
    // and a saturated floor still breaches everything real
    assert.equal(
      diskFloorBreach([probe('/wt', 9_000_000)], {
        worktreeMb: 1e20,
        diskMinSlots: 1e20,
      })?.path,
      '/wt'
    )
  })
})

describe('diskFloorBreach', () => {
  test('a probe below the floor breaches — every filesystem must cover', () => {
    const b = diskFloorBreach(
      [probe('/worktrees', 900), probe('/tmp', 500)],
      cfg
    )
    assert.equal(b?.path, '/tmp')
  })

  test('every probe above the floor admits', () => {
    assert.equal(
      diskFloorBreach([probe('/worktrees', 800), probe('/tmp', 12_000)], cfg),
      undefined
    )
  })

  test('the boundary value admits — the floor is exclusive', () => {
    // free == floor still buys the slot; the margin is measured AFTER
    // the new worktree lands
    assert.equal(diskFloorBreach([probe('/wt', 800)], cfg), undefined)
    assert.equal(diskFloorBreach([probe('/wt', 799.9)], cfg)?.path, '/wt')
  })

  test('diskMinSlots 0 disables the watermark', () => {
    assert.equal(
      diskFloorBreach([probe('/wt', 1)], { ...cfg, diskMinSlots: 0 }),
      undefined
    )
  })

  test('worktreeMb 0 prices nothing — admits (config floors it at 1)', () => {
    assert.equal(
      diskFloorBreach([probe('/wt', 1)], { worktreeMb: 0, diskMinSlots: 2 }),
      undefined
    )
  })

  test('no probes admits — an unreadable watermark reports, never gates', () => {
    assert.equal(diskFloorBreach([], cfg), undefined)
  })
})
