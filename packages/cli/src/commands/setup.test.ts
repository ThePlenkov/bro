import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_SCHEMA_URL } from '@broject/core'
import { readPackTree, resolvePackDir, writeConfig } from './setup.ts'
import { tmpDir } from './testrepo.ts'

const tmp = (p: string) => tmpDir(p)

// writeConfig resolves layers + writes under process.cwd() — each test
// chdirs into its fixture and restores, and the global layer is pinned
// at an empty XDG dir so the dev machine's config can't leak in
const prevXdg = process.env.XDG_CONFIG_HOME
process.env.XDG_CONFIG_HOME = tmp('bro-setup-xdg-')
process.on('exit', () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
})

function inDir(dir: string, fn: () => void): void {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    fn()
  } finally {
    process.chdir(prev)
  }
}

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

describe('writeConfig', () => {
  test('a created config carries the canonical $schema URL first', () => {
    const dir = tmp('bro-setup-')
    inDir(dir, () => {
      writeConfig({ beads: false })
      const written = readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      const parsed = JSON.parse(written) as Record<string, unknown>
      assert.equal(parsed.$schema, CONFIG_SCHEMA_URL)
      assert.equal(Object.keys(parsed)[0], '$schema')
    })
  })

  test('existing keys survive; a pinned $schema is never clobbered', () => {
    const dir = tmp('bro-setup-')
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({ $schema: 'https://example.com/custom.json', stores: ['jsonl'], personality: 'terse' })
    )
    inDir(dir, () => {
      writeConfig({ beads: false })
      const parsed = JSON.parse(
        readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(parsed.$schema, 'https://example.com/custom.json')
      assert.deepEqual(parsed.stores, ['jsonl'])
      assert.equal(parsed.personality, 'terse')
    })
  })

  test('an existing file without $schema gains it on the next setup run', () => {
    const dir = tmp('bro-setup-')
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify({ stores: ['jsonl'] }))
    inDir(dir, () => {
      writeConfig({ beads: false })
      const parsed = JSON.parse(
        readFileSync(join(dir, 'bro.config.local.json'), 'utf8')
      ) as Record<string, unknown>
      assert.equal(parsed.$schema, CONFIG_SCHEMA_URL)
      assert.deepEqual(parsed.stores, ['jsonl'])
    })
  })
})
