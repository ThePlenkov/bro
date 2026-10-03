import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectEmbedded } from './embedded.ts'

/** A fixture tree pinning collectEmbedded's contract — the artifact's
 *  check-embedded compares the artifact against the same collector, so
 *  only a test over a hand-built tree catches a shared bug. */
describe('collectEmbedded', () => {
  test('reads skill + formula trees; POSIX keys; symlinks never followed', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-embedded-'))
    try {
      mkdirSync(join(root, 'skills', 'act', 'deep'), { recursive: true })
      mkdirSync(join(root, 'formulas'), { recursive: true })
      writeFileSync(join(root, 'skills', 'act', 'SKILL.md'), '# act\n')
      writeFileSync(join(root, 'skills', 'act', 'deep', 'ref.md'), 'ref\n')
      writeFileSync(join(root, 'formulas', 'mol.toml'), '[mol]\n')
      // a symlinked dir would escape the tree — must be skipped, not followed
      symlinkSync(join(root, 'formulas'), join(root, 'skills', 'escape'), 'dir')

      const data = collectEmbedded(root)
      assert.equal(data.SKILL_FILES['act/SKILL.md'], '# act\n')
      assert.equal(data.SKILL_FILES['act/deep/ref.md'], 'ref\n')
      assert.equal(data.FORMULA_FILES['mol.toml'], '[mol]\n')
      assert.equal(Object.keys(data.SKILL_FILES).length, 2)
      assert.equal(Object.keys(data.FORMULA_FILES).length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('sorted keys — a serialized snapshot is byte-identical across runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'bro-embedded-'))
    try {
      mkdirSync(join(root, 'skills', 's'), { recursive: true })
      mkdirSync(join(root, 'formulas'), { recursive: true })
      // creation order differs from sort order — the walk must sort
      writeFileSync(join(root, 'skills', 's', 'z.md'), 'z')
      writeFileSync(join(root, 'skills', 's', 'a.md'), 'a')
      const keys = Object.keys(collectEmbedded(root).SKILL_FILES)
      assert.deepEqual(keys, ['s/a.md', 's/z.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
