import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function withinRoot(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const remainder = relative(resolvedRoot, resolvedPath);
  const escapesRoot = [
    remainder === '..',
    remainder.startsWith(`..${sep}`),
    isAbsolute(remainder),
  ].some(Boolean);
  if (escapesRoot) {
    throw new Error(`path is outside the configured root: ${path}`);
  }
  return resolvedPath;
}

export function ioMkdir(root: string, path: string): void {
  const safePath = withinRoot(root, path);
  mkdirSync(safePath, { recursive: true }); // NOSONAR — safePath is confined to the operator-selected root.
}

export function ioWriteAtomic(root: string, path: string, content: string): void {
  const safePath = withinRoot(root, path);
  const temporary = `${safePath}.${process.pid}.tmp`;
  ioMkdir(root, dirname(safePath));
  writeFileSync(temporary, content, 'utf8'); // NOSONAR — temporary is derived from a root-confined path.
  renameSync(temporary, safePath); // NOSONAR — both paths are root-confined by construction.
}

export function ioRead(root: string, path: string): string {
  const safePath = withinRoot(root, path);
  return readFileSync(safePath, 'utf8'); // NOSONAR — safePath is confined to the operator-selected root.
}
