import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { cliChat, expandPromptFile } from './cli.ts'

type CliEntry = Extract<ProviderEntry, { type: 'cli' }>

const ENTRY: CliEntry = { type: 'cli', command: 'cat {promptFile}', model: 'devin-1' }
const DEADLINE = () => Date.now() + 10_000

describe('expandPromptFile', () => {
  test('{promptFile} expands to the quoted path', () => {
    assert.equal(expandPromptFile('devin -p --prompt-file {promptFile} -x', '/tmp/p.md'), "devin -p --prompt-file '/tmp/p.md' -x")
  })

  test('no placeholder appends the quoted path as the last arg', () => {
    assert.equal(expandPromptFile('my-agent run', '/tmp/p.md'), "my-agent run '/tmp/p.md'")
  })

  test('a quote in the path escapes shell-style', () => {
    assert.equal(expandPromptFile('cat {promptFile}', "/tmp/it's.md"), "cat '/tmp/it'\\''s.md'")
  })
})

describe('cliChat', () => {
  test('runs the template — {promptFile} carries the prompt, stdout is the content', async () => {
    const res = await cliChat('provider:local', ENTRY)('the prompt body', DEADLINE())
    assert.equal(res.content, 'the prompt body')
    assert.equal(res.model, 'devin-1')
  })

  test('a template without {promptFile} gets the path appended', async () => {
    const res = await cliChat('provider:local', { type: 'cli', command: 'cat' })('stdin-style', DEADLINE())
    assert.equal(res.content, 'stdin-style')
  })

  test('model reports the pin; opts.model wins; unpinned is honest unknown', async () => {
    assert.equal((await cliChat('provider:local', ENTRY, { model: 'other' })('p', DEADLINE())).model, 'other')
    const bare: CliEntry = { type: 'cli', command: 'cat {promptFile}' }
    assert.equal((await cliChat('provider:local', bare)('p', DEADLINE())).model, 'unknown')
  })

  test('a non-zero exit is JudgeUnavailable with the stderr tail', async () => {
    await assert.rejects(
      cliChat('provider:local', { type: 'cli', command: 'echo nope >&2; exit 3' })('p', DEADLINE()),
      (e: unknown) => {
        assert.ok(e instanceof JudgeUnavailable)
        assert.match(e.message, /exited 3/)
        assert.match(e.message, /nope/)
        return true
      }
    )
  })

  test('a missing command is a config error, not an outage', async () => {
    await assert.rejects(
      cliChat('provider:local', { type: 'cli', command: 'definitely-not-a-real-cmd {promptFile}' })('p', DEADLINE()),
      (e: unknown) => {
        assert.ok(e instanceof Error)
        assert.ok(!(e instanceof JudgeUnavailable))
        assert.match(e.message, /command not found/)
        return true
      }
    )
  })

  test('a spent budget fails open without spawning', async () => {
    await assert.rejects(
      cliChat('provider:local', ENTRY)('p', Date.now() - 1),
      (e: unknown) => {
        assert.ok(e instanceof JudgeUnavailable)
        assert.match(e.message, /budget spent/)
        return true
      }
    )
  })

  test('an overrun command is killed and fails open', async () => {
    await assert.rejects(
      cliChat('provider:local', { type: 'cli', command: 'cat {promptFile}; sleep 30' })('p', Date.now() + 100),
      (e: unknown) => {
        assert.ok(e instanceof JudgeUnavailable)
        assert.match(e.message, /timed out/)
        return true
      }
    )
  })
})
