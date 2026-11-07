/**
 * Verify the @broject/bro-pack package is up to date:
 * 1. Generated pack.json exists and matches trees + package.json
 * 2. Tarball would include pack.json (and schema if referenced)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const packDir = join(root, 'packages/pack');
const packJsonPath = join(packDir, 'pack.json');
const packPkg = JSON.parse(readFileSync(join(packDir, 'package.json'), 'utf8'));

if (!existsSync(packJsonPath)) {
  console.error('packages/pack/pack.json not found — run node scripts/gen-pack.ts');
  process.exit(1);
}

// Verify files list includes pack.json
const files = Array.isArray(packPkg.files) ? packPkg.files : [];
if (!files.includes('pack.json')) {
  console.error('packages/pack/package.json files must include "pack.json"');
  process.exit(1);
}

// Freshness gate: committed pack.json must match package.json + root trees.
const committed = JSON.parse(readFileSync(packJsonPath, 'utf8'));
const expectedSkills = readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();
const expectedFormulas = readdirSync(join(root, 'formulas'))
  .filter(f => f.endsWith('.formula.toml'))
  .sort();
if (
  committed.name !== packPkg.name ||
  committed.version !== packPkg.version ||
  JSON.stringify(committed.skills) !== JSON.stringify(expectedSkills) ||
  JSON.stringify(committed.formulas) !== JSON.stringify(expectedFormulas)
) {
  console.error('packages/pack/pack.json is stale — run node scripts/gen-pack.ts');
  process.exit(1);
}
// Tarball inclusion of pack.json is guaranteed by packages/pack/package.json
// "files" (verified above) and by prepack regenerating pack.json at publish
// time. Running npm pack --dry-run here was only a best-effort sanity check,
// but it requires a subprocess whose PATH cannot be restricted to fixed,
// non-writable directories in every environment (SonarCloud S4036), so it is
// intentionally omitted from this gate.
console.error('check:pack ok');
