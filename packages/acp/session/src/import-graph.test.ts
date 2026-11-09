// Mechanical enforcement of acp-session's closed-subtree + layering contract.
//
//   R1  Bare imports are whitelist-only: `node:*` builtins,
//       `@broject/acp-model`, and type-only `@agentclientprotocol/sdk`.
//       No @opentui/*, no solid-js, no other @broject/* — not even
//       type-only. Everything the package needs from bro travels as
//       injected arguments, never as an import.
//   R2  Relative imports must resolve inside this package's src/ —
//       no `../../providers/…` escapes (the plugin's old deep-import
//       pattern is exactly what this package replaces).
//   R3  Layer direction (LAYERS): a module under src/<layer>/ may import
//       only its own layer plus the layers it is listed as allowed to
//       read. Files directly under src/ (the public index) may read any
//       layer; no layer may read them back.
//
// The test walks the real source tree — add a layer to LAYERS when it
// lands and the direction is checked from the first commit.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('.', import.meta.url).pathname;

/** layer → the other layers it may read (its own layer is always allowed). */
const LAYERS: Record<string, string[]> = {
  wire: [],
  archive: ['wire'],
  model: ['wire', 'archive'],
  view: ['wire', 'archive', 'model'],
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });

const IMPORT_RE =
  /\b(?:import|export)\s+(type\s+)?[\w*{}\s,]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;

const layerOf = (file: string): string => {
  const rel = file.slice(SRC.length);
  const head = rel.split(sep)[0] ?? '';
  return LAYERS[head] !== undefined ? head : 'root';
};

test('import graph: closed subtree + layer direction', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const fromLayer = layerOf(file);
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2] ?? m[3] ?? m[4];
      if (spec === undefined) continue;
      const typeOnly = m[1] !== undefined || /^export\s+type\b/.test(m[0]);

      if (spec.startsWith('.')) {
        // R2: resolve inside src/; R3: layer direction.
        const resolved = normalize(join(file, '..', spec));
        if (!resolved.startsWith(SRC) && resolved !== SRC.slice(0, -1)) {
          offenders.push(`${file}: escapes package — '${spec}'`);
          continue;
        }
        const toLayer = layerOf(`${resolved}${sep}`);
        if (
          fromLayer !== 'root' &&
          toLayer !== fromLayer &&
          !(LAYERS[fromLayer] ?? []).includes(toLayer)
        ) {
          offenders.push(`${file}: ${fromLayer} → ${toLayer} ('${spec}') violates layer direction`);
        }
        continue;
      }

      // R1: bare-import whitelist.
      if (spec === '@broject/acp-model' || spec.startsWith('node:')) continue;
      if (typeOnly && spec === '@agentclientprotocol/sdk') continue;
      offenders.push(`${file}: bare import '${spec}' is not whitelisted`);
    }
  }
  assert.deepEqual(offenders, []);
});
