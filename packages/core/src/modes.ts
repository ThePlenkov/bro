/**
 * Session modes — the per-(host, nativeSessionId) behavior switch from
 * the fleet epic (specs/sessions/bro-izpyk.md, impl
 * specs/bro-izpyk.2.md). `observe` is the implicit default: a missing
 * or unreadable mode file resolves to it, and it never creates a file
 * unless the operator (`bro mode`) or `modes.default` wrote one.
 *
 * Mode files are the hook-time truth — `hooks/run.sh` reads them before
 * deciding whether a session event may skip Node entirely, and
 * hooks.js resolves the same file for connector `activeIn` gating and
 * Tier-1 snapshot consumption. The ledger's `sessions.mode` column is a
 * projection written through `LedgerFacade.setMode`; `bro sessions`
 * overlays live mode files so the display is always honest.
 *
 * Layout under the machine state dir (`$XDG_STATE_HOME/bro`,
 * `~/.local/state/bro` fallback):
 *
 *   sessions/<host>-<sid>.mode     line 1 = mode; line 2 = project id
 *   snapshots/<project>/<mode>/<event>.txt   Tier-1 rehydrate snapshots
 *   inbox/<host>-<sid>             F4 mailbox drop (run.sh wakes on it)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMode, MODES, type Mode } from './ledger.ts';

// --- state dir -----------------------------------------------------------------

/** `$XDG_STATE_HOME/bro` (`~/.local/state/bro` fallback) — the machine
 *  state dir every fleet surface shares. null only when neither XDG nor
 *  HOME resolves (the OS-home case the shell cannot mirror — Node
 *  callers pass process.env and get homedir()'s answer instead). */
export function broStateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const xdg = env.XDG_STATE_HOME;
  if (typeof xdg === 'string' && xdg !== '') {
    return join(xdg, 'bro');
  }
  const home = env.HOME || homedir();
  return home === '' ? null : join(home, '.local', 'state', 'bro');
}

// --- safe names ----------------------------------------------------------------

/** Session ids and hosts land in filenames — fold every byte outside
 *  `[A-Za-z0-9_.-]` to `_`, the same rule the hook spool and marker
 *  paths use, so a hostile id cannot escape the directory or collide
 *  with a sibling's name. */
export function safeSessionFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** `<host>-<sid>` with both halves sanitized — the sessions/, inbox/
 *  naming contract. Host values never contain `-` (claude|codex|cursor|
 *  devin|unknown), so listModeFiles can split on the FIRST dash. */
export function sessionFileStem(host: string, sid: string): string {
  return `${safeSessionFilePart(host)}-${safeSessionFilePart(sid)}`;
}

// --- mode files ------------------------------------------------------------------

/** `sessions/<host>-<sid>.mode` — null when no state dir resolves. */
export function modeFilePath(env: NodeJS.ProcessEnv, host: string, sid: string): string | null {
  const dir = broStateDir(env);
  if (dir === null || sid === '') {
    return null;
  }
  return join(dir, 'sessions', `${sessionFileStem(host, sid)}.mode`);
}

export function modeSessionsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = broStateDir(env);
  return dir === null ? null : join(dir, 'sessions');
}

/** Line 1 of a mode file, trimmed — the only field readers honor.
 *  `undefined` = absent, unreadable, or invalid (all resolve observe;
 *  callers distinguish presence via existsSync when it matters). */
export function readModeFile(path: string): Mode | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return isMode(line) ? line : undefined;
}

/** Atomic mode-file write — tmp+rename so a concurrent hook never reads
 *  a torn file. Line 2 carries the project id for humans/debugging;
 *  readers ignore everything past line 1. */
export function writeModeFile(path: string, mode: Mode, project?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = project === undefined || project === '' ? `${mode}\n` : `${mode}\n${project}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export function removeModeFile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    // removal failure is reported, not hidden — a stuck file keeps its
    // old mode and the caller must not claim it cleared
    return false;
  }
}

export interface ModeFileEntry {
  host: string;
  sid: string;
  mode: Mode | undefined;
  /** Raw first line when it failed isMode — surfaced for `bro mode list`
   *  so a corrupt file reads as corrupt, not silently observe. */
  raw?: string;
  path: string;
  mtimeMs: number;
}

/** Every `*.mode` file under sessions/ — corrupt entries are kept with
 *  `mode: undefined` so list surfaces can show them. */
export function listModeFiles(env: NodeJS.ProcessEnv = process.env): ModeFileEntry[] {
  const dir = modeSessionsDir(env);
  if (dir === null || !existsSync(dir)) {
    return [];
  }
  const out: ModeFileEntry[] = [];
  let names: string[];
  try {
    names = readdirSyncSafe(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.mode')) {
      continue;
    }
    const stem = name.slice(0, -'.mode'.length);
    const dash = stem.indexOf('-');
    if (dash <= 0) {
      continue;
    }
    const path = join(dir, name);
    const mode = readModeFile(path);
    let raw: string | undefined;
    if (mode === undefined) {
      try {
        raw = readFileSync(path, 'utf8').split('\n', 1)[0]?.trim();
      } catch {
        raw = undefined;
      }
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSyncSafe(path);
    } catch {
      // unreadable stat — mtime 0 sorts oldest, still listed
    }
    out.push({ host: stem.slice(0, dash), sid: stem.slice(dash + 1), mode, raw, path, mtimeMs });
  }
  return out;
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}
function statSyncSafe(path: string): number {
  return statSync(path).mtimeMs;
}

// --- host + session identity -----------------------------------------------------

/** Env vars carrying a session id, in resolution order — the same list
 *  goal.ts and the hook spool recognize. First non-empty wins. */
export const SESSION_ENV_VARS = [
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const;

/** Session id from the process env — CLI `bro mode` resolution. */
export function sessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of SESSION_ENV_VARS) {
    const v = env[key];
    if (typeof v === 'string' && v.trim() !== '') {
      return v;
    }
  }
  return undefined;
}

/** Host detection — an EXACT mirror of hooks/run.sh's HOOK_SPOOL_HOST
 *  block: env markers first (the *_PLUGIN_ROOT vars each client exports,
 *  then *_PROJECT_DIR corroboration, then bare PLUGIN_ROOT = codex),
 *  payload fingerprint only when env detection found nothing. run.sh
 *  decides the observe fast-path on this answer and hooks.js resolves
 *  the mode file under the same name — the two must never disagree. */
export function hookHostOf(env: NodeJS.ProcessEnv, raw?: unknown): string {
  if (env.CURSOR_PLUGIN_ROOT) {
    return 'cursor';
  }
  if (env.DEVIN_PLUGIN_ROOT) {
    return 'devin';
  }
  if (env.CLAUDE_PLUGIN_ROOT) {
    return 'claude';
  }
  if (env.CURSOR_PROJECT_DIR) {
    return 'cursor';
  }
  if (env.DEVIN_PROJECT_DIR) {
    return 'devin';
  }
  if (env.PLUGIN_ROOT) {
    return 'codex';
  }
  if (raw !== undefined && raw !== null) {
    // run.sh greps the raw payload text for the literal key strings —
    // stringify is the same substring test, false positives included
    const s = JSON.stringify(raw);
    if (s.includes('"cursor_version"') || s.includes('"workspace_roots"')) {
      return 'cursor';
    }
    if (s.includes('"turn_id"')) {
      return 'codex';
    }
  }
  return 'unknown';
}

// --- resolution ------------------------------------------------------------------

export type ModeSource = 'file' | 'default' | 'observe';

export interface SessionModeResolution {
  mode: Mode;
  source: ModeSource;
  /** Mode file path when host+sid resolve one (even when absent — the
   *  materialization target). null for sid-less sessions. */
  file: string | null;
  /** Set when the file is absent AND `modes.default` resolved a mode —
   *  the caller should write it so the Tier-0 check stays cheap. */
  materialize?: Mode;
}

/** file > `modes.default` > `observe`. A present-but-invalid file pins
 *  `observe` (source 'file') — a torn write self-heals on the next
 *  explicit `bro mode` set, and fail-open never activates behavior the
 *  operator didn't ask for. */
export function sessionMode(opts: {
  env?: NodeJS.ProcessEnv;
  host: string;
  sid: string;
  defaultMode?: Mode;
}): SessionModeResolution {
  const env = opts.env ?? process.env;
  const file = modeFilePath(env, opts.host, opts.sid);
  if (file !== null && existsSync(file)) {
    const mode = readModeFile(file);
    if (mode !== undefined) {
      return { mode, source: 'file', file };
    }
    return { mode: 'observe', source: 'file', file };
  }
  if (opts.defaultMode !== undefined && isMode(opts.defaultMode)) {
    return {
      mode: opts.defaultMode,
      source: 'default',
      file,
      materialize: opts.sid === '' ? undefined : opts.defaultMode,
    };
  }
  return { mode: 'observe', source: 'observe', file };
}

// --- `bro mode <name>` command binding -------------------------------------------

/** Shell-command rejection set — the same metacharacters
 *  isSelfToolCommand refuses: a chained/piped/redirected command is not
 *  a bare `bro mode` invocation. */
const MODE_CMD_FORBIDDEN = /[;&|`$()<>\n\\]/;

/** First positional token after `bro mode` that is not a flag — the
 *  mode name. `--session`/`--host` ANYWHERE veto the auto-bind (explicit
 *  targeting means the CLI already wrote the file itself — scanning
 *  must precede the mode match or `bro mode code --session s1` would
 *  bind the calling session too). Flags that take a value are skipped
 *  with their value; unknown flags are doubt → no bind. */
function modeCommandTarget(rest: string): string | null {
  const tokens = rest
    .trim()
    .split(/\s+/)
    .filter(t => t !== '');
  // pass 1 — explicit targeting vetoes regardless of position
  for (const t of tokens) {
    if (
      t === '--session' ||
      t === '--host' ||
      t.startsWith('--session=') ||
      t.startsWith('--host=')
    ) {
      return null;
    }
  }
  // pass 2 — collect non-flag positionals; exactly one is the mode
  // name (a second positional is malformed usage — doubt = no bind)
  const pos: string[] = [];
  for (const t of tokens) {
    // --json is a harmless output modifier; --help/-h are NOT ignored —
    // the CLI prints help and sets nothing, so binding here would pin a
    // mode the user never applied. They fall through to the unknown-
    // flag veto below (doubt = no bind).
    if (t === '--json') {
      continue;
    }
    if (t.startsWith('-')) {
      // unknown flag — could be a value-taking one; doubt = no bind
      return null;
    }
    pos.push(t);
  }
  return pos.length === 1 ? pos[0]! : null;
}

/** `-p`/`--package` in every spelling npx accepts — the package-set
 *  selector means `bro` in the argv is not necessarily what runs.
 *  Mirrors the cli's isSelfToolCommand constants (kept local: core
 *  cannot import the command layer). */
const MODE_NPX_PACKAGE_RE = /^(?:-p|--package)(?:=|$)/;

/** Flags that take no value and change nothing about what runs —
 *  the only flags allowed between `npx` and its executable. */
const MODE_NO_VALUE_NPX_FLAGS = new Set(['-y', '--yes', '--no-install', '-q', '--quiet']);

/** The index of the executable npx will run within `tokens` (the argv
 *  AFTER `npx`), or -1 — same contract as the cli's npxExecutable: a
 *  package override vetoes, and the first token that is not a known
 *  no-value flag must be the executable (a flag in its place can
 *  rename the run). Tokenized, not regex — the `npx [flags]* bro`
 *  shape is ReDoS-prone (js/redos). */
function modeNpxExecIndex(tokens: string[]): number {
  if (tokens.some(t => MODE_NPX_PACKAGE_RE.test(t))) {
    return -1;
  }
  const i = tokens.findIndex(t => !MODE_NO_VALUE_NPX_FLAGS.has(t));
  return i >= 0 && !tokens[i]!.startsWith('-') ? i : -1;
}

/** A shell command that IS a `bro mode <name>` invocation → the mode it
 *  sets ('off' → 'observe'), or null. The post-tool hook binds this to
 *  the calling session — the CLI can't always see session env from an
 *  agent shell, so the hook event carries the identity instead. */
export function parseModeCommand(cmd: string): Mode | null {
  if (MODE_CMD_FORBIDDEN.test(cmd)) {
    return null;
  }
  // `bro mode …` or `npx [no-value flags] [@broject/]bro[@ver] mode …` at
  // command start — the two spellings isSelfToolCommand accepts, parsed
  // as tokens so no quantified regex group can backtrack exponentially.
  const tokens = cmd
    .trim()
    .split(/\s+/)
    .filter(t => t !== '');
  if (tokens.length === 0) {
    return null;
  }
  const head = tokens[0]!.toLowerCase();
  let rest: string[];
  if (head === 'bro') {
    rest = tokens.slice(1);
  } else if (head === 'npx') {
    const afterNpx = tokens.slice(1);
    const execIdx = modeNpxExecIndex(afterNpx);
    const exec = execIdx >= 0 ? afterNpx[execIdx] : undefined;
    // the version/tag charset excludes ':' — npm protocol aliases
    // (`bro@npm:other`, `bro@github:u/r`) are NOT the self tool and must
    // never bind a mode (same grammar as isSelfToolCommand)
    if (exec === undefined || !/^(?:@broject\/)?bro(?:@[\w.-]+)?$/i.test(exec)) {
      return null;
    }
    rest = afterNpx.slice(execIdx + 1);
  } else {
    return null;
  }
  if (rest.length === 0 || rest[0]!.toLowerCase() !== 'mode') {
    return null;
  }
  const target = modeCommandTarget(rest.slice(1).join(' '));
  if (target === null) {
    return null;
  }
  if (target === 'off') {
    return 'observe';
  }
  return isMode(target) ? target : null;
}

// --- Tier-1 snapshots -------------------------------------------------------------

/** Rehydrate events that share the sessionStart probe set — the
 *  snapshot renders once per (project, mode) and all three event files
 *  carry the same content. prompt-submit/post-tool/stop are deliberately
 *  absent: their context is per-event dynamic and cannot pre-render. */
export const MODE_SNAPSHOT_EVENTS = ['session-start', 'post-compaction', 'pre-compact'] as const;
export type ModeSnapshotEvent = (typeof MODE_SNAPSHOT_EVENTS)[number];

/** Freshness anchor TTL — a snapshot older than this re-renders on the
 *  next miss. 5min matches the collected-guards cache cadence: repo
 *  state (ready queue, PR gate) moves faster than that only matters
 *  marginally, and the live path still answers when stale. */
export const MODE_SNAPSHOT_TTL_MS = 5 * 60_000;

function snapshotsRoot(env: NodeJS.ProcessEnv): string | null {
  const dir = broStateDir(env);
  return dir === null ? null : join(dir, 'snapshots');
}

/** `snapshots/<project>/<mode>/` — project ids are hex hashes and modes
 *  are the closed MODES vocabulary, but both are validated before they
 *  touch a path (a hand-edited caller must not escape the root). */
export function snapshotModeDir(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode
): string | null {
  const root = snapshotsRoot(env);
  if (root === null || !/^[A-Za-z0-9_-]+$/.test(project) || !isMode(mode)) {
    return null;
  }
  return join(root, project, mode);
}

export function snapshotEventPath(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode,
  event: ModeSnapshotEvent
): string | null {
  const dir = snapshotModeDir(env, project, mode);
  return dir === null ? null : join(dir, `${event}.txt`);
}

export function snapshotStampPath(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode
): string | null {
  const dir = snapshotModeDir(env, project, mode);
  return dir === null ? null : join(dir, '.stamp');
}

/** A snapshot answers only while its stamp is younger than the TTL —
 *  the stamp (not per-file mtimes) is the anchor so a partially-written
 *  render never passes as fresh. */
export function snapshotFresh(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode,
  now: number = Date.now()
): boolean {
  const stamp = snapshotStampPath(env, project, mode);
  if (stamp === null) {
    return false;
  }
  try {
    return now - statSync(stamp).mtimeMs < MODE_SNAPSHOT_TTL_MS;
  } catch {
    return false;
  }
}

/** The snapshot's additionalContext text for one event — undefined on
 *  miss, stale stamp, or an unreadable file. An EMPTY string is a valid
 *  answer ("rendered, nothing to say") and returns ''. */
export function readModeSnapshot(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode,
  event: ModeSnapshotEvent
): string | undefined {
  if (!snapshotFresh(env, project, mode)) {
    return undefined;
  }
  const path = snapshotEventPath(env, project, mode, event);
  if (path === null) {
    return undefined;
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Write one event's snapshot + refresh the stamp — the renderer calls
 *  this per event then stamps once at the end. */
export function writeModeSnapshot(
  env: NodeJS.ProcessEnv,
  project: string,
  mode: Mode,
  event: ModeSnapshotEvent,
  text: string
): boolean {
  const path = snapshotEventPath(env, project, mode, event);
  if (path === null) {
    return false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export function touchSnapshotStamp(env: NodeJS.ProcessEnv, project: string, mode: Mode): void {
  const stamp = snapshotStampPath(env, project, mode);
  if (stamp === null) {
    return;
  }
  try {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, `${Date.now()}\n`);
  } catch {
    // stamp is best-effort — a missing stamp just reads stale
  }
}

// --- inbox (F4 forward-compat — run.sh's Tier-0 wake reads the same path) -----

/** `inbox/<host>-<sid>` — the F4 per-session drop file. F2 only needs
 *  the path contract: run.sh's `[ -s ]` check wakes Node when it is
 *  non-empty; delivery itself lands with bro-izpyk.4. */
export function inboxPath(env: NodeJS.ProcessEnv, host: string, sid: string): string | null {
  const dir = broStateDir(env);
  if (dir === null || sid === '') {
    return null;
  }
  return join(dir, 'inbox', sessionFileStem(host, sid));
}

// --- modes vocabulary re-export ----------------------------------------------------

export { isMode, MODES };
export type { Mode };
