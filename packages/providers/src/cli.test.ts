import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeUnavailable } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { cliChat, expandPromptFile } from './cli.ts'
import { cliCommandModel, expandModelArg } from '@broject/core'

type CliEntry = Extract<ProviderEntry, { type: 'cli' }>

const ENTRY: CliEntry = { type: 'cli', command: 'cat {promptFile}', model: 'devin-1' }
const DEADLINE = () => Date.now() + 10_000

describe('expandPromptFile', () => {
  test('{promptFile} expands to the "$1" positional — the path never enters the line', () => {
    assert.equal(expandPromptFile('devin -p --prompt-file {promptFile} -x'), 'devin -p --prompt-file "$1" -x')
  })

  test('no placeholder appends "$1" as the last arg', () => {
    assert.equal(expandPromptFile('my-agent run'), 'my-agent run "$1"')
  })

  test('the expansion is a fixed token — no path characters reach the command line', () => {
    // whatever the mkdtemp path holds, the command line only ever sees "$1"
    assert.equal(expandPromptFile('cat {promptFile}'), 'cat "$1"')
  })
})

describe('cliCommandModel / expandModelArg', () => {
  const boom = (m: string) => new Error(`unhonorable:${m}`)
  const nopin = () => new Error('unpinned')

  test('{model} expands to the resolved, shell-quoted model', () => {
    assert.equal(expandModelArg('run --model {model} -x', 'a/b-c'), "run --model 'a/b-c' -x")
    assert.equal(expandModelArg('run {model}', "it's"), "run 'it'\\''s'")
  })

  test('$ tokens in the model id substitute literally, not as replaceAll patterns', () => {
    assert.equal(expandModelArg('run --model {model}', 'a$&-b'), "run --model 'a$&-b'")
  })

  test('override > pin through the placeholder; verbatim needs equality or silence', () => {
    assert.deepEqual(
      cliCommandModel('run --model {model}', 'm1', 'm2', boom, nopin),
      { command: "run --model 'm2'", model: 'm2' }
    )
    assert.deepEqual(
      cliCommandModel('run --model {model}', 'm1', undefined, boom, nopin),
      { command: "run --model 'm1'", model: 'm1' }
    )
    // verbatim command + matching or absent override → command untouched
    assert.deepEqual(cliCommandModel('run -p', 'm1', 'm1', boom, nopin), { command: 'run -p', model: 'm1' })
    assert.deepEqual(cliCommandModel('run -p', 'm1', undefined, boom, nopin), { command: 'run -p', model: 'm1' })
    // differing override a bare command can't consume → the caller's error
    assert.throws(() => cliCommandModel('run -p', 'm1', 'm2', boom, nopin), /unhonorable:m2/)
    // placeholder with no model to resolve → the caller's unpinned error
    assert.throws(() => cliCommandModel('run {model}', undefined, undefined, boom, nopin), /unpinned/)
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

  test('model reports the pin; an unhonorable override is a config error; unpinned is honest unknown', async () => {
    assert.equal((await cliChat('provider:local', ENTRY, { model: 'devin-1' })('p', DEADLINE())).model, 'devin-1')
    // 'other' can never reach a verbatim `cat` command — reporting it
    // would claim a model that didn't run
    assert.throws(
      () => cliChat('provider:local', ENTRY, { model: 'other' }),
      (e: unknown) => e instanceof Error && /cannot honor model 'other'/.test((e as Error).message)
    )
    const bare: CliEntry = { type: 'cli', command: 'cat {promptFile}' }
    assert.equal((await cliChat('provider:local', bare)('p', DEADLINE())).model, 'unknown')
  })

  test('{model} wires the resolved model into the command — override wins, echo proves it ran', async () => {
    const entry: CliEntry = { type: 'cli', command: 'echo -n {model}; cat {promptFile}', model: 'm1' }
    const res = await cliChat('provider:local', entry, { model: 'm2' })('P', DEADLINE())
    assert.equal(res.content, 'm2P')
    assert.equal(res.model, 'm2')
    // no model anywhere + a {model} placeholder → the entry is broken
    assert.throws(
      () => cliChat('provider:local', { type: 'cli', command: 'echo {model} {promptFile}' }),
      (e: unknown) => e instanceof Error && /no model is pinned/.test((e as Error).message)
    )
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
