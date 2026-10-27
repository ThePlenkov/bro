/** brouter — the model-centric routing registry (spec: specs/bro-n1p0s.md). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrouterConfigError,
  brouterStaticCatalog,
  parseBrouter,
  resolveModelRoute,
  type BrouterConfig,
} from './brouter.ts';
import type { ProviderEntry } from './providers.ts';

const providers: Record<string, ProviderEntry> = {
  'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-2-max' },
  zen: {
    type: 'cli',
    command: 'zen run --model {model}',
    model: 'opencode/space-bunny-free',
    models: 'zen models',
  },
  orca: {
    type: 'api',
    baseUrl: 'http://x',
    apiKeyEnv: 'K',
    models: { 'typesafe/jev-1.13': 'systemone', 'acme/chat': 'openai-compat' },
  },
};

const err = (fn: () => unknown): string[] => {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (m: unknown) => lines.push(String(m));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
};

describe('parseBrouter', () => {
  test('absent/garbage section parses to an empty registry', () => {
    assert.deepEqual(parseBrouter(undefined), { models: {} });
    assert.deepEqual(parseBrouter('x'), { models: {} });
    assert.deepEqual(parseBrouter({}), { models: {} });
  });

  test('shorthand, object, and ordered-list routes normalize', () => {
    const cfg = parseBrouter({
      models: {
        'swe-2-max': 'dv-acp',
        jev: { provider: 'dv-acp', model: 'kilo/orca/typesafe/jev-1.13' },
        cheap: ['zen', { provider: 'dv-acp', model: 'swe-2-medium' }],
      },
    });
    assert.deepEqual(cfg.models['swe-2-max'], [{ provider: 'dv-acp' }]);
    assert.deepEqual(cfg.models.jev, [
      { provider: 'dv-acp', model: 'kilo/orca/typesafe/jev-1.13' },
    ]);
    assert.deepEqual(cfg.models.cheap, [
      { provider: 'zen' },
      { provider: 'dv-acp', model: 'swe-2-medium' },
    ]);
  });

  test('malformed routes drop with a warning; a fully-dropped key leaves the registry', () => {
    const lines = err(() => {
      const cfg = parseBrouter({
        models: {
          good: 'dv-acp',
          bad1: { model: 'x' },
          bad2: 42,
          bad3: [],
          bad4: ['dv-acp', 7],
        },
      });
      assert.deepEqual(cfg.models.good, [{ provider: 'dv-acp' }]);
      // a list keeps its surviving entries
      assert.deepEqual(cfg.models.bad4, [{ provider: 'dv-acp' }]);
      assert.equal(Object.hasOwn(cfg.models, 'bad1'), false);
      assert.equal(Object.hasOwn(cfg.models, 'bad2'), false);
      assert.equal(Object.hasOwn(cfg.models, 'bad3'), false);
    });
    assert.ok(lines.some(l => /brouter\.models\.bad1 requires "provider"/.test(l)));
    assert.ok(lines.some(l => /brouter\.models\.bad2 must be/.test(l)));
    assert.ok(lines.some(l => /brouter\.models\.bad3 has no usable routes/.test(l)));
  });

  test('a __proto__ model id lands as an own key', () => {
    const cfg = parseBrouter({ models: { ['__proto__']: 'dv-acp' } });
    assert.deepEqual(Object.getOwnPropertyDescriptor(cfg.models, '__proto__')?.value, [
      { provider: 'dv-acp' },
    ]);
  });
});

describe('brouterStaticCatalog', () => {
  test('api allowlist keys + pinned models; live surfaces stay out', () => {
    assert.deepEqual(brouterStaticCatalog(providers), {
      'dv-acp': ['swe-2-max'],
      zen: ['opencode/space-bunny-free'],
      orca: ['typesafe/jev-1.13', 'acme/chat'],
    });
  });
});

describe('resolveModelRoute', () => {
  const catalog = brouterStaticCatalog(providers);
  const brouter: BrouterConfig = {
    models: {
      'swe-2-max': [{ provider: 'dv-acp' }],
      jev: [{ provider: 'dv-acp', model: 'kilo/orca/typesafe/jev-1.13' }],
      cheap: [{ provider: 'zen' }, { provider: 'dv-acp', model: 'swe-2-medium' }],
    },
  };

  test('a qualified id routes verbatim — head must be a configured provider', () => {
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'zen/other-model'), [
      { provider: 'zen', model: 'other-model' },
    ]);
    // a multi-slash id splits on the FIRST segment only
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'dv-acp/a/b/c'), [
      { provider: 'dv-acp', model: 'a/b/c' },
    ]);
  });

  test('a non-provider head is not a qualifier — falls through to bare sources', () => {
    // 'opencode' is not a configured provider — catalog decides
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'opencode/space-bunny-free'), [
      { provider: 'zen', model: 'opencode/space-bunny-free' },
    ]);
  });

  test('declared routes — verbatim model default, alias rewrite, ordered list', () => {
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'swe-2-max'), [
      { provider: 'dv-acp', model: 'swe-2-max' },
    ]);
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'jev'), [
      { provider: 'dv-acp', model: 'kilo/orca/typesafe/jev-1.13' },
    ]);
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'cheap'), [
      { provider: 'zen', model: 'cheap' },
      { provider: 'dv-acp', model: 'swe-2-medium' },
    ]);
    // declared beats catalog — 'swe-2-max' is also dv-acp's pin
    assert.deepEqual(
      resolveModelRoute(providers, brouter, catalog, 'swe-2-max')[0]?.provider,
      'dv-acp'
    );
  });

  test('a declared route to an unknown provider throws naming the brouter key', () => {
    const cfg: BrouterConfig = { models: { x: [{ provider: 'nope' }] } };
    assert.throws(
      () => resolveModelRoute(providers, cfg, catalog, 'x'),
      (e: unknown) =>
        e instanceof BrouterConfigError && /brouter\.models\.x.*providers\.nope/.test(e.message)
    );
  });

  test('catalog — unique server in providers order; no match is empty', () => {
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'typesafe/jev-1.13'), [
      { provider: 'orca', model: 'typesafe/jev-1.13' },
    ]);
    assert.deepEqual(resolveModelRoute(providers, brouter, catalog, 'ghost'), []);
    // multiple servers → ordered candidates, config order
    const multi = { ...catalog, 'dv-acp': [...catalog['dv-acp']!, 'typesafe/jev-1.13'] };
    assert.deepEqual(resolveModelRoute(providers, brouter, multi, 'typesafe/jev-1.13'), [
      { provider: 'dv-acp', model: 'typesafe/jev-1.13' },
      { provider: 'orca', model: 'typesafe/jev-1.13' },
    ]);
  });

  test('qualified beats declared beats catalog', () => {
    const cfg: BrouterConfig = { models: { 'zen/x': [{ provider: 'dv-acp' }] } };
    // 'zen/x' qualifies on provider 'zen' — the declared route never fires
    assert.deepEqual(resolveModelRoute(providers, cfg, catalog, 'zen/x'), [
      { provider: 'zen', model: 'x' },
    ]);
  });
});
