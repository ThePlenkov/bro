// packages/pack generator — copies the canonical skills/ + formulas/
// trees into the pack package so the published tarball carries the same
// capability files the embedded skills-data.ts snapshot does. Runs from
// @broject/bro-pack's prepack; safe to re-run.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packDir = join(root, 'packages/pack');

// Copy trees
for (const dir of ['skills', 'formulas']) {
  const dst = join(packDir, dir);
  rmSync(dst, { recursive: true, force: true });
  cpSync(join(root, dir), dst, { recursive: true });
}

// Emit pack.json (manifest) synced from package.json
const packPkg = JSON.parse(readFileSync(join(packDir, 'package.json'), 'utf8'));
const skills = readdirSync(join(packDir, 'skills'), { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();
const formulas = readdirSync(join(packDir, 'formulas'))
  .filter(f => f.endsWith('.formula.toml'))
  .sort();

const manifest = {
  $schema: 'https://unpkg.com/@broject/bro/schemas/pack.schema.json',
  name: packPkg.name,
  version: packPkg.version,
  requires: { bro: '>=0.2.5' },
  skills,
  formulas,
};

writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n');
console.error('pack content: skills/, formulas/ → packages/pack; pack.json emitted');
