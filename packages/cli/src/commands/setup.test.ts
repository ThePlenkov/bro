import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackTree, resolvePackDir } from './setup.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

/** A fake pack under <root>/node_modules/<spec>: package.json + trees. */
function fakePack(root: string, spec: string, withSkills = true): string {
  const dir = join(root, 'node_modules', spec)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: spec }))
  if (withSkills) {
    mkdirSync(join(dir, 'skills/demo'), { recursive: true })
    writeFileSync(join(dir, 'skills/demo/SKILL.md'), '# demo')
  }
  mkdirSync(join(dir, 'formulas'), { recursive: true })
  writeFileSync(join(dir, 'formulas/f.toml'), 'formula = "f"')
  return dir
}

describe('resolvePackDir', () => {
  test('a project-local pack wins — resolved from cwd node_modules', () => {
    const cwd = tmp('bro-pack-cwd-')
    const dir = fakePack(cwd, '@scope/my-pack')
    assert.equal(resolvePackDir('@scope/my-pack', cwd), dir)
  })

  test('unresolvable spec returns null, not a throw', () => {
    assert.equal(resolvePackDir('@broject/no-such-pack', tmp('bro-pack-x-')), null)
  })

  test('falls back to the CLI tree — the workspace default pack resolves', () => {
    // the workspace pack is always present where these tests run — a
    // null here is a real regression in fallback resolution, not a skip
    const dir = resolvePackDir('@broject/bro-pack', tmp('bro-pack-self-'))
    assert.ok(dir?.endsWith(join('packages', 'pack')), `resolved ${dir}`)
  })
})

describe('readPackTree', () => {
  test('reads nested files into a flat relpath map', () => {
    const root = tmp('bro-pack-tree-')
    mkdirSync(join(root, 'a/b'), { recursive: true })
    writeFileSync(join(root, 'a/b/x.md'), 'x')
    writeFileSync(join(root, 'y.md'), 'y')
    assert.deepEqual(readPackTree(root), { 'a/b/x.md': 'x', 'y.md': 'y' })
  })
})
