import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  gitTry,
  type HeldLockOptions,
  holdFileLock,
  LockTimeout,
  writePrivateFileSync,
} from '@broject/core';
import { pidAlive } from '../agent-connectors.ts';

const STATE_DIR = 'bro';
const SERVE_STATE_FILE = 'serve.json';
const PROVIDER_STATE_FILE = 'provider.json';
const GIT_COMMON_ARGS = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

export interface ServeState {
  pid: number;
  url: string;
  dir: string;
  startedAt: string;
  token: string;
  provider?: boolean;
}

export function serveStatePath(dir: string): string | null {
  const r = gitTry(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.code === 0 ? r.out.trim() : '';
  return common === '' ? null : join(common, 'bro', 'serve.json');
}

export function readStateFile(path: string): ServeState | undefined {
  try {
    const safePath = trustedStatePath(path);
    if (safePath === undefined) {
      return undefined;
    }
    const fd = openSync(safePath, 'r');
    let raw: string;
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(size);
      const bytes = readSync(fd, buffer, 0, size, 0);
      raw = buffer.subarray(0, bytes).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const v = JSON.parse(raw) as Partial<ServeState>;
    if (isValidState(v)) {
      return v as ServeState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * State paths are produced by serveStatePath/providerStatePath, never accepted
 * as arbitrary file names. Keep that invariant at this last filesystem
 * boundary too: only the two known state locations are readable, and
 * realpathSync rejects symlinks that would otherwise escape those locations.
 */
function trustedStatePath(path: string): string | undefined {
  const candidate = resolve(path);
  const providerBase = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const providerPath = resolve(join(providerBase, STATE_DIR, PROVIDER_STATE_FILE));
  const isProviderPath = candidate === providerPath;
  const commonDir = resolve(dirname(dirname(candidate)));
  const isServePath =
    candidate === resolve(join(commonDir, STATE_DIR, SERVE_STATE_FILE)) &&
    basename(candidate) === SERVE_STATE_FILE &&
    basename(dirname(candidate)) === STATE_DIR &&
    gitCommonDir(commonDir) === commonDir;
  if (!isProviderPath && !isServePath) {
    return undefined;
  }
  try {
    const canonicalPath = join(realpathSync(dirname(candidate)), basename(candidate));
    return realpathSync(candidate) === canonicalPath ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function gitCommonDir(dir: string): string | undefined {
  const result = gitTry(['-C', dir, ...GIT_COMMON_ARGS]);
  return result.code === 0 && result.out.trim() !== '' ? resolve(result.out.trim()) : undefined;
}

function isValidState(v: Partial<ServeState>): boolean {
  return (
    typeof v.pid === 'number' &&
    typeof v.url === 'string' &&
    typeof v.dir === 'string' &&
    typeof v.token === 'string' &&
    v.token.length > 0
  );
}

export function readServeState(dir: string): ServeState | undefined {
  const path = serveStatePath(dir);
  return path === null ? undefined : readStateFile(path);
}

export function writeStateFile(path: string, state: ServeState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  rmSync(tmp, { force: true });
  writePrivateFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function writeServeState(dir: string, state: ServeState): void {
  const path = serveStatePath(dir);
  if (path === null) {
    throw new Error('no git common dir — cannot write serve.json');
  }
  writeStateFile(path, state);
}

export function clearStateFile(path: string): void {
  try {
    const state = readStateFile(path);
    if (state !== undefined && state.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch {
    // best-effort — stale records are harmless on the next start
  }
}

export function clearServeState(dir: string): void {
  const path = serveStatePath(dir);
  if (path !== null) {
    clearStateFile(path);
  }
}

export function liveServeState(dir: string): ServeState | undefined {
  const state = readServeState(dir);
  return state !== undefined && pidAlive(state.pid) ? state : undefined;
}

export function acquireServeLock(
  dir: string,
  opts: HeldLockOptions = {}
): (() => void) | undefined {
  const statePath = serveStatePath(dir);
  if (statePath === null) {
    return undefined;
  }
  try {
    return holdFileLock(`${statePath}.lock`, {
      waitMs: 250,
      label: 'serve lock',
      ...opts,
    });
  } catch (err) {
    if (err instanceof LockTimeout) {
      return undefined;
    }
    throw err;
  }
}
