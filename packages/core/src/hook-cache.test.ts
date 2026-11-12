import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './testtmp.ts';
import { scrubEnv, testGit } from './testkit.ts';
import { loadConfigLayers } from './config.ts';
import {
  collectGuards,
  registerConnector,
  unregisterConnector,
  type Connector,
} from './connectors.ts';
import { isJsonData, probesHold, readCacheFile, statProbe, writeCacheFile } from './hook-cache.ts';
import type { Guard } from './guards.ts';

// ambient repo/agent/store pins must not reach fixture git children or
// the code-under-test spawns — and BRO_HOOK_CACHE must not leak in
after(scrubEnv());

/** A tmpdir made a real repo — the layer cache only engages under a
 *  git common dir (its records live in .git/bro/hooks/cache). */
function repo(): string {
  const dir = tmpDir('bro-hc-');
  testGit(['init', '-q', dir]);
  return dir;
}

const cacheDirOf = (dir: string): string => join(dir, '.git', 'bro', 'hooks', 'cache');
const records = (dir: string, prefix: string): string[] =>
  existsSync(cacheDirOf(dir)) ? readdirSync(cacheDirOf(dir)).filter(f => f.startsWith(prefix)) : [];

const guard = (name: string): Guard => ({
  name,
  when: { on: ['stop'] },
  say: `say-${name}`,
});

describe('hook-cache primitives', () => {
  test('statProbe + probesHold: content edits and deletions flip', () => {
    const dir = tmpDir('bro-hc-');
    const f = join(dir, 'a.json');
    writeFileSync(f, '{"a":1}');
    const probes = [statProbe(f), statProbe(join(dir, 'missing.json'))];
    assert.ok(probesHold(probes));
    writeFileSync(f, '{"a":1,"b":2}'); // size flips
    assert.ok(!probesHold(probes));
    // same size, bumped mtime also flips (utimesSync — a rewrite inside
    // one mtime tick proves nothing)
    writeFileSync(f, '{"a":9}');
    utimesSync(f, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    assert.ok(!probesHold(probes));
  });

  test('a recorded-missing file appearing flips the fingerprint', () => {
    const dir = tmpDir('bro-hc-');
    const f = join(dir, 'later.json');
    const probes = [statProbe(f)];
    assert.ok(probesHold(probes));
    writeFileSync(f, '{}');
    assert.ok(!probesHold(probes));
  });

  test('isJsonData rejects functions, cycles, class instances', () => {
    assert.ok(isJsonData({ a: [1, 'x', null, { b: true }] }));
    assert.ok(!isJsonData({ f: () => 1 }));
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    // depth guard bounds cycles — a recursive structure is not JSON data
    assert.ok(!isJsonData(cyc));
    class C {}
    assert.ok(!isJsonData(new C()));
    assert.ok(!isJsonData(undefined));
  });

  test('readCacheFile tolerates garbage; writeCacheFile round-trips', () => {
    const dir = tmpDir('bro-hc-');
    const f = join(dir, 'r.json');
    writeFileSync(f, '{not json');
    assert.equal(readCacheFile(f), undefined);
    writeCacheFile(f, { v: 1, x: 'y' }, 'r-');
    assert.deepEqual(readCacheFile(f), { v: 1, x: 'y' });
  });
});

describe('loadConfigLayers cache (spec bro-gwh2a)', () => {
  // root ignores file modes — chmod 000 stays readable, so the "cached
  // record must answer" premise can't hold under uid 0
  test('a second load serves the record — an unreadable config still answers', {
    skip: process.getuid?.() === 0,
  }, () => {
    const dir = repo();
    const cfg = join(dir, 'bro.config.json');
    writeFileSync(cfg, JSON.stringify({ marker: 'v1' }));
    const first = loadConfigLayers(dir);
    assert.equal(first.layers.length, 1);
    assert.equal((first.layers[0]!.raw as { marker: string }).marker, 'v1');

    // fingerprint holds but the live read would fail — only the record
    // can answer this
    chmodSync(cfg, 0o000);
    try {
      const second = loadConfigLayers(dir);
      assert.equal(second.layers.length, 1);
      assert.equal((second.layers[0]!.raw as { marker: string }).marker, 'v1');

      // mtime flip → miss → the live read runs and fails (file still
      // unreadable) → broken, not cached
      utimesSync(cfg, new Date(), new Date());
      const third = loadConfigLayers(dir);
      assert.equal(third.layers.length, 0);
      assert.ok(third.broken.some(b => b.endsWith('bro.config.json')));
    } finally {
      chmodSync(cfg, 0o644);
    }
  });

  test('a new competing file flips the recorded-missing probe → rescan', () => {
    const dir = repo();
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ marker: 'project' }));
    loadConfigLayers(dir);
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify({ marker: 'local' }));
    const { layers } = loadConfigLayers(dir);
    const local = layers.find(l => l.layer === 'local');
    assert.equal((local?.raw as { marker?: string } | undefined)?.marker, 'local');
  });

  test('a corrupt record falls back to the live scan and rewrites', () => {
    const dir = repo();
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ marker: 'ok' }));
    loadConfigLayers(dir);
    const [rec] = records(dir, 'config-layer-project-');
    assert.ok(rec !== undefined);
    writeFileSync(join(cacheDirOf(dir), rec), '{torn');
    const { layers } = loadConfigLayers(dir);
    assert.equal((layers[0]!.raw as { marker: string }).marker, 'ok');
    // the miss rewrote the record — valid JSON again
    assert.ok(readCacheFile(join(cacheDirOf(dir), rec)) !== undefined);
  });

  test('a well-formed record with malformed fields is refused — live scan answers', () => {
    const dir = repo();
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ marker: 'ok' }));
    loadConfigLayers(dir);
    const [rec] = records(dir, 'config-layer-project-');
    const file = join(cacheDirOf(dir), rec!);
    const good = readCacheFile(file)!;
    const goodHit = good.hit as Record<string, unknown>;
    // poison each field the read side must prove — every variant misses
    for (const bad of [
      { ...good, broken: [42] },
      { ...good, broken: 'x' },
      { ...good, probes: [{ path: 1 }] },
      { ...good, hit: { ...goodHit, raw: 'not-an-object' } },
      { ...good, hit: { ...goodHit, file: 7 } },
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      const { layers } = loadConfigLayers(dir);
      assert.equal((layers[0]!.raw as { marker: string }).marker, 'ok');
    }
  });

  test('a .ts winner records with a TTL tag — .json layers stay pure-fingerprint', () => {
    const dir = repo();
    writeFileSync(join(dir, 'bro.config.ts'), 'export default { marker: "ts" }\n');
    const { layers } = loadConfigLayers(dir);
    assert.equal((layers[0]!.raw as { marker: string }).marker, 'ts');
    const [rec] = records(dir, 'config-layer-project-');
    assert.ok(rec !== undefined);
    const record = readCacheFile(join(cacheDirOf(dir), rec))!;
    assert.equal(typeof record.ts, 'number');
    // local layer saw no .ts — no TTL tag
    const [local] = records(dir, 'config-layer-local-');
    assert.equal(readCacheFile(join(cacheDirOf(dir), local!))!.ts, undefined);
  });

  test('BRO_HOOK_CACHE=0 writes no record', () => {
    const prev = process.env.BRO_HOOK_CACHE;
    process.env.BRO_HOOK_CACHE = '0';
    try {
      const dir = repo();
      writeFileSync(join(dir, 'bro.config.json'), '{}');
      loadConfigLayers(dir);
      assert.equal(records(dir, 'config-layer-').length, 0);
    } finally {
      if (prev === undefined) delete process.env.BRO_HOOK_CACHE;
      else process.env.BRO_HOOK_CACHE = prev;
    }
  });

  test('outside a repo there is no cache and identical results', () => {
    const dir = tmpDir('bro-hc-');
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ marker: 'x' }));
    const { layers } = loadConfigLayers(dir);
    assert.equal((layers[0]!.raw as { marker: string }).marker, 'x');
    assert.ok(!existsSync(join(dir, '.git')));
  });
});

describe('collectGuards cache (spec bro-gwh2a)', () => {
  test('a duplicate declaration warns once per fingerprint, not per call', () => {
    const dir = repo();
    const dup: Connector = { name: 'hc-dup', guards: () => [guard('dup-name')] };
    registerConnector(dup);
    const captured: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(' '));
    try {
      const first = collectGuards({ dir, sessionId: 's1' }, [guard('dup-name')]);
      assert.ok(
        captured.some(l => l.includes("guard 'dup-name'") && l.includes('duplicates')),
        `first collect should warn, got: ${captured.join('|')}`
      );
      captured.length = 0;
      const second = collectGuards({ dir, sessionId: 's1' }, [guard('dup-name')]);
      assert.deepEqual(second, first);
      assert.equal(
        captured.filter(l => l.includes('dup-name')).length,
        0,
        `cache hit should re-emit nothing, got: ${captured.join('|')}`
      );
    } finally {
      console.error = origErr;
      unregisterConnector('hc-dup');
    }
  });

  test('another session collects live — records are per-session', () => {
    const dir = repo();
    const dup: Connector = { name: 'hc-sess', guards: () => [guard('dup-name')] };
    registerConnector(dup);
    const captured: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(' '));
    try {
      collectGuards({ dir, sessionId: 's1' }, [guard('dup-name')]);
      captured.length = 0;
      collectGuards({ dir, sessionId: 's2' }, [guard('dup-name')]);
      assert.ok(captured.some(l => l.includes('dup-name')));
    } finally {
      console.error = origErr;
      unregisterConnector('hc-sess');
    }
  });

  test('outside a repo collection runs live every call', () => {
    const dir = tmpDir('bro-hc-');
    const dup: Connector = { name: 'hc-norepo', guards: () => [guard('dup-name')] };
    registerConnector(dup);
    const captured: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => captured.push(a.map(String).join(' '));
    try {
      collectGuards({ dir }, [guard('dup-name')]);
      collectGuards({ dir }, [guard('dup-name')]);
      assert.equal(captured.filter(l => l.includes('dup-name')).length, 2);
    } finally {
      console.error = origErr;
      unregisterConnector('hc-norepo');
    }
  });
});
