/**
 * `bro claim` — session leases on resource URIs (epic spec
 * specs/sessions/bro-izpyk.md "Claims and conflicts"; impl spec
 * specs/bro-izpyk.3.md). The ClaimFacade's user surface:
 *
 *   bro claim <resource> [--ttl <sec>] [--exclusive|--shared]
 *   bro claim release <resource>
 *   bro claim list [--resource <prefix>] [--project] [--session <sid>]
 *
 * Resource shorthands expand against the current dir: `worktree` →
 * `worktree:<cwd>`, `branch` → `branch:<current>`, `pr <n>`/`#<n>` →
 * `pr:<n>`, `path <glob>` → `path:<glob>`, `role <name>` →
 * `role:<name>@<project>`, `task <id>` → `task:<id>`; a token already
 * carrying `scheme:` passes through as the URI.
 *
 * Session resolution matches `bro mode`: --session/--host flags win,
 * else the session env ids + hook host detection. Claims are explicit
 * CLI calls — an unresolvable session is a usage error, not a hook
 * binding (the `bro mode` bind exists because mode-set is typed inside
 * agent shells; claims have --session for that case).
 *
 * `task:*` never touches the claims table — the facade delegates to the
 * tasks store and the bd claim stays the source of truth.
 */
import { execFileSync } from 'node:child_process';
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  hookHostOf,
  loadConfig,
  printUsage,
  sessionIdFromEnv,
  sessionProject,
  type ClaimFacade,
  type ClaimResult,
  type ClaimRow,
  type SessionKey,
} from '@broject/core';
import { flag, positionals } from './args.ts';
import { agentOwner } from './proc-owner.ts';

const USAGE = `usage: bro claim <resource> [--ttl <sec>] [--exclusive|--shared] [--session <sid>] [--host <h>] [--json]
       bro claim release <resource> [--session <sid>] [--host <h>] [--json]
       bro claim list [--resource <prefix>] [--project] [--session <sid>] [--host <h>] [--json]

  resource   worktree | branch | pr <n> | path <glob> | role <name> |
             task <id> | <scheme>:<rest>  (task:* delegates to beads)
  --ttl      lease seconds — default 24h; 0 = no expiry
  --exclusive / --shared   override the resource default (role:* is exclusive)
  list       live claims — --project scopes to this repo's project id`;

export interface ClaimArgs {
  sub: 'claim' | 'release' | 'list';
  /** Raw positionals — `claim worktree` → ['worktree'];
   *  `release worktree` → ['release','worktree']. */
  pos: string[];
  ttlSec?: number;
  exclusive?: boolean;
  project: boolean;
  session?: string;
  host?: string;
  resourcePrefix?: string;
  json: boolean;
}

/** `--ttl` parse — non-negative seconds; 0 means no expiry. */
function parseTtlSec(argv: string[]): number | undefined {
  const ttlRaw = flag(argv, '--ttl');
  if (ttlRaw === undefined) {
    return undefined;
  }
  const ttlSec = Number(ttlRaw);
  if (!Number.isFinite(ttlSec) || ttlSec < 0) {
    throw new CommandError(
      `error: --ttl must be a non-negative number of seconds\n${USAGE}`,
      EXIT.usage
    );
  }
  return ttlSec;
}

/** A `--name <value>` flag that must not be blank. */
function nonEmptyFlag(argv: string[], name: string): string | undefined {
  const v = flag(argv, name);
  if (v !== undefined && v.trim() === '') {
    throw new CommandError(`error: ${name} requires a non-empty value`, EXIT.usage);
  }
  return v;
}

/** Parsed `bro claim` argv — strict positionals; the first positional
 *  is the subcommand (release|list) or the resource itself. Three
 *  positionals cover `release task bro-1` — the sub plus a two-word
 *  shorthand; a fourth is always a stray. */
export function claimArgs(argv: string[]): ClaimArgs {
  const rest = positionals(argv, new Set(['--session', '--host', '--ttl', '--resource']), {
    boolFlags: new Set(['--json', '--project', '--exclusive', '--shared']),
    strict: true,
  });
  if (rest.length > 3) {
    throw new CommandError(`error: unexpected argument "${rest[3]}"\n${USAGE}`, EXIT.usage);
  }
  const first = rest[0];
  const sub =
    first === 'release' || first === 'list' ? first : first === undefined ? 'list' : 'claim';
  const ttlSec = parseTtlSec(argv);
  if (argv.includes('--exclusive') && argv.includes('--shared')) {
    throw new CommandError('error: --exclusive and --shared are mutually exclusive', EXIT.usage);
  }
  const session = nonEmptyFlag(argv, '--session');
  const host = nonEmptyFlag(argv, '--host');
  const resourcePrefix = flag(argv, '--resource');
  return {
    sub,
    pos: rest,
    ...(ttlSec !== undefined ? { ttlSec } : {}),
    ...(argv.includes('--exclusive')
      ? { exclusive: true }
      : argv.includes('--shared')
        ? { exclusive: false }
        : {}),
    project: argv.includes('--project'),
    ...(session !== undefined ? { session } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(resourcePrefix !== undefined && resourcePrefix !== '' ? { resourcePrefix } : {}),
    json: argv.includes('--json'),
  };
}

export interface ClaimDeps {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  claims?: ClaimFacade;
  now?: number;
}

interface ResolvedSession {
  host: string;
  sid: string;
  ok: boolean;
}

function resolveSession(
  args: Pick<ClaimArgs, 'session' | 'host'>,
  env: NodeJS.ProcessEnv
): ResolvedSession {
  const sid = args.session ?? sessionIdFromEnv(env);
  if (sid === undefined || sid.trim() === '') {
    return { host: args.host ?? hookHostOf(env), sid: '', ok: false };
  }
  return { host: args.host ?? hookHostOf(env), sid: sid.trim(), ok: true };
}

function claimsFacadeFor(dir: string, deps: ClaimDeps): ClaimFacade {
  if (deps.claims !== undefined) {
    return deps.claims;
  }
  // core loadConfig, not plugins.ts's loadBroConfig — plugins.ts imports
  // this module for the command registry; the cycle would TDZ.
  const prefer = loadConfig(dir).connectors;
  return facade('claims', { dir }, prefer === undefined ? {} : { prefer });
}

function currentBranch(dir: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' || out === 'HEAD' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** `branch` shorthand — the checked-out branch name, or a usage
 *  error when HEAD is detached/unresolvable. */
function branchResource(dir: string): string {
  const b = currentBranch(dir);
  if (b === undefined) {
    throw new CommandError('error: no current branch — pass branch:<name>', EXIT.usage);
  }
  return `branch:${b}`;
}

/** Bare (scheme-less) single-word resources — `worktree`/`branch`
 *  resolve against dir; the value-needing heads throw their usage
 *  errors here too (defensive — expandResourceWords intercepts the
 *  two-word forms first). */
function expandBareResource(a: string, dir: string): string {
  switch (a) {
    case 'worktree':
      return `worktree:${dir}`;
    case 'branch':
      return branchResource(dir);
    case 'role':
      throw new CommandError('error: role needs a name — `bro claim role <name>`', EXIT.usage);
    case 'task':
      throw new CommandError('error: task needs an id — `bro claim task <id>`', EXIT.usage);
    case 'pr':
    case 'path':
      throw new CommandError(
        `error: ${a} needs a value — \`bro claim ${a} <${a === 'pr' ? 'n' : 'glob'}>\``,
        EXIT.usage
      );
    default:
      return a;
  }
}

/** Expand a resource argument to a URI — shorthands resolve against
 *  `dir`; anything already `scheme:`-shaped passes through. */
export function expandResourceArg(arg: string, dir: string): string {
  const a = arg.trim();
  if (/^[a-z][a-z0-9-]*:\S+/i.test(a)) {
    return a;
  }
  return expandBareResource(a, dir);
}

function prNumberUri(n: string): string {
  if (!/^\d+$/.test(n)) {
    throw new CommandError('error: # needs a PR number — `bro claim #<n>`', EXIT.usage);
  }
  return `pr:${n}`;
}

function roleResourceUri(value: string, dir: string): string {
  if (value === '') {
    throw new CommandError('error: role needs a name — `bro claim role <name>`', EXIT.usage);
  }
  const project = sessionProject(dir);
  if (project === undefined) {
    throw new CommandError('error: project unresolvable — cannot scope the role claim', EXIT.error);
  }
  return `role:${value}@${project}`;
}

function taskResourceUri(value: string): string {
  if (value === '') {
    throw new CommandError('error: task needs an id — `bro claim task <id>`', EXIT.usage);
  }
  return `task:${value}`;
}

function prResourceUri(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new CommandError('error: pr needs a number — `bro claim pr <n>`', EXIT.usage);
  }
  return `pr:${value}`;
}

function pathResourceUri(value: string): string {
  if (value === '') {
    throw new CommandError('error: path needs a glob — `bro claim path <glob>`', EXIT.usage);
  }
  return `path:${value}`;
}

/** `bro claim role orchestrator` / `task bro-x` / `pr 12` / `path g` /
 *  `#7` — the shorthand words, resolved here so expandResourceArg
 *  stays single-arg pure. An unrecognized MULTI-word positional is a
 *  malformed shorthand (`claim worktree /x`), never a resource — URIs
 *  carry no spaces — so it is a usage error, not a literal claim. */
export function expandResourceWords(words: string[], dir: string): string {
  if (words.length === 0) {
    throw new CommandError(`error: claim needs a resource\n${USAGE}`, EXIT.usage);
  }
  const [head, ...rest] = words;
  if (head.startsWith('#')) {
    return prNumberUri(head.slice(1));
  }
  const value = rest.join(' ').trim();
  switch (head) {
    case 'role':
      return roleResourceUri(value, dir);
    case 'task':
      return taskResourceUri(value);
    case 'pr':
      return prResourceUri(value);
    case 'path':
      return pathResourceUri(value);
    default:
      if (words.length > 1) {
        throw new CommandError(
          `error: unrecognized resource "${words.join(' ')}" — pass a <scheme>:<rest> URI or a known shorthand\n${USAGE}`,
          EXIT.usage
        );
      }
      return expandResourceArg(head, dir);
  }
}

function fmtLeaseUntil(ms: number | null, now: number): string {
  if (ms === null) {
    return '—';
  }
  const s = Math.max(0, Math.floor((ms - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** '—' for absent values, else the string form. */
function dashCell(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function claimCell(r: ClaimRow, k: string, now: number): string {
  if (k === 'sid') {
    return r.sid.length > 14 ? `${r.sid.slice(0, 14)}…` : r.sid;
  }
  if (k === 'lease') {
    return fmtLeaseUntil(r.leaseUntil, now);
  }
  if (k === 'exclusive') {
    return r.exclusive ? 'yes' : 'no';
  }
  return dashCell(r[k as keyof ClaimRow]);
}

function claimTableLines(rows: ClaimRow[], now: number): string[] {
  const cols: [keyof ClaimRow | 'lease', string][] = [
    ['resource', 'RESOURCE'],
    ['host', 'HOST'],
    ['sid', 'SID'],
    ['project', 'PROJECT'],
    ['exclusive', 'EXCL'],
    ['lease', 'LEASE'],
    ['detail', 'DETAIL'],
  ];
  const cells = rows.map(r => cols.map(([k]) => claimCell(r, k, now)));
  const widths = cols.map(([, h], i) => Math.max(h.length, ...cells.map(c => c[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(cols.map(([, h]) => h)), ...cells.map(c => line(c))];
}

function sessionKey(sess: ResolvedSession): SessionKey {
  return { host: sess.host, sid: sess.sid };
}

function requireSession(sess: ResolvedSession): SessionKey {
  if (!sess.ok || sess.sid === '') {
    throw new CommandError(
      'error: no session id resolvable — pass --session <id> --host <h> or run inside an agent session',
      EXIT.usage
    );
  }
  if (sess.host === 'unknown') {
    throw new CommandError(
      'error: session host is unknown — pass --host <h> (claude, codex, devin, …)',
      EXIT.usage
    );
  }
  return sessionKey(sess);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runClaimList(
  args: ClaimArgs,
  claims: ClaimFacade,
  sess: ResolvedSession,
  dir: string,
  now: number
): Promise<void> {
  const project = args.project ? sessionProject(dir) : undefined;
  let rows: ClaimRow[];
  try {
    rows = await claims.list({
      ...(project !== undefined ? { project } : {}),
      ...(args.resourcePrefix !== undefined ? { resource: args.resourcePrefix } : {}),
      ...(sess.ok && sess.sid !== '' && args.session !== undefined
        ? { session: sessionKey(sess) }
        : {}),
    });
  } catch (err) {
    throw new CommandError(`error: claims unavailable — ${errText(err)}`, EXIT.error);
  }
  // --project with no project id matches nothing, like `bro sessions --project`
  if (args.project && project === undefined) {
    rows = [];
  }
  if (args.json) {
    console.log(JSON.stringify({ claims: rows, warnings: [] }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('no live claims');
    return;
  }
  for (const line of claimTableLines(rows, now)) {
    console.log(line);
  }
}

async function runClaimRelease(
  args: ClaimArgs,
  claims: ClaimFacade,
  key: SessionKey,
  uri: string,
  dir: string
): Promise<void> {
  try {
    // dir rides along so a task:* release resolves the same store a
    // dir-scoped claim wrote to even when the session row has no cwd
    await claims.release(uri, key, { dir });
  } catch (err) {
    throw new CommandError(`error: release failed — ${errText(err)}`, EXIT.error);
  }
  if (args.json) {
    console.log(JSON.stringify({ released: uri, session: key }, null, 2));
    return;
  }
  console.log(`released ${uri} for ${key.host}-${key.sid}`);
}

async function runClaimAcquire(
  args: ClaimArgs,
  claims: ClaimFacade,
  key: SessionKey,
  resource: string,
  dir: string
): Promise<void> {
  const owner = agentOwner();
  let result: ClaimResult;
  try {
    result = await claims.claim(resource, key, {
      ...(args.ttlSec !== undefined ? { ttlMs: args.ttlSec * 1000 } : {}),
      ...(args.exclusive !== undefined ? { exclusive: args.exclusive } : {}),
      ...(owner !== null ? { pid: owner.pid, pidStart: owner.start } : {}),
      dir,
    });
  } catch (err) {
    throw new CommandError(`error: claim failed — ${errText(err)}`, EXIT.error);
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        { ok: result.ok, resource, session: key, conflict: result.conflict ?? null },
        null,
        2
      )
    );
  } else if (result.ok) {
    console.log(`claimed ${resource} for ${key.host}-${key.sid}`);
  } else {
    const c = result.conflict;
    console.log(
      `claim refused — ${resource} held by ${c === undefined || c === null ? 'another session' : `${c.host}-${c.sid}`}`
    );
  }
  // a refused claim is a verdict, not a crash — exit 1 so scripts see it
  if (!result.ok) {
    process.exitCode = EXIT.error;
  }
}

export async function runClaimCommand(argv: string[], deps: ClaimDeps = {}): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  const args = claimArgs(argv);
  const dir = deps.dir ?? process.cwd();
  const env = deps.env ?? process.env;
  const claims = claimsFacadeFor(dir, deps);
  const sess = resolveSession(args, env);

  if (args.sub === 'list') {
    await runClaimList(args, claims, sess, dir, deps.now ?? Date.now());
    return;
  }

  const key = requireSession(sess);
  // the resource words: `claim worktree` → ['worktree'];
  // `release worktree` → ['worktree'] (subcommand token dropped);
  // `claim role orchestrator` keeps both words for the shorthand.
  const words = (args.sub === 'claim' ? args.pos : args.pos.slice(1)).filter(w => w !== '');
  if (words.length === 0) {
    throw new CommandError(`error: ${args.sub} needs a resource\n${USAGE}`, EXIT.usage);
  }
  const uri = expandResourceWords(words, dir);

  if (args.sub === 'release') {
    await runClaimRelease(args, claims, key, uri, dir);
    return;
  }
  await runClaimAcquire(args, claims, key, uri, dir);
}
