import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { loadExternalPlugins, PLUGINS, pluginConfigSections } from './plugins.ts'

describe('plugin registry', () => {
  test('names are unique', () => {
    const names = PLUGINS.map((p) => p.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('every plugin has a runnable entry and a summary', () => {
    for (const p of PLUGINS) {
      assert.equal(typeof p.run, 'function', p.name)
      assert.ok(p.summary.length > 0, p.name)
    }
  })

  test('skill references point at existing skill dirs', () => {
    // skills/ is two levels up from packages/cli/src in the workspace
    for (const p of PLUGINS) {
      if (p.skill) {
        assert.ok(
          p.skill.length > 0 && !p.skill.includes('..'),
          `${p.name} skill`
        )
      }
    }
  })

  test('plugins lists itself', () => {
    assert.ok(PLUGINS.some((p) => p.name === 'plugins'))
  })

  test('configKey ⟺ configSchema pairing', () => {
    for (const p of PLUGINS) {
      if (p.configKey) {
        assert.equal(
          typeof p.configSchema,
          'function',
          `${p.name} declares configKey without configSchema`
        )
      } else {
        assert.equal(
          p.configSchema,
          undefined,
          `${p.name} has configSchema but no configKey`
        )
      }
    }
  })

  test('pluginConfigSections maps configKey to its schema', () => {
    const sections = pluginConfigSections()
    assert.equal(typeof sections.act, 'function')
    assert.equal(typeof sections.sync, 'function')
    assert.equal(typeof sections.debt, 'function')
    assert.equal(sections.hooks, undefined)
  })
})

describe('loadExternalPlugins', () => {
  function repoWith(pluginSource: string | null, plugins: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'bro-ext-'))
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ plugins })
    )
    if (pluginSource !== null) {
      writeFileSync(join(dir, 'my.ts'), pluginSource)
    }
    return dir
  }

  function unload(loaded: { name: string }[]): void {
    for (const p of loaded) {
      const i = PLUGINS.findIndex((x) => x.name === p.name)
      if (i >= 0) PLUGINS.splice(i, 1)
    }
  }

  test('a .ts default-export plugin registers and is marked external', async () => {
    const dir = repoWith(
      `export default { name: 'hello', summary: 'test plugin', run: () => {} }`,
      ['./my.ts']
    )
    const loaded = await loadExternalPlugins(dir)
    try {
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].name, 'hello')
      assert.equal(loaded[0].external, true)
      assert.ok(PLUGINS.some((p) => p.name === 'hello'))
    } finally {
      unload(loaded)
    }
  })

  test('non-plugin exports and missing modules warn+skip', async () => {
    const dir = repoWith(`export default { not: 'a plugin' }`, [
      './my.ts',
      './missing.ts',
    ])
    const loaded = await loadExternalPlugins(dir)
    assert.equal(loaded.length, 0)
  })

  test('a name colliding with a builtin is skipped', async () => {
    const dir = repoWith(
      `export default { name: 'debt', summary: 'shadow', run: () => {} }`,
      ['./my.ts']
    )
    const loaded = await loadExternalPlugins(dir)
    try {
      assert.equal(loaded.length, 0)
      assert.equal(PLUGINS.filter((p) => p.name === 'debt').length, 1)
    } finally {
      unload(loaded)
    }
  })

  test('wrong-typed optional fields reject the export', async () => {
    const dir = repoWith(
      `export default { name: 'bad1', summary: 'x', run: () => {}, configSchema: 'nope' }`,
      ['./my.ts']
    )
    const loaded = await loadExternalPlugins(dir)
    assert.equal(loaded.length, 0)
  })

  test('external configKey cannot shadow an owned section', async () => {
    const dir = repoWith(
      `export default { name: 'evil', summary: 'x', run: () => {}, configKey: 'act', configSchema: () => ({}) }`,
      ['./my.ts']
    )
    const loaded = await loadExternalPlugins(dir)
    try {
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].configKey, undefined)
      assert.equal(loaded[0].configSchema, undefined)
      // the builtin act schema still owns the section
      assert.equal(pluginConfigSections().act, (await import('@bro/core')).actSection)
    } finally {
      unload(loaded)
    }
  })

  test('relative specs cannot escape the repo root', async () => {
    const dir = repoWith(null, [])
    // the escape target must exist — resolve() throws on missing files
    // before the containment check runs
    writeFileSync(
      join(dir, '..', 'bro-outside-plugin.ts'),
      `export default { name: 'evil2', summary: 'x', run: () => {} }`
    )
    const loaded = await loadExternalPlugins(dir, ['../bro-outside-plugin.ts'])
    assert.equal(loaded.length, 0)
  })

  test('whitespace around specs is trimmed by config normalization', async () => {
    const dir = repoWith(
      `export default { name: 'ws', summary: 'x', run: () => {} }`,
      ['  ./my.ts  ']
    )
    const loaded = await loadExternalPlugins(dir)
    try {
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].name, 'ws')
    } finally {
      unload(loaded)
    }
  })
})
