import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CURSOR_SELF_TOOL_MATCHER,
  cursorStopIgnored,
  cursorToHookInput,
  cursorWorkspaceRoots,
  isCursorHookPayload,
  toCursorHookOutput,
} from './cursor-hook.ts'

const selfTool = new RegExp(CURSOR_SELF_TOOL_MATCHER)

describe('CURSOR_SELF_TOOL_MATCHER', () => {
  test('matches a single bro, bd, or pinned npx invocation', () => {
    assert.equal(selfTool.test('bro act status'), true)
    assert.equal(selfTool.test('  bd ready -n 5'), true)
    assert.equal(selfTool.test('npx -y @broject/bro@0.2.4 debt status'), true)
    assert.equal(selfTool.test('npx @broject/bro hooks stop'), true)
  })

  test('does not match lookalikes or other tools', () => {
    assert.equal(selfTool.test('brotli -d file'), false)
    assert.equal(selfTool.test('bdr foo'), false)
    assert.equal(selfTool.test('Bro act'), false)
    assert.equal(selfTool.test('gh pr merge 1'), false)
    assert.equal(selfTool.test('echo bro'), false)
    assert.equal(selfTool.test('npx -y @broject/brother'), false)
  })
})

describe('isCursorHookPayload', () => {
  test('cursor_version or hook event plus conversation id', () => {
    assert.equal(isCursorHookPayload({ cursor_version: '1.7.2' }), true)
    assert.equal(
      isCursorHookPayload({ hook_event_name: 'stop', conversation_id: 'c1' }),
      true
    )
    assert.equal(isCursorHookPayload({ session_id: 's1', prompt: 'hi' }), false)
    assert.equal(isCursorHookPayload({ hook_event_name: 'stop' }), false)
    assert.equal(isCursorHookPayload(null), false)
    assert.equal(isCursorHookPayload([]), false)
  })
})

describe('cursorToHookInput', () => {
  test('session id prefers session_id, then conversation_id', () => {
    assert.equal(
      cursorToHookInput({ session_id: 'sid', conversation_id: 'cid' }).session_id,
      'sid'
    )
    assert.equal(cursorToHookInput({ conversation_id: 'cid' }).session_id, 'cid')
  })

  test('postToolUse is a successful shell; failure is not', () => {
    const ok = cursorToHookInput({
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git push' },
    })
    assert.equal(ok.tool_input?.command, 'git push')
    assert.equal(ok.tool_response?.success, true)
    const fail = cursorToHookInput({
      hook_event_name: 'postToolUseFailure',
      tool_input: { command: 'git push' },
    })
    assert.equal(fail.tool_response?.success, false)
  })

  test('beforeShellExecution reads the top-level command', () => {
    const input = cursorToHookInput({
      hook_event_name: 'beforeShellExecution',
      command: 'bd ready',
      tool_input: { command: 'ignored' },
    })
    assert.equal(input.tool_input?.command, 'bd ready')
  })

  test('loop_count above zero is stop_hook_active', () => {
    assert.equal(
      cursorToHookInput({ hook_event_name: 'stop', loop_count: 0 }).stop_hook_active,
      undefined
    )
    assert.equal(
      cursorToHookInput({ hook_event_name: 'stop', loop_count: 1 }).stop_hook_active,
      true
    )
    assert.equal(
      cursorToHookInput({ hook_event_name: 'sessionStart', loop_count: 2 }).stop_hook_active,
      undefined
    )
  })

  test('prompt and workspace roots pass through', () => {
    assert.equal(
      cursorToHookInput({ hook_event_name: 'beforeSubmitPrompt', prompt: 'PR #3' }).prompt,
      'PR #3'
    )
    assert.deepEqual(
      cursorWorkspaceRoots({ workspace_roots: ['/repo', 1, ''] }),
      ['/repo']
    )
  })
})

describe('cursorStopIgnored', () => {
  test('only aborted or errored stops', () => {
    assert.equal(cursorStopIgnored({ hook_event_name: 'stop', status: 'aborted' }), true)
    assert.equal(cursorStopIgnored({ hook_event_name: 'stop', status: 'error' }), true)
    assert.equal(cursorStopIgnored({ hook_event_name: 'stop', status: 'completed' }), false)
    assert.equal(cursorStopIgnored({ hook_event_name: 'sessionStart', status: 'aborted' }), false)
  })
})

describe('toCursorHookOutput', () => {
  test('block is a follow-up and approve is allow', () => {
    assert.deepEqual(toCursorHookOutput({ decision: 'block', reason: 'dirty' }), {
      followup_message: 'dirty',
    })
    assert.deepEqual(toCursorHookOutput({ decision: 'approve' }), { permission: 'allow' })
    assert.deepEqual(toCursorHookOutput({ permission: 'ask' }), { permission: 'ask' })
  })

  test('prompt context continues and keeps the Claude additionalContext shape', () => {
    const out = toCursorHookOutput({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'gate' },
    })
    assert.deepEqual(out, {
      continue: true,
      additional_context: 'gate',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'gate' },
    })
  })

  test('other context is additional_context only', () => {
    assert.deepEqual(
      toCursorHookOutput({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'state' },
      }),
      { additional_context: 'state' }
    )
    assert.deepEqual(toCursorHookOutput({}), {})
    assert.deepEqual(toCursorHookOutput('nope'), {})
  })
})
