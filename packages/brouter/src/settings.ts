/**
 * A client's settings file — read, merge, write.
 *
 * The write is atomic (tmp + rename): a client reads its settings at
 * startup, and a half-written file would be a broken client, not a
 * degraded one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** `~` is the home directory — a settings path is a machine-local
 *  path, and the operator writes it the way they say it. */
export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** The settings as an object — an absent file reads as empty, a
 *  malformed one is an error (writing over it would destroy the user's
 *  file without saying so). */
function assertSettingsObject(path: string, raw: unknown): asserts raw is Record<string, unknown> {
  if (typeof raw !== 'object') {
    throw new Error(`${path} is not a settings object — fix it by hand`);
  }
  if (raw === null) {
    throw new Error(`${path} is not a settings object — fix it by hand`);
  }
  if (Array.isArray(raw)) {
    throw new Error(`${path} is not a settings object — fix it by hand`);
  }
}

export function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON — fix it by hand (${String(err)})`);
  }
  assertSettingsObject(path, raw);
  return raw;
}

/** Write the settings atomically — the client never reads a torn file. */
export function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}
