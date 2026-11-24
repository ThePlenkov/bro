import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  gitTry,
  holdFileLock,
  LockTimeout,
  type HeldLockOptions,
  mkdirPrivateSync,
  writePrivateFileSync,
} from '@broject/core';
import { pidAlive } from '../agent-connectors.ts';

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
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServeState>;
    if (isValidState(v)) {
      return v as ServeState;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
