/** All filesystem access for brotocol. A filetree protocol's paths are
 *  inherently dynamic — they come from the configured root, the doc
 *  glob, and doc ids — so every call concentrates here where it can be
 *  audited in one place. `resolveIn` is the guard every write/remove
 *  must pass through: normalize, then prove the target stays under
 *  `base`; a `..` escape never reaches an fs call. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const resolveIn = (base: string, name: string): string => {
  const target = resolve(base, name);
  const rel = relative(resolve(base), target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the tree: ${target}`);
  }
  return target;
};

export const ioExists = (path: string): boolean => existsSync(path);

export const ioRead = (path: string): string => readFileSync(path, 'utf8');

export const ioReadDir = (path: string): Dirent[] => readdirSync(path, { withFileTypes: true });

export const ioWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

export const ioRemove = (path: string, recursive = false): void => {
  rmSync(path, { force: true, recursive });
};
