import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')

describe('claude plugin', () => {
  test('the repo root is the plugin and hooks call run.sh', () => {
    const market = JSON.parse(
      readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8')
    ) as { plugins?: { name?: string; source?: string }[] }
    assert.equal(market.plugins?.find((p) => p.name === 'bro')?.source, './')
    const manifest = JSON.parse(
      readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')
    ) as { name?: string; hooks?: string }
    assert.equal(manifest.name, 'bro')
    assert.equal(manifest.hooks, './plugins/claude/bro/hooks/hooks.json')
    const hooks = readFileSync(join(ROOT, 'plugins/claude/bro/hooks/hooks.json'), 'utf8')
    assert.match(hooks, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.sh/)
    assert.doesNotMatch(hooks, /npx|DEVIN_PLUGIN_ROOT/)
    assert.equal(existsSync(join(ROOT, 'hooks/hooks.json')), false)
    const skills = lstatSync(join(ROOT, 'skills'))
    assert.equal(skills.isSymbolicLink(), false)
    assert.equal(skills.isDirectory(), true)
  })
})
