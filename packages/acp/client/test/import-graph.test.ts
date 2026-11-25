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

function checkSpec(file: string, spec: string, offenders: string[]): void {
  if (spec.startsWith('node:')) return;
  if (!spec.startsWith('.')) {
    offenders.push(`${file}: bare import '${spec}' is not whitelisted`);
    return;
  }
  const resolved = normalize(join(file, '..', spec));
  if (!resolved.startsWith(SRC) && resolved !== SRC.slice(0, -1)) {
    offenders.push(`${file}: escapes package — '${spec}'`);
  }
}

test('import graph: closed subtree, node builtins only', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const spec = m[2] ?? m[3] ?? m[4];
      if (spec !== undefined) checkSpec(file, spec, offenders);
    }
  }
  assert.deepEqual(offenders, []);
});
