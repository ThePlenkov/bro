/** All filesystem access for brose. Paths here are operator-named —
 *  the CLI's file argument, `--out`, `--templates-dir`, or the
 *  project-local `.brose/templates/` dir. Concentrating every fs call
 *  in this module keeps the dynamic-path surface auditable in one
 *  place instead of spread across consumers. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname } from 'node:path';

export const ioExists = (path: string): boolean => existsSync(path);

export const ioRead = (path: string): string => readFileSync(path, 'utf8');

export const ioWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

export const ioReadDir = (path: string): Dirent[] => readdirSync(path, { withFileTypes: true });
