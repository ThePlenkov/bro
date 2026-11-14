/**
 * The waste-guard — deterministic tool-call discipline at the pre-tool
 * seam (spec bro-rw8z3). LLM request count is driven by call PATTERNS:
 * identical re-reads, verify re-runs on an unchanged tree, one-call-per-
 * turn reads. Both guards here cost zero model calls and fail OPEN —
 * a hook must never stall the client.
 *
 * State is per-session marker files under `<git-common>/bro/hooks/`
 * (`<session>.waste-*`), the same shape the armed-gate aspects use.
 * `BRO_WASTE_GUARD=0` disables both guards (the arena baseline leg).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir } from '@broject/core';

/** Read-only inspection tools — a repeated identical call returns
 *  identical output, pure waste. Shell commands stay out: a repeated
 *  `git status` is cheap and sometimes intentional. */
const READ_TOOL_RE = /^(read|view|grep|glob|ls|list|cat|find|notebook_read)$/i;
/** Input fields that identify WHAT is being inspected — without one the
 *  call carries no dedup identity. */
const READ_KEY_FIELDS = ['file_path', 'path', 'pattern', 'query', 'glob', 'url'] as const;

/** Verify-shaped commands — the test/build runs the guard budgets. */
const VERIFY_CMD_RE =
  /(?:^|[;&|]\s*)(?:npm\s+(?:run\s+)?(?:test|build|typecheck|check)\b|npx\s+tsc\b|(?:vitest|jest|pytest|py\.test|go\s+test|cargo\s+test|tsx\s+--test|node\s+--test)\b)/;
/** Leading env assignments (`FOO=bar cmd`, `env FOO=bar cmd`) must not
 *  smuggle a verify past the gate — the prefix never reaches the hook's
 *  own env, so honoring it would teach a bypass that does not exist. */
const ENV_PREFIX_RE = /^(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)*/;

function enabled(): boolean {
  return process.env.BRO_WASTE_GUARD !== '0';
}

function stateDir(dir: string): string | null {
  const gd = gitCommonDir(dir, GIT_SYNC_PROBE_TIMEOUT_MS);
  return gd !== null ? join(gd, 'bro', 'hooks') : null;
}

function safeSession(sessionId: string): string {
  return sessionId.replace(/[^\w.-]/g, '_');
}

/** sha256 of the canonical call — tool name plus input with sorted keys
 *  so field order never splits identity. */
function callHash(tool: string, input: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)])
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify({ tool, input: canon(input) }))
    .digest('hex')
    .slice(0, 24);
}

function markerExists(dir: string, session: string, aspect: string): boolean {
  const p = join(dir, `${session}.${aspect}`);
  try {
    return statSync(p).mtimeMs > Date.now() - 7 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function touch(dir: string, session: string, aspect: string, content?: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${session}.${aspect}`), content ?? new Date().toISOString(), {
      flag: 'w',
    });
  } catch {
    // marker write failure must never stall the hook
  }
}

function readIdentity(input: Record<string, unknown>): string | undefined {
  for (const f of READ_KEY_FIELDS) {
    const v = input[f];
    if (typeof v === 'string' && v !== '') {
      return `${f}=${v}`;
    }
  }
  return undefined;
}

/** Content-level tree fingerprint: staged+unstaged diff vs HEAD plus
 *  the porcelain name set (untracked files register by name). Same
 *  fingerprint ⇒ same test outcome ⇒ the re-run is waste. */
function treeFingerprint(dir: string): string | null {
  const git = (args: string[]): string | null => {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      timeout: GIT_SYNC_PROBE_TIMEOUT_MS,
    });
    return r.status === 0 ? r.stdout : null;
  };
  const status = git(['status', '--porcelain']);
  if (status === null) {
    return null;
  }
  const diff = git(['diff', 'HEAD']) ?? '';
  return createHash('sha256')
    .update(status + '\0' + diff)
    .digest('hex')
    .slice(0, 24);
}

function commandOf(input: Record<string, unknown>): string {
  const c = input.command;
  return typeof c === 'string' ? c : '';
}

/** The block reason for a wasteful call, or undefined to let it run.
 *  `dir` is the hook's project root; `sessionId` scopes the markers.
 *  Each guard owns its own veto — the dispatcher only resolves the
 *  shared marker scope and asks them in priority order. */
export function wasteGuardBlock(
  dir: string,
  sessionId: string,
  tool: string,
  input: Record<string, unknown>
): string | undefined {
  if (!enabled() || sessionId === '') {
    return undefined;
  }
  const sd = stateDir(dir);
  if (sd === null) {
    return undefined;
  }
  const session = safeSession(sessionId);
  return verifyGateBlock(dir, sd, session, input) ?? dupReadBlock(sd, session, tool, input);
}

/** verify-gate — a test/build command re-run on an unchanged tree: same
 *  fingerprint ⇒ same outcome, so the re-run is waste. */
function verifyGateBlock(
  dir: string,
  sd: string,
  session: string,
  input: Record<string, unknown>
): string | undefined {
  const cmd = commandOf(input).replace(ENV_PREFIX_RE, '');
  if (cmd === '' || !VERIFY_CMD_RE.test(cmd)) {
    return undefined;
  }
  const fp = treeFingerprint(dir);
  if (fp === null) {
    return undefined;
  }
  const aspect = 'waste-tree';
  const p = join(sd, `${session}.${aspect}`);
  try {
    if (existsSync(p) && readFileSync(p, 'utf8').trim() === fp) {
      return 'waste-guard: tree unchanged since the last verify — edit first or pass BRO_WASTE_GUARD=0';
    }
  } catch {
    // unreadable marker → treat as first run
  }
  touch(sd, session, aspect, fp);
  return undefined;
}

/** dup-read — an identical inspection call already ran this session; the
 *  repeated call returns identical output, so it is pure waste. */
function dupReadBlock(
  sd: string,
  session: string,
  tool: string,
  input: Record<string, unknown>
): string | undefined {
  if (!READ_TOOL_RE.test(tool) || readIdentity(input) === undefined) {
    return undefined;
  }
  const aspect = `waste-dup-${callHash(tool, input)}`;
  if (markerExists(sd, session, aspect)) {
    return `waste-guard: identical ${tool} call already ran this session — reuse the earlier result`;
  }
  touch(sd, session, aspect);
  return undefined;
}

/** Test seam — the marker prefix a session's waste state lives under. */
export function wasteGuardPrefix(sessionId: string): string {
  return `${safeSession(sessionId)}.waste-`;
}

/** Test seam — list a session's waste marker aspects (dup hashes +
 *  tree slot), for assertions and future pruning. Marker files are
 *  named `${session}.${aspect}` and the aspect itself starts with
 *  `waste-`, so the return value keeps that prefix (`waste-tree`,
 *  `waste-dup-<hash>`). */
export function wasteGuardAspects(dir: string, sessionId: string): string[] {
  const sd = stateDir(dir);
  if (sd === null) {
    return [];
  }
  const session = safeSession(sessionId);
  // strip the `${session}.` owner prefix — what remains IS the aspect
  const sessionPrefix = `${session}.`;
  try {
    return readdirSync(sd)
      .filter(f => f.startsWith(wasteGuardPrefix(sessionId)))
      .map(f => f.slice(sessionPrefix.length))
      .sort();
  } catch {
    return [];
  }
}
