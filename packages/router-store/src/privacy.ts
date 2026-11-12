/**
 * The store's privacy contract (spec bro-0ykhg.4).
 *
 * The state directory is owner-only (0700); the database and its
 * SQLite WAL/SHM sidecars are owner-readable/writable (0600). The
 * rules apply to NEW and EXISTING stores alike — an old store with
 * loose permissions is tightened on open, and a filesystem that cannot
 * honor the mode fails with an actionable error, never silently.
 *
 * The reporter credential lives beside the database as a 0600 file:
 * the verified write path proves itself with it, and workers — run
 * under an isolated identity/filesystem boundary per the spec — never
 * see it. Same-UID unrestricted workers are NOT a security boundary;
 * the spec says so itself.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** The directory mode — owner rwx, nobody else. */
const DIR_MODE = 0o700;
/** The file mode — owner rw, nobody else. */
const FILE_MODE = 0o600;

/** The sidecar suffixes SQLite WAL mode creates beside the database. */
const SIDECARS = ['-wal', '-shm', '-journal'] as const;

/** chmod that reports failure instead of throwing — callers decide
 *  whether a mode the filesystem refused is fatal. */
function tryChmod(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Enforce the privacy contract on the store at `dbPath`: the state
 *  directory 0700, the database and any WAL/SHM sidecars 0600. Existing
 *  stores are tightened in place; a chmod the filesystem refuses is an
 *  actionable error naming the path and the mode it needs. */
export function ensureStorePrivacy(dbPath: string): string | undefined {
  const dir = dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    return `the router state directory ${dir} could not be created — ${errMsg(err)}`;
  }
  if (!tryChmod(dir, DIR_MODE)) {
    return (
      `the router state directory ${dir} is not owner-only (needs mode 0700) ` +
      'and could not be tightened — fix its permissions or point the store elsewhere'
    );
  }
  const targets = [dbPath, ...SIDECARS.map(s => `${dbPath}${s}`)];
  for (const path of targets) {
    if (!existsSync(path)) {
      continue;
    }
    const mode = statSync(path).mode & 0o777;
    if (mode === FILE_MODE) {
      continue;
    }
    if (!tryChmod(path, FILE_MODE)) {
      return (
        `the router store ${path} is not owner-only (needs mode 0600, found ` +
        `${mode.toString(8)}) and could not be tightened — fix its permissions ` +
        'or recreate the store'
      );
    }
  }
  return undefined;
}

/** Re-assert the file modes after writes — WAL sidecars appear on the
 *  first write inside a session, after the open-time pass already ran.
 *  Best-effort: the directory's 0700 is the boundary that matters. */
export function tightenStoreFiles(dbPath: string): void {
  for (const path of [dbPath, ...SIDECARS.map(s => `${dbPath}${s}`)]) {
    if (existsSync(path)) {
      tryChmod(path, FILE_MODE);
    }
  }
}

/** The reporter credential's path — beside the database, never inside
 *  it: a credential in the store would ride every backup and export. */
export function reporterTokenPath(dbPath: string): string {
  return join(dirname(dbPath), 'reporter-token');
}

/** The reporter credential — created on first need (0600, random),
 *  stable afterwards. undefined when the file exists but cannot be
 *  read or written — the caller reports verified=0 rather than guess. */
export function ensureReporterToken(dbPath: string): string | undefined {
  const path = reporterTokenPath(dbPath);
  try {
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf8').trim();
      return token === '' ? undefined : token;
    }
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, `${token}\n`, { mode: FILE_MODE });
    tryChmod(path, FILE_MODE);
    return token;
  } catch {
    return undefined;
  }
}

/** The credential a reporter presents — read-only; never creates. */
export function readReporterToken(dbPath: string): string | undefined {
  try {
    const token = readFileSync(reporterTokenPath(dbPath), 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer|secret|password|passwd|credential|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\b(?:sk|pk|xox[baprs]|ghp|gho|ghu|ghs|ghr|glpat|npm|hf)_[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\b(?=.{0,40}(?:token|secret|key))/gi,
];

/** Redact secret-looking material before persistence — task text is
 *  operator prose and must never carry a credential into the store.
 *  Conservative on purpose: a false positive costs a word, a false
 *  negative costs a credential. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, match => {
      const eq = match.indexOf('=');
      const colon = match.indexOf(':');
      const at = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
      if (at >= 0) {
        return `${match.slice(0, at + 1)} [redacted]`;
      }
      return '[redacted]';
    });
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
