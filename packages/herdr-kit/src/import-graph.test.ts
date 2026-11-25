/** The kit's boundary contract — enforced mechanically.
 *
 *  1. THE EXEC SEAM: `node:child_process` is allowed in `client/exec.ts`
 *     ONLY. Every other module builds argvs; nothing else spawns.
 *  2. LAYER DIRECTION: wire …— the kit's internal order is
 *     client → fleet → lines → views; a layer may only import layers
 *     listed to its left (client imports nothing internal).
 *  3. BARE IMPORTS: node:*, the kit's declared deps
 *     (@broject/core, @broject/acp-session, @broject/acp-model), and
 *     type-only externals — nothing else. */
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) yield p;
  }
}

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
const layerOf = (path: string): string => relative(SRC, path).split('/')[0] ?? '';

const LAYERS: Record<string, string[]> = {
  client: [],
  fleet: ['client'],
  lines: ['client', 'fleet'],
  views: ['client', 'fleet', 'lines'],
  'index.ts': ['client', 'fleet', 'lines', 'views'],
};

const BARE_OK = new Set([
  '@broject/core',
  '@broject/acp-session',
  '@broject/acp-model',
  '@broject/providers',
]);

test('the exec seam: only client/exec.ts spawns', () => {
  for (const f of walk(SRC)) {
    const body = readFileSync(f, 'utf8');
    assert.equal(
      body.includes('node:child_process'),
      f.endsWith('client/exec.ts'),
      `${relative(SRC, f)} must not import child_process — the spawnSync('herdr') seam lives in client/exec.ts only`
    );
  }
});

function checkLocalImport(f: string, spec: string): void {
  const layer = layerOf(f);
  const target = resolve(dirname(f), spec);
  const relativeTarget = relative(SRC, target);
  const targetLayer = relativeTarget.split(sep)[0] ?? '';
  assert.ok(
    Object.hasOwn(LAYERS, targetLayer),
    `${relative(SRC, f)} imports outside the known layers via '${spec}' (target layer ${targetLayer})`
  );
  if (targetLayer === layer) return;
  assert.ok(
    (LAYERS[layer] ?? []).includes(targetLayer),
    `${relative(SRC, f)} (layer ${layer}) must not import layer ${targetLayer}`
  );
}

function checkBareImport(f: string, spec: string): void {
  assert.ok(
    spec.startsWith('node:') || BARE_OK.has(spec),
    `${relative(SRC, f)} bare import '${spec}' is not whitelisted`
  );
}

test('layer direction + bare-import whitelist', () => {
  for (const f of walk(SRC)) {
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith('.')) checkLocalImport(f, spec);
      else checkBareImport(f, spec);
    }
  }
});

test('rejects imports targeting an unknown root module', () => {
  assert.throws(
    () => checkLocalImport(join(SRC, 'client', 'index.ts'), '../new-root.ts'),
    /target layer new-root\.ts/
  );
});

test('rejects relative imports escaping the package', () => {
  assert.throws(
    () => checkLocalImport(join(SRC, 'client', 'index.ts'), '../../../outside.ts'),
    /target layer \.\./
  );
});
