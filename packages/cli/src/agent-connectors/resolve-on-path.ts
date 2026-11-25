import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Resolve a PATH binary ourselves and pin the absolute path — first
 *  PATH dir wins, same order the OS uses; spawnSync then needs no
 *  PATH lookup of its own. */
export function resolveOnPath(bin: string): string | null {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(dir => dir !== '')
    .flatMap(dir => exts.map(ext => join(dir, bin + ext)));
  return candidates.find(isExecutableFile) ?? null;
}
