/**
 * Hook-path file caches (spec: specs/bro-gwh2a.md). Each `bro hooks`
 * event is a fresh process, so "serve N calls from memory" is a small
 * JSON record under `<git-common>/bro/hooks/cache/` — parsed once per
 * content fingerprint, read back by every later invocation.
 *
 * Fail-open everywhere: a corrupt/unreadable/missing record is a miss,
 * a failed write is dropped, nothing here may throw or stall the hook.
 * `BRO_HOOK_CACHE=0` disables all of it (debug escape hatch).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir } from './git.ts';
import { writePrivateFileSync } from './private-files.ts';

/** One fingerprinted path — `exists` false means "this file was absent
 *  at scan time"; appearing later must invalidate. Stats ride along on
 *  existing files (mtimeMs + size, both exact-compared on reads). */
export interface FileProbe {
  path: string;
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

export function hookCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRO_HOOK_CACHE !== '0';
}

/** `<git-common>/bro/hooks/cache` — null outside a repo (cache silently
 *  off, matching the lessons/drills snapshot behavior). The probe is
 *  budget-bounded: a stalled mount reads as "no repo" rather than
 *  hanging the hook. `dir` need not be resolved; gitCommonDir handles
 *  the relative/ambient-env cases. */
export function hookCacheDir(dir: string): string | null {
  if (!hookCacheEnabled()) {
    return null;
  }
  try {
    const common = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
    return common === null ? null : join(common, 'bro', 'hooks', 'cache');
  } catch {
    return null;
  }
}

/** First-8-hex sha256 of the input — cache-file names never carry raw
 *  paths (spaces, unicode, length) or session ids. */
export function cacheKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/** Parse one cache record; undefined on missing/corrupt/wrong-shape. */
export function readCacheFile(file: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Files older than this under the cache prefixes get swept on write —
 *  session-keyed records must not accumulate. Best-effort. */
const CACHE_SWEEP_MS = 24 * 60 * 60 * 1000;

/** Atomic write (tmp + rename — the snapshot contract: a reader mid-
 *  write sees the old record or none, never a torn one) plus the
 *  opportunistic same-prefix sweep. Records carry full config/guard
 *  payloads, so the write is owner-only (0600 via the private-files
 *  contract — a planted permissive tmp gets repaired, not inherited).
 *  Never throws. */
export function writeCacheFile(file: string, record: object, prefix: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writePrivateFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
    const dir = dirname(file);
    const cutoff = Date.now() - CACHE_SWEEP_MS;
    for (const f of readdirSync(dir)) {
      try {
        if (f.startsWith(prefix) && statSync(join(dir, f)).mtimeMs < cutoff) {
          rmSync(join(dir, f), { force: true });
        }
      } catch {
        // sweep is best-effort
      }
    }
  } catch {
    // caching is best-effort — a failed write degrades to recompute
  }
}

/** Snapshot one path — statSync only when it exists (missing is the
 *  common case and stays one syscall). */
export function statProbe(path: string): FileProbe {
  try {
    const st = statSync(path);
    return { path, exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { path, exists: false };
  }
}

/** Every recorded probe still holds? A flipped existence bit or a
 *  changed mtime/size anywhere misses. A recorded-exists path missing
 *  its stats is doubt → stale (fail-safe toward rescan). */
export function probesHold(probes: readonly FileProbe[]): boolean {
  for (const p of probes) {
    if (typeof p.path !== 'string' || typeof p.exists !== 'boolean') {
      return false;
    }
    const now = statProbe(p.path);
    if (now.exists !== p.exists) {
      return false;
    }
    if (now.exists && (now.mtimeMs !== p.mtimeMs || now.size !== p.size)) {
      return false;
    }
  }
  return true;
}

/** Deep JSON-data check — a record that can't round-trip (functions,
 *  symbols, cycles, undefined-in-object, non-finite numbers, sparse
 *  arrays) must not be written: the read side would silently see
 *  different values than the live scan. */
export function isJsonData(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') {
    return true;
  }
  // NaN and ±Infinity serialize as null — only finite numbers round-trip
  if (typeof v === 'number') {
    return Number.isFinite(v);
  }
  if (depth > 32) {
    return false;
  }
  if (Array.isArray(v)) {
    // every() skips holes — JSON.stringify writes them as null, and it
    // drops non-index own keys too; a key count short of/over length
    // is either, so refuse before recursing
    return Object.keys(v).length === v.length && v.every(item => isJsonData(item, depth + 1));
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
    return Object.values(v as Record<string, unknown>).every(item => isJsonData(item, depth + 1));
  }
  return false;
}

/** Resolve + hash pair used by the per-repo caches — the record's `dir`
 *  check and the filename share it so a same-named worktree can never
 *  read a sibling's record. */
export function resolvedDirHash(dir: string): { dir: string; hash: string } {
  const d = resolve(dir);
  return { dir: d, hash: cacheKey(d) };
}
