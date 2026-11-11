/** Shared test fixtures — file trees in mkdtemp dirs. Not part of the
 *  library surface (unreached by `src/index.ts`, never bundled). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Protocol } from './protocol.ts';

export const mktree = (
  files: Record<string, string>
): { root: string; dir: (p: string) => string } => {
  const root = mkdtempSync(join(tmpdir(), 'brotocol-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, dir: (p: string) => join(root, p) };
};

export const rm = (root: string): void => rmSync(root, { recursive: true, force: true });

/** The spec-shaped protocol over a fixture root, without shipped
 *  template dirs (tests that need templates set `templateDirs`). */
export const proto = (root: string): Protocol => ({
  root,
  docGlob: '**/*.spec.md',
  indexName: d => `${d}.spec.md`,
  indexAliases: ['spec.md', 'README.md'],
  idField: 'id',
  parentField: 'parent',
});
