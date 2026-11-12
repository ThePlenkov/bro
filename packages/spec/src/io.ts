/** All filesystem access for @broject/spec. Spec paths are inherently
 *  dynamic — `sdd.dir` is config-resolved and containment-checked by
 *  specDirAbs before it reaches a store, doc paths come from the
 *  protocol scan — so every call concentrates here where it can be
 *  audited in one place, the same seam brose/brotocol keep. */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';

export const ioExists = (path: string): boolean => existsSync(path);

export const ioRead = (path: string): string => readFileSync(path, 'utf8');

export const ioReadDir = (path: string): Dirent[] => readdirSync(path, { withFileTypes: true });
