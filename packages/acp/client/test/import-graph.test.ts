// Mechanical enforcement of acp-client's closed-subtree contract.
//
//   R1  Bare imports are whitelist-only: `node:*` builtins. No
//       @opentui/*, no solid-js, no other @broject/* — the protocol
//       code must stay Node-testable, because the TUI's walls (Solid's
//       Bun-only JSX transform, OpenTUI's Bun-only native FFI) must
//       not reach it.
//   R2  Relative imports must resolve inside this package.
//
// The test walks the real source tree — a package that grows a
// dependency on the renderer is a bug the test catches.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { test } from 'node:test';

const PKG = new URL('..', import.meta.url).pathname;
const SRC = join(PKG, 'src') + sep;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });

const IMPORT_RE =
  /\b(?:import|export)\s+(type\s+)?[\w*{}\s,]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;

test('import graph: closed subtree, node builtins only', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2] ?? m[3] ?? m[4];
      if (spec === undefined) continue;
      if (spec.startsWith('.')) {
        const resolved = normalize(join(file, '..', spec));
        if (!resolved.startsWith(SRC) && resolved !== SRC.slice(0, -1)) {
          offenders.push(`${file}: escapes package — '${spec}'`);
        }
        continue;
      }
      if (spec.startsWith('node:')) continue;
      offenders.push(`${file}: bare import '${spec}' is not whitelisted`);
    }
  }
  assert.deepEqual(offenders, []);
});
