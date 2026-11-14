/**
 * The waste-guard — deterministic tool-call discipline at the pre-tool
 * seam (spec bro-rw8z3). LLM request count is driven by call PATTERNS:
 * identical re-reads, verify re-runs on an unchanged tree, one-call-per-
 * turn reads. Both guards here cost zero model calls and fail OPEN —
 * a hook must never stall the client.
 *
 * `wasteGuardBlock` runs at pre-tool and only READS state; markers
 * commit at post-tool via `wasteGuardRecord` — a call denied by a
 * connector veto or a refused permission never reaches that event, so
 * a marker only ever stands for a call that actually ran.
 *
 * State is per-session marker files under `<git-common>/bro/hooks/`
 * (`<session>.waste-*`), the same shape the armed-gate aspects use.
 * `BRO_WASTE_GUARD=0` disables both guards (the arena baseline leg).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_SYNC_PROBE_TIMEOUT_MS, gitCommonDir, gitTry } from '@broject/core';

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

/** Untracked files at or under this size are content-hashed into the
 *  tree fingerprint; larger ones contribute mtime+size instead. */
const UNTRACKED_CONTENT_CAP = 256 * 1024;

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

/** One untracked entry's contribution to the fingerprint — a content
 *  hash when the file is small enough to read cheaply, its mtime+size
 *  when it is not, the bare name when even a stat fails. An edit to an
 *  untracked file must move the fingerprint: porcelain reports `??`
 *  entries by name alone and `git diff HEAD` never sees them. */
function untrackedDigest(dir: string, rel: string): string {
  try {
    const st = statSync(join(dir, rel));
    if (!st.isFile()) {
      return `${rel}:dir`;
    }
    if (st.size <= UNTRACKED_CONTENT_CAP) {
      const content = createHash('sha256')
        .update(readFileSync(join(dir, rel)))
        .digest('hex');
      return `${rel}:${content.slice(0, 16)}`;
    }
    return `${rel}:${st.mtimeMs}:${st.size}`;
  } catch {
    // raced mid-scan — the name still distinguishes the set
    return `${rel}:gone`;
  }
}

/** Content-level tree fingerprint: HEAD, the porcelain name set
 *  (untracked files folded in individually), staged+unstaged diff vs
 *  HEAD. Same fingerprint ⇒ same code under test ⇒ same verify outcome
 *  ⇒ the re-run is waste. `git -C` pins the repo so an inherited
 *  GIT_DIR/GIT_WORK_TREE cannot retarget the probes at whatever spawned
 *  the hook. */
function treeFingerprint(dir: string): string | null {
  const git = (args: string[]): string | null => {
    const r = gitTry(['-C', dir, ...args], GIT_SYNC_PROBE_TIMEOUT_MS);
    return r.code === 0 ? r.out : null;
  };
  const status = git(['status', '--porcelain=v1', '-uall', '-z']);
  if (status === null) {
    return null;
  }
  // HEAD anchors the fingerprint — a commit or branch switch on a clean
  // tree changes the code under test without touching status or diff
  const head = git(['rev-parse', '--verify', 'HEAD'])?.trim() ?? '';
  // an unborn HEAD cannot diff — porcelain names are the whole tree
  // then; a live HEAD with a failing diff is a probe failure, not an
  // empty diff → fail open
  const diff = head === '' ? '' : git(['diff', 'HEAD']);
  if (diff === null) {
    return null;
  }
  const h = createHash('sha256');
  h.update(head);
  h.update('\0');
  h.update(status);
  h.update('\0');
  h.update(diff);
  for (const e of status.split('\0')) {
    if (e.startsWith('?? ')) {
      h.update(untrackedDigest(dir, e.slice(3)));
    }
  }
  return h.digest('hex').slice(0, 24);
}

function commandOf(input: Record<string, unknown>): string {
  const c = input.command;
  return typeof c === 'string' ? c : '';
}

/** The resolved marker scope both hook legs share — the state dir plus
 *  the fs-safe session key, or null when the guard is off, sessionless,
 *  or outside a git repo (fail-open). */
interface GuardScope {
  sd: string;
  session: string;
}

function guardScope(dir: string, sessionId: string): GuardScope | null {
  if (!enabled() || sessionId === '') {
    return null;
  }
  const sd = stateDir(dir);
  if (sd === null) {
    return null;
  }
  return { sd, session: safeSession(sessionId) };
}

/** The block reason for a wasteful call, or undefined to let it run.
 *  `dir` is the hook's project root; `sessionId` scopes the markers.
 *  This is the pre-tool leg: it only READS markers — the commit lands
 *  at post-tool in `wasteGuardRecord`, so a vetoed call leaves no
 *  state behind. */
export function wasteGuardBlock(
  dir: string,
  sessionId: string,
  tool: string,
  input: Record<string, unknown>
): string | undefined {
  const scope = guardScope(dir, sessionId);
  if (scope === null) {
    return undefined;
  }
  return verifyGateBlock(dir, scope, input) ?? dupReadBlock(dir, scope, tool, input);
}

/** The post-tool leg — commit the markers a pre-tool admit deferred.
 *  A call that never executed (denied pre-tool, connector veto,
 *  refused prompt) never reaches here, so no marker can shadow its
 *  retry. `outcome` is the host's `tool_response.success`; a
 *  proven-failed inspection call leaves no dup marker (there is no
 *  result to reuse), while a verify run marks on any outcome — an
 *  attempted verify at this tree state is spent either way. */
export function wasteGuardRecord(
  dir: string,
  sessionId: string,
  tool: string,
  input: Record<string, unknown>,
  outcome: unknown
): void {
  const scope = guardScope(dir, sessionId);
  if (scope === null) {
    return;
  }
  verifyGateRecord(dir, scope, input);
  dupReadRecord(dir, scope, tool, input, outcome);
}

/** verify-gate — a test/build command re-run on an unchanged tree: same
 *  fingerprint ⇒ same outcome, so the re-run is waste. */
function verifyGateBlock(
  dir: string,
  scope: GuardScope,
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
  const p = join(scope.sd, `${scope.session}.waste-tree`);
  try {
    if (existsSync(p) && readFileSync(p, 'utf8').trim() === fp) {
      return 'waste-guard: tree unchanged since the last verify — edit first or pass BRO_WASTE_GUARD=0';
    }
  } catch {
    // unreadable marker → treat as first run
  }
  return undefined;
}

function verifyGateRecord(dir: string, scope: GuardScope, input: Record<string, unknown>): void {
  const cmd = commandOf(input).replace(ENV_PREFIX_RE, '');
  if (cmd === '' || !VERIFY_CMD_RE.test(cmd)) {
    return;
  }
  const fp = treeFingerprint(dir);
  if (fp === null) {
    return;
  }
  touch(scope.sd, scope.session, 'waste-tree', fp);
}

/** dup-read — an identical inspection call that already ran this
 *  session on the same tree returns identical output, so the repeat is
 *  pure waste. The fingerprint in the aspect is what an edit defeats:
 *  after the tree moves, the same call is a NEW question and re-arms. */
function dupAspect(fp: string, tool: string, input: Record<string, unknown>): string {
  return `waste-dup-${fp}-${callHash(tool, input)}`;
}

function dupReadBlock(
  dir: string,
  scope: GuardScope,
  tool: string,
  input: Record<string, unknown>
): string | undefined {
  if (!READ_TOOL_RE.test(tool) || readIdentity(input) === undefined) {
    return undefined;
  }
  const fp = treeFingerprint(dir);
  if (fp === null) {
    return undefined;
  }
  if (markerExists(scope.sd, scope.session, dupAspect(fp, tool, input))) {
    return `waste-guard: identical ${tool} call already ran this session — reuse the earlier result`;
  }
  return undefined;
}

function dupReadRecord(
  dir: string,
  scope: GuardScope,
  tool: string,
  input: Record<string, unknown>,
  outcome: unknown
): void {
  if (!READ_TOOL_RE.test(tool) || readIdentity(input) === undefined || outcome === false) {
    return;
  }
  const fp = treeFingerprint(dir);
  if (fp === null) {
    return;
  }
  touch(scope.sd, scope.session, dupAspect(fp, tool, input));
}

/** Test seam — the marker prefix a session's waste state lives under. */
export function wasteGuardPrefix(sessionId: string): string {
  return `${safeSession(sessionId)}.waste-`;
}

/** Test seam — list a session's waste marker aspects (dup hashes +
 *  tree slot), for assertions and future pruning. Marker files are
 *  named `${session}.${aspect}` and the aspect itself starts with
 *  `waste-`, so the return value keeps that prefix (`waste-tree`,
 *  `waste-dup-<fp>-<hash>`). */
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
