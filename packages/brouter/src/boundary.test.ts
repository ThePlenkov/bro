/**
 * The package boundary — brouter never imports the client adapters.
 *
 * `@broject/client-adapters` reads the catalog through this package's
 * public API; the dependency points one way (spec bro-0ykhg.6). A
 * reverse edge — a dependency entry or an import specifier — would
 * couple the router's release cycle back to the clients' churn, which
 * is exactly what the split exists to prevent.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const PKG = join(SRC, '..', 'package.json');

/** Every .ts file under src/, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('brouter declares no dependency on the client adapters', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.['@broject/client-adapters'], undefined);
  assert.equal(pkg.devDependencies?.['@broject/client-adapters'], undefined);
});

test('no brouter source imports the client adapters', () => {
  // an import/export specifier naming the package — prose mentions in
  // doc comments are not edges
  const specifier = /(?:from|import|require)\s*\(?\s*['"][^'"]*client-adapters/;
  const files = sources(SRC);
  // the check is only as strong as its file list — the suite runs on
  // sources (tsx --test src/**), so an empty scan would mean the test
  // is anchored somewhere with no .ts files and proves nothing
  assert.ok(files.length > 0, 'the boundary scan must see brouter sources');
  const offenders = files
    .filter(path => specifier.test(readFileSync(path, 'utf8')))
    .map(path => path.slice(SRC.length));
  assert.deepEqual(offenders, []);
});
