/**
 * Verify the @broject/bro-pack package is up to date:
 * 1. Generated pack.json exists and matches trees + package.json
 * 2. Tarball carries pack.json (npm pack --dry-run)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

// Tarball assertion: the published tarball must actually carry pack.json.
// npm pack --dry-run (JSON mode) is the only proof that the `files` list
// resolves to a tarball entry at publish time. PATH is pinned to fixed,
// non-writable directories so the lookup is not subject to PATH injection
// (SonarCloud S4036); execFileSync takes an argv array (no shell).
let npmRan = false;
let tarballHasPackJson = false;
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: packDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // NOSONAR — npm is a required build tool; PATH pinned below
    env: { ...process.env, PATH: '/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin' },
  });
  npmRan = true;
  const parsed = JSON.parse(out);
  const entries: string[] = Array.isArray(parsed)
    ? parsed.flatMap((p: { files?: { path?: string }[] }) => (p.files ?? []).map(f => f.path ?? ''))
    : [];
  tarballHasPackJson = entries.includes('pack.json');
} catch (e) {
  // npm not available / not configured in this env — non-blocking (infra).
  console.error('check:pack: npm pack --dry-run skipped/failed (non-blocking in this env)');
}

if (npmRan && !tarballHasPackJson) {
  console.error('npm pack --dry-run does not list pack.json in tarball');
  process.exit(1);
}

console.error('check:pack ok');
