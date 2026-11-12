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
  realpathSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const resolveIn = (base: string, name: string): string => {
  const root = resolve(base);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the tree: ${target}`);
  }
  // lexical containment is not enough — a symlink on any existing
  // ancestor resolves the write outside root. The returned path keeps
  // the configured spelling (scan agrees with it); only the deepest
  // existing prefix is realpath-verified against the real root. A
  // missing root means nothing to escape into — the lexical check is
  // the whole guard.
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  let probe = target;
  while (!existsSync(probe) && probe !== root) {
    const up = dirname(probe);
    if (up === probe) {
      break;
    }
    probe = up;
  }
  if (existsSync(probe)) {
    const relReal = relative(realRoot, realpathSync(probe));
    if (relReal.startsWith('..') || isAbsolute(relReal)) {
      throw new Error(`path escapes the tree: ${target}`);
    }
  }
  return target;
};

export const ioExists = (path: string): boolean => existsSync(path);

export const ioRead = (path: string): string => readFileSync(path, 'utf8');

export const ioReadDir = (path: string): Dirent[] => readdirSync(path, { withFileTypes: true });

export const ioWrite = (path: string, content: string, opts?: { exclusive?: boolean }): void => {
  mkdirSync(dirname(path), { recursive: true });
  // `wx` makes the no-overwrite check atomic — an existsSync pre-check
  // leaves a window where another writer lands first.
  writeFileSync(path, content, opts?.exclusive === true ? { flag: 'wx' } : {});
};

export const ioRemove = (path: string, recursive = false): void => {
  rmSync(path, { force: true, recursive });
};
