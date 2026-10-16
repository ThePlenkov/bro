/** `bro providers models` — the <provider>/<model> catalog surface. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { fakeAcpAgent } from '@broject/providers/testkit'
import { runProvidersCommand } from './providers.ts'
import { capture } from './testrepo.ts'

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'm1',
  options: [
    { value: 'm1', name: 'Model One' },
    { value: 'm2', name: 'Model Two' },
  ],
}

describe('bro providers models', () => {
  test('api renders the models allowlist as <name>/<id>', async () => {
    const out: string[] = []
    await runProvidersCommand(['models'], {
      providers: {
        orca: {
          type: 'api',
          baseUrl: 'http://x',
          apiKeyEnv: 'K',
          models: { 'a/m-1': 'systemone', 'a/m-2': 'openai-compat' },
        },
      },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['orca/a/m-1', 'orca/a/m-2'])
  })

  test('cli renders the models template + the pinned model deduped', async () => {
    const out: string[] = []
    await runProvidersCommand(['models', 'dv'], {
      providers: {
        dv: {
          type: 'cli',
          command: 'dv run',
          model: 'swe-2-max',
          models: 'ignored — seam supplies output',
        },
      },
      exec: () => 'swe-2-max\nswe-2-medium\n\n',
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['dv/swe-2-max', 'dv/swe-2-medium'])
  })

  test('cli with only a pinned model still prints it — never silently empty', async () => {
    const out: string[] = []
    await runProvidersCommand(['models', 'dv'], {
      providers: { dv: { type: 'cli', command: 'dv run', model: 'pin-m' } },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['dv/pin-m'])
  })

  test('acp enumerates session/new model configOptions over the protocol', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION] })
    const out: string[] = []
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m2'])
  })

  test('acp falls back to an uncategorized select — category is never required', async () => {
    const uncategorized: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'm1',
      options: [
        { value: 'm1', name: 'Model One' },
        { value: 'm9', name: 'Model Nine' },
      ],
    }
    const fake = fakeAcpAgent({ configOptions: [uncategorized] })
    const out: string[] = []
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m9'])
  })

  test('a select categorized mode is never the model picker', async () => {
    const mode: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'plan',
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'build', name: 'Build' },
      ],
    }
    const fake = fakeAcpAgent({ configOptions: [mode] })
    const out: string[] = []
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, [])
  })

  test('a categorized model option wins over an uncategorized select', async () => {
    const uncategorized: SessionConfigOption = {
      id: 'other',
      name: 'Other',
      type: 'select',
      currentValue: 'x',
      options: [{ value: 'x', name: 'X' }],
    }
    const fake = fakeAcpAgent({ configOptions: [uncategorized, MODEL_OPTION] })
    const out: string[] = []
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: (l) => out.push(l),
    })
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m2'])
  })

  test('an unknown named provider dies naming what IS configured', async () => {
    const r = await capture(() =>
      runProvidersCommand(['models', 'nope'], {
        providers: { dv: { type: 'cli', command: 'dv run' } },
      })
    )
    assert.equal(r.code, 1)
    assert.match(r.err.join('\n'), /providers\.nope is not configured — configured: dv/)
  })

  test('a failing provider warns but never stops the others', async () => {
    const out: string[] = []
    const r = await capture(() =>
      runProvidersCommand(['models'], {
        providers: {
          bad: { type: 'cli', command: 'x', models: 'boom' },
          dv: { type: 'cli', command: 'y', model: 'm' },
        },
        exec: () => {
          throw new Error('kaboom')
        },
        out: (l) => out.push(l),
      })
    )
    assert.equal(r.code, 1)
    assert.match(r.err.join('\n'), /bad — kaboom/)
    assert.deepEqual(out, ['dv/m'])
  })
})
