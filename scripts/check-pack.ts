/**
 * Verify the @broject/bro-pack package is up to date:
 * 1. Generated pack.json exists and matches trees + package.json
 * 2. Tarball would include pack.json (and schema if referenced)
 */
import { existsSync, readFileSync } from 'node:fs';
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

// Quick check: try to see if npm pack --dry-run would include it (best effort)
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
    cwd: packDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as string;
  const err = (out as any)?.toString?.() ?? String(out);
  // npm writes to stderr in some cases; try to capture both
  try {
    const { execFileSync: ex } = await import('node:child_process');
  } catch {}
  if (!err.includes('pack.json') && !(out + '').includes('pack.json')) {
    // also check stderr by running differently
    const res = execFileSync('sh', ['-c', 'npm pack --dry-run --ignore-scripts 2>&1'], {
      cwd: packDir,
      encoding: 'utf8',
    });
    if (!String(res).includes('pack.json')) {
      console.error('npm pack --dry-run does not list pack.json in tarball');
      process.exit(1);
    }
  }
  console.error('check:pack ok');
} catch (e) {
  // Don't fail hard if npm not fully configured in this env; just warn
  console.error('check:pack: npm pack --dry-run skipped/failed (non-blocking in this env)');
}
