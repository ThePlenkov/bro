import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBroMetadata, type BroMetadata } from '../scripts/package-metadata.ts';

export interface CatalogEntry extends BroMetadata {
  name: string;
  npm: string | null;
  description: string;
  source: string;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${field}`);
  return value;
}

export function buildCatalog(
  root = fileURLToPath(new URL('../', import.meta.url))
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const path of globSync(['packages/*/package.json', 'packages/acp/*/package.json'], {
    cwd: root,
  })) {
    const pkg = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    if (pkg.private) continue;
    try {
      entries.push({
        ...validateBroMetadata(pkg.bro),
        name: requiredString(pkg.name, 'package name').replace('@broject/', ''),
        npm: pkg.name,
        description: requiredString(pkg.description, 'description'),
        source: path.replace(/\/package.json$/, ''),
      });
    } catch (error) {
      throw new Error(`${path}: ${String(error)}`);
    }
  }
  const planned: unknown = JSON.parse(
    readFileSync(resolve(root, 'site/planned-connectors.json'), 'utf8')
  );
  if (!Array.isArray(planned)) throw new Error('planned connectors must be an array');
  for (const row of planned) {
    const metadata = validateBroMetadata(row.bro);
    if (metadata.status !== 'planned') throw new Error('unpackaged entries must be planned');
    const source = requiredString(row.source, 'planned source');
    if (!/^(packages|specs|plugins)\/[\w./-]+$/.test(source) || source.includes('..')) {
      throw new Error('planned source must be a repo-relative source/design path');
    }
    entries.push({
      ...metadata,
      name: requiredString(row.name, 'planned name'),
      npm: null,
      description: requiredString(row.description, 'planned description'),
      source,
    });
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`duplicate catalog name: ${entry.name}`);
    names.add(entry.name);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
