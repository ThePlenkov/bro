import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')

describe('devin plugin hooks', () => {
  test('hooks.json calls run.sh directly — no env-chain, no unbounded fallback', () => {
    for (const file of ['hooks.json', 'plugins/devin/bro/hooks.json']) {
      const body = readFileSync(join(ROOT, file), 'utf8')
      assert.match(
        body,
        /\$\{DEVIN_PLUGIN_ROOT\}\/hooks\/run\.sh/,
        `${file}: devin hooks call run.sh via DEVIN_PLUGIN_ROOT`
      )
      // the old preamble resolved P through a three-var chain, then fell
      // back to bare `bro hooks` with NO watchdog — the 10s timeout source.
      // resolution and the bounded fallback both live inside run.sh.
      assert.doesNotMatch(
        body,
        /CLAUDE_PLUGIN_ROOT|command -v bro/,
        `${file}: no env chain and no unbounded 'bro hooks' fallback`
      )
      assert.doesNotMatch(body, /npx/, `${file}: no npx`)
    }
  })
})
