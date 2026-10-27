/** `bro providers models` — the <provider>/<model> catalog surface. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { runProvidersCommand } from './providers.ts';
import { capture } from './testrepo.ts';

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
};

describe('bro providers models', () => {
  test('api renders the models allowlist as <name>/<id>', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models'], {
      providers: {
        orca: {
          type: 'api',
          baseUrl: 'http://x',
          apiKeyEnv: 'K',
          models: { 'a/m-1': 'systemone', 'a/m-2': 'openai-compat' },
        },
      },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['orca/a/m-1', 'orca/a/m-2']);
  });

  test('cli renders the models template + the pinned model deduped', async () => {
    const out: string[] = [];
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
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/swe-2-max', 'dv/swe-2-medium']);
  });

  test('cli with only a pinned model still prints it — never silently empty', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'dv'], {
      providers: { dv: { type: 'cli', command: 'dv run', model: 'pin-m' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/pin-m']);
  });

  test('acp enumerates session/new model configOptions over the protocol', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION] });
    const out: string[] = [];
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m2']);
  });

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
    };
    const fake = fakeAcpAgent({ configOptions: [uncategorized] });
    const out: string[] = [];
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m9']);
  });

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
    };
    const fake = fakeAcpAgent({ configOptions: [mode] });
    const out: string[] = [];
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: l => out.push(l),
    });
    assert.deepEqual(out, []);
  });

  test('a categorized model option wins over an uncategorized select', async () => {
    const uncategorized: SessionConfigOption = {
      id: 'other',
      name: 'Other',
      type: 'select',
      currentValue: 'x',
      options: [{ value: 'x', name: 'X' }],
    };
    const fake = fakeAcpAgent({ configOptions: [uncategorized, MODEL_OPTION] });
    const out: string[] = [];
    await runProvidersCommand(['models', 'dv-acp'], {
      providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      acp: { peer: fake.app },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv-acp/m1', 'dv-acp/m2']);
  });

  test('an unknown named provider dies naming what IS configured', async () => {
    const r = await capture(() =>
      runProvidersCommand(['models', 'nope'], {
        providers: { dv: { type: 'cli', command: 'dv run' } },
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /providers\.nope is not configured — configured: dv/);
  });

  test('a failing provider warns but never stops the others', async () => {
    const out: string[] = [];
    const r = await capture(() =>
      runProvidersCommand(['models'], {
        providers: {
          bad: { type: 'cli', command: 'x', models: 'boom' },
          dv: { type: 'cli', command: 'y', model: 'm' },
        },
        exec: () => {
          throw new Error('kaboom');
        },
        out: l => out.push(l),
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /bad — kaboom/);
    assert.deepEqual(out, ['dv/m']);
  });
});

describe('bro providers route', () => {
  const providers = {
    dv: { type: 'cli', command: 'dv run', model: 'swe-2-max', models: 'ignored — seam supplies' },
    zen: { type: 'cli', command: 'zen run --model {model}' },
    orca: {
      type: 'api',
      baseUrl: 'http://x',
      apiKeyEnv: 'K',
      models: { 'typesafe/jev-1.13': 'systemone' },
    },
  } as const;

  test('a declared shorthand route resolves to <provider>/<model>', async () => {
    const out: string[] = [];
    await runProvidersCommand(['route', 'swe-2-max'], {
      providers,
      brouter: { models: { 'swe-2-max': [{ provider: 'dv' }] } },
      exec: () => 'swe-2-max\nswe-2-medium\n',
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/swe-2-max']);
  });

  test('an alias resolves to the upstream model id, not the alias', async () => {
    const out: string[] = [];
    await runProvidersCommand(['route', 'jev'], {
      providers,
      brouter: { models: { jev: [{ provider: 'dv', model: 'dv/jev-1.13' }] } },
      exec: () => '',
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/dv/jev-1.13']);
  });

  test('a qualified id resolves verbatim — no declaration needed', async () => {
    const out: string[] = [];
    await runProvidersCommand(['route', 'orca/acme/chat'], {
      providers,
      brouter: { models: {} },
      exec: () => '',
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['orca/acme/chat']);
  });

  test('the live catalog serves undeclared bare ids', async () => {
    const out: string[] = [];
    await runProvidersCommand(['route', 'swe-2-medium'], {
      providers,
      brouter: { models: {} },
      exec: () => 'swe-2-max\nswe-2-medium\n',
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/swe-2-medium']);
  });

  test('--all lists every candidate in route order', async () => {
    const out: string[] = [];
    await runProvidersCommand(['route', '--all', 'cheap'], {
      providers,
      brouter: { models: { cheap: [{ provider: 'dv' }, { provider: 'zen' }] } },
      exec: () => '',
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['dv/cheap', 'zen/cheap']);
  });

  test('unresolved exits 1 naming the model', async () => {
    const r = await capture(() =>
      runProvidersCommand(['route', 'ghost'], {
        providers,
        brouter: { models: {} },
        exec: () => '',
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /no route for 'ghost'/);
  });

  test('a declared route to an unknown provider exits 1 naming the key', async () => {
    const r = await capture(() =>
      runProvidersCommand(['route', 'x'], {
        providers,
        brouter: { models: { x: [{ provider: 'nope' }] } },
        exec: () => '',
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /brouter\.models\.x.*providers\.nope/);
  });
});
