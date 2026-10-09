import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
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
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Stop',
    ]
    for (const ev of events) {
      assert.ok(parsed.hooks[ev], `missing Codex hook event ${ev}`)
    }
    const session = JSON.stringify(parsed.hooks.SessionStart)
    assert.match(
      session,
      /startup\|resume\|clear\|compact/,
      'SessionStart should rehydrate every Codex source'
    )
    const preTool = JSON.stringify(parsed.hooks.PreToolUse)
    assert.match(preTool, /Bash/, 'PreToolUse should match Bash tool')
    assert.match(preTool, /pre-tool/, 'PreToolUse should call bro pre-tool')
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

  test('Codex skills are the repo skills tree, not a second copy', () => {
    const skills = join(ROOT, 'plugins/codex/bro/skills')
    const st = lstatSync(skills)
    assert.equal(st.isSymbolicLink(), true, 'plugins/codex/bro/skills must be a symlink')
    assert.equal(readlinkSync(skills), '../../../skills')
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'plugins/codex/bro/.codex-plugin/plugin.json'), 'utf8')
    ) as { skills?: string }
    assert.equal(manifest.skills, './skills/')
    for (const name of readdirSync(skills)) {
      const dir = join(skills, name)
      if (!statSync(dir).isDirectory()) continue
      if (!statSync(join(dir, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) continue
      const yaml = readFileSync(join(dir, 'agents/openai.yaml'), 'utf8')
      assert.match(yaml, /display_name:/, `${name} openai.yaml missing display_name`)
      assert.match(yaml, /short_description:/, `${name} openai.yaml missing short_description`)
      assert.match(
        yaml,
        /allow_implicit_invocation: true/,
        `${name} must load into the Codex prompt automatically`
      )
    }
  })
})
