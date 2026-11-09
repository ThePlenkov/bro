// Mechanical enforcement of the model's purity contract (design D2): no runtime imports beyond
// this package's own files — the ACP SDK is referenced through `import type` only, and no
// framework (@opentui/*, solid-js), Node builtin, or @broject/* import may appear.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('.', import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });

// Matches `import/export … from 'x'`, side-effect `import 'x'`, and dynamic `import('x')`.
const IMPORT_RE =
  /\b(?:import|export)\s+(type\s+)?[\w*{}\s,]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;

const FORBIDDEN = [/^@opentui\//, /^solid-js\b/, /^@broject\//, /^node:/];

test('import graph: model imports only its own files, sdk is type-only', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2] ?? m[3] ?? m[4];
      if (spec === undefined) continue;
      const typeOnly = m[1] !== undefined || /^export\s+type\b/.test(m[0]);
      if (spec.startsWith('.')) continue;
      if (typeOnly && spec === '@agentclientprotocol/sdk') continue;
      if (!typeOnly && FORBIDDEN.some(re => re.test(spec))) {
        offenders.push(`${file}: forbidden import '${spec}'`);
      } else {
        offenders.push(`${file}: non-relative import '${spec}' (sdk must be 'import type')`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
