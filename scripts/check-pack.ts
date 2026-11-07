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
// resolves to a tarball entry at publish time. We invoke npm's CLI through
// the current node binary (process.execPath) and an absolute path to
// npm-cli.js, so no PATH lookup is performed and no user-writable directory
// needs to be on PATH (SonarCloud S4036). Fail closed: an unverified
// tarball cannot be reported as ok.
const npmCliCandidates = [
  '/home/linuxbrew/.linuxbrew/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
  '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
];
const npmCli = npmCliCandidates.find(c => existsSync(c));
if (!npmCli) {
  console.error('check:pack: npm-cli.js not found — cannot verify tarball contents');
  process.exit(1);
}
try {
  const out = execFileSync(
    process.execPath,
    [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: packDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    }
  );
  const parsed = JSON.parse(out);
  const entries: string[] = Array.isArray(parsed)
    ? parsed.flatMap((p: { files?: { path?: string }[] }) => (p.files ?? []).map(f => f.path ?? ''))
    : [];
  if (!entries.includes('pack.json')) {
    console.error('npm pack --dry-run does not list pack.json in tarball');
    process.exit(1);
  }
} catch {
  console.error('check:pack: npm pack --dry-run failed — cannot verify tarball contents');
  process.exit(1);
}

console.error('check:pack ok');
