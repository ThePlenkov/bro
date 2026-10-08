import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const HOOKS = join(ROOT, 'plugins/codex/bro/hooks/hooks.json')

describe('codex plugin adapter', () => {
  test('hooks/hooks.json wires Codex lifecycle events to bro hooks', () => {
    const parsed = JSON.parse(readFileSync(HOOKS, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    const events = [
      'SessionStart',
      'PreCompact',
      'PostCompact',
      'UserPromptSubmit',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
    ]
    for (const ev of events) {
      assert.ok(parsed.hooks[ev], `missing Codex hook event ${ev}`)
    }
    const postTool = JSON.stringify(parsed.hooks.PostToolUse)
    assert.match(postTool, /Bash/, 'PostToolUse should match Bash tool')
    assert.match(postTool, /post-tool/, 'PostToolUse should call bro post-tool')
    const perm = JSON.stringify(parsed.hooks.PermissionRequest)
    assert.match(perm, /permission/, 'PermissionRequest should call bro permission')
    const body = readFileSync(HOOKS, 'utf8')
    assert.match(body, /\$\{PLUGIN_ROOT\}\/hooks\/run\.sh/, 'Codex hooks call run.sh via PLUGIN_ROOT')
    assert.doesNotMatch(body, /DEVIN_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|npx/, 'resolution stays in run.sh')
    assert.doesNotMatch(body, /\$comment/, 'Codex rejects $comment in hooks.json')
    assert.match(body, /"description"/, 'Codex hooks.json should use description')
  })
})
