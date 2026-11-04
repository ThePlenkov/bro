import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionConfigOption } from '@broject/core';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { runProvidersCommand } from './providers.ts';
import { capture } from './testrepo.ts';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir, initRepo, insideAsync } from './testrepo.ts';

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  options: [
    { value: 'qwen/qwen3-coder', name: 'qwen3-coder' },
    { value: 'google/gemini-2.5-pro', name: 'gemini-2.5-pro' },
  ],
};

describe('bro providers models', () => {
  test('lists models for a named acp provider', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'acp1'], {
      acp: fakeAcpAgent({ sessionConfigOptions: [MODEL_OPTION] }),
      providers: { acp1: { type: 'acp', command: 'x' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['acp1/qwen/qwen3-coder', 'acp1/google/gemini-2.5-pro']);
  });

  test('includes the pinned model when not in the option list', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'acp1'], {
      acp: fakeAcpAgent({ sessionConfigOptions: [] }),
      providers: { acp1: { type: 'acp', command: 'x', model: 'some/model' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['acp1/some/model']);
  });

  test('lists models for cli provider via template', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'cli1'], {
      exec: async () => '  a\nb\n\n',
      providers: { cli1: { type: 'cli', command: 'x', models: 'echo a; echo b' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['cli1/a', 'cli1/b']);
  });

  test('cli provider includes pinned model when not listed', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'cli1'], {
      exec: async () => 'a\n',
      providers: { cli1: { type: 'cli', command: 'x', models: 'echo a', model: 'pinned' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['cli1/a', 'cli1/pinned']);
  });

  test('cli provider with only pinned model and no template', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'cli1'], {
      providers: { cli1: { type: 'cli', command: 'x', model: 'pinned' } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['cli1/pinned']);
  });

  test('api provider uses the models allowlist', async () => {
    const out: string[] = [];
    await runProvidersCommand(['models', 'api1'], {
      providers: { api1: { type: 'api', baseUrl: 'http://x', apiKeyEnv: 'K', models: { 'm/a': {}, 'm/b': {} } } },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['api1/m/a', 'api1/m/b']);
  });

  test('lists all configured providers when no names given', async () => {
    const out: string[] = [];
    await runProvidersCommand([], {
      providers: {
        a: { type: 'api', baseUrl: 'http://x', apiKeyEnv: 'K', models: { m: {} } },
        b: { type: 'cli', command: 'x', model: 'p' },
      },
      out: l => out.push(l),
    });
    assert.deepEqual(out, ['a/m', 'b/p']);
  });

  test('unknown provider name exits 1', async () => {
    const r = await capture(() => runProvidersCommand(['models', 'nope'], { providers: {} }));
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /providers\.nope/);
  });

  test('a failing provider warns and exits 1', async () => {
    const err: string[] = [];
    const out: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => err.push(a.map(String).join(' '));
    try {
      await runProvidersCommand(['models', 'bad'], {
        acp: fakeAcpAgent({ throwOnInitialize: new Error('boom') }),
        providers: { bad: { type: 'acp', command: 'x' } },
        out: l => out.push(l),
      });
    } catch (e: any) {
      assert.equal(e.code, 1);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(out, []);
    assert.match(err.join('\n'), /bad/);
    assert.match(err.join('\n'), /boom/);
  });

  test('-h prints usage and exits 0', async () => {
    const r = await capture(() => runProvidersCommand(['-h'], { providers: {} }));
    assert.equal(r.code, 0);
    assert.match(r.out.join('\n'), /bro providers/);
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

  const routeLines = async (
    args: string[],
    o: Parameters<typeof runProvidersCommand>[1]
  ): Promise<string[]> => {
    const out: string[] = [];
    await runProvidersCommand(args, {
      providers,
      brouter: { models: {} },
      ...o,
      out: l => out.push(l),
    });
    return out;
  };

  test('a static hit never pays the live probe', async () => {
    let probes = 0;
    const out = await routeLines(['route', 'swe-2-max'], {
      brouter: { models: { 'swe-2-max': [{ provider: 'dv' }] } },
      exec: () => {
        probes += 1;
        return 'swe-2-max\n';
      },
    });
    assert.deepEqual(out, ['dv/swe-2-max']);
    assert.equal(probes, 0);
  });

  test('a failed probe still routes the pinned model', async () => {
    const out = await routeLines(['route', 'swe-2-max'], {
      providers: { dv: { type: 'cli', command: 'dv run', model: 'swe-2-max', models: 'boom' } },
      exec: () => {
        throw new Error('kaboom');
      },
    });
    assert.deepEqual(out, ['dv/swe-2-max']);
  });

  test('an empty qualified suffix is not a route', async () => {
    const r = await capture(() =>
      runProvidersCommand(['route', 'zen/'], {
        providers,
        brouter: { models: {} },
        exec: () => '',
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /no route for 'zen\/'/);
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

describe('bro providers add', () => {
  test('add writes a preset entry to project config by default', async () => {
    const dir = tmpDir('bro-prov-add-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      await runProvidersCommand(['add', 'kilo']);
      const cfg = JSON.parse(readFileSync(join(process.cwd(), 'bro.config.json'), 'utf8'));
      assert.deepEqual(cfg.providers.kilo, { type: 'acp', command: 'kilo --acp' });
    });
  });

  test('add with --name overrides provider name', async () => {
    const dir = tmpDir('bro-prov-add2-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      await runProvidersCommand(['add', 'kilo', '--name', 'kilo-cli']);
      const cfg = JSON.parse(readFileSync(join(process.cwd(), 'bro.config.json'), 'utf8'));
      assert.deepEqual(cfg.providers['kilo-cli'], { type: 'acp', command: 'kilo --acp' });
      assert.equal(cfg.providers.kilo, undefined);
    });
  });

  test('add refuses to clobber without --force', async () => {
    const dir = tmpDir('bro-prov-add3-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      await runProvidersCommand(['add', 'kilo']);
      const r = await capture(() => runProvidersCommand(['add', 'kilo']));
      assert.equal(r.code, 1);
      assert.match(r.err.join('\n'), /already exists/);
    });
  });

  test('add --force overwrites existing entry', async () => {
    const dir = tmpDir('bro-prov-add4-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      writeFileSync(join(process.cwd(), 'bro.config.json'), JSON.stringify({ providers: { kilo: { type: 'acp', command: 'kilo-old --acp' } } }, null, 2) + '\n');
      await runProvidersCommand(['add', 'kilo', '--force']);
      const cfg = JSON.parse(readFileSync(join(process.cwd(), 'bro.config.json'), 'utf8'));
      assert.deepEqual(cfg.providers.kilo, { type: 'acp', command: 'kilo --acp' });
    });
  });

  test('add to global config with --global', async () => {
    const dir = tmpDir('bro-prov-add5-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      const home = join(dir, 'home');
      const origHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await runProvidersCommand(['add', 'kilo', '--global']);
        const cfg = JSON.parse(readFileSync(join(home, '.config', 'bro', 'config.json'), 'utf8'));
        assert.deepEqual(cfg.providers.kilo, { type: 'acp', command: 'kilo --acp' });
      } finally {
        process.env.HOME = origHome;
      }
    });
  });

  test('add refuses if bro.config.ts shadows', async () => {
    const dir = tmpDir('bro-prov-add6-');
    const { main } = initRepo(dir);
    await insideAsync(main, dir, async () => {
      writeFileSync(join(process.cwd(), 'bro.config.ts'), 'export default {}\n');
      const r = await capture(() => runProvidersCommand(['add', 'kilo']));
      assert.equal(r.code, 1);
      assert.match(r.err.join('\n'), /bro\.config\.ts|shadows/);
    });
  });
});

describe('bro providers test', () => {
  test('test smokes acp connection via acpModels', async () => {
    const fake = fakeAcpAgent({ sessionConfigOptions: [MODEL_OPTION] });
    const r = await capture(() =>
      runProvidersCommand(['test', 'dv-acp'], {
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
        acp: { peer: fake.app },
      })
    );
    assert.equal(r.code, 0);
    assert.match(r.out.join('\n'), /ok: providers\.dv-acp/);
    assert.ok(fake.sessions.length > 0);
  });

  test('test errors on non-acp provider', async () => {
    const r = await capture(() =>
      runProvidersCommand(['test', 'api1'], {
        providers: { api1: { type: 'api', baseUrl: 'http://x', apiKeyEnv: 'K', models: { m: {} } } },
      })
    );
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /must be type 'acp'/);
  });

  test('test errors if provider not configured', async () => {
    const r = await capture(() => runProvidersCommand(['test', 'nope'], { providers: {} }));
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /providers\.nope/);
  });
});
