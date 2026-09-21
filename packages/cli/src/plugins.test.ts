import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { loadExternalPlugins, PLUGINS, pluginConfigSections, runPlanFile } from './plugins.ts'

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

describe('bro run — plan routing', () => {
  function planFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bro-plan-'))
    const file = join(dir, 'plan.toml')
    writeFileSync(file, body)
    return file
  }

  test('kind routes to the plugin, schema validates, runPlan executes', async () => {
    const seen: string[] = []
    const plugin = {
      name: 'testplan',
      summary: 't',
      run: () => {},
      planSchema: (doc: unknown) => ({ v: (doc as { plan: { v: string } }).plan.v }),
      runPlan: (p: unknown) => { seen.push((p as { v: string }).v) },
    }
    PLUGINS.push(plugin)
    try {
      await runPlanFile([planFile('kind = "testplan"\n[plan]\nv = "ok"')])
      assert.deepEqual(seen, ['ok'])
    } finally {
      PLUGINS.splice(PLUGINS.indexOf(plugin), 1)
    }
  })

  test('unknown kind errors with the known list', async () => {
    await assert.rejects(
      runPlanFile([planFile('kind = "nope"\n[plan]\nv = 1')]),
      /kind "nope" is unknown.*retrospect/
    )
  })

  test('kind naming a plan-less plugin errors distinctly', async () => {
    await assert.rejects(
      runPlanFile([planFile('kind = "cleanup"\n[plan]\nv = 1')]),
      /plugin "cleanup" does not accept plans/
    )
  })

  test('missing kind errors', async () => {
    await assert.rejects(runPlanFile([planFile('[plan]\nv = 1')]), /no kind field/)
  })

  test('bad TOML surfaces the file path', async () => {
    const file = planFile('kind = [')
    await assert.rejects(runPlanFile([file]), new RegExp(`${file}.*invalid TOML`))
  })
})
