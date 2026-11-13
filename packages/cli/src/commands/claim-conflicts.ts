/**
 * Claims conflict consumers — the mode-gated policy from
 * specs/sessions/bro-izpyk.md "Claims and conflicts" (impl
 * specs/bro-izpyk.8.md):
 *
 *   "In observe, a conflict is shown as an inbox note. In code, guard
 *    warns on pre-tool, and blocks only when the project config opts in."
 *
 * Two halves:
 *
 * - `claimConflictConnector` — a guard-plane `preTool` connector. When a
 *   tool call touches a resource a DIFFERENT live session claims, the
 *   verdict is `warn` (default `claims.conflicts`) or `block` (the
 *   spec's opt-in). Declared `activeIn` for every ACTIVE mode — observe
 *   is excluded, its channel is the inbox note. run.sh keeps pre-tool on
 *   the Node path in every mode, so this declaration IS the mode gate.
 * - `noteRefusedClaim` — the observe half: a refused `bro claim` leaves
 *   a note in the refused session's F4 inbox (via `sendSessionMessage`,
 *   which degrades to the mailbox address for hosts the inbox cannot
 *   name). Mode-active callers get no note — the standing conflict
 *   re-derives on their next pre-tool instead.
 *
 * The fire-and-forget arm bridge in hooks.ts appends the same inbox note
 * shape directly (its async claim result can never join the event that
 * armed it).
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  facade,
  gitTry,
  loadConfig,
  sessionMode,
  sessionProject,
  type ClaimConflictPolicy,
  type ClaimFacade,
  type ClaimRow,
  type Connector,
  type ConnectorCtx,
  type EventsFacade,
  type LedgerFacade,
  type Mode,
  type PreToolVerdict,
  type SessionKey,
} from '@broject/core';
// sendSessionMessage is imported lazily inside noteRefusedClaim:
// session-msg → sessions → plugins → connectors closes a cycle back onto
// THIS module, and a static edge would leave claimConflictConnector in
// the TDZ whenever the graph is entered from connectors.ts first.

// --- config ------------------------------------------------------------------

/** `claims.conflicts` for a repo — 'warn' when the section is absent or
 *  unreadable: a broken config must not silently upgrade warnings into
 *  vetoes, and the spec default is the warn tier anyway. */
export function claimConflictPolicy(dir: string): ClaimConflictPolicy {
  try {
    const c = loadConfig(dir).claims?.conflicts;
    return c === 'block' || c === 'off' ? c : 'warn';
  } catch {
    return 'warn';
  }
}

// --- path globbing ------------------------------------------------------------
// Same convention as learn's matchPath / act's isDocsPath: a pattern
// without a slash matches the basename, '**/' is zero-or-more dirs, '*'
// stays inside a segment, '**' crosses '/', a trailing '/' means the dir
// at any depth. Copied, not imported: core cannot reach @broject/learn
// and the hook path carries no glob dep of its own.

const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[^*?]+/g;

function globToRe(glob: string): RegExp {
  const re = glob.replace(GLOB_TOKEN, tok => {
    switch (tok) {
      case '**/':
        return '(?:.*/)?';
      case '**':
        return '.*';
      case '*':
        return '[^/]*';
      case '?':
        return '[^/]';
      default:
        return tok.replace(/[^a-zA-Z0-9]/g, c => `\\${c}`);
    }
  });
  return new RegExp(`^${re}$`);
}

function matchClaimPath(path: string, pattern: string): boolean {
  const glob = pattern.endsWith('/') ? `**/${pattern}**` : pattern;
  const target = glob.includes('/') ? path : path.slice(path.lastIndexOf('/') + 1);
  return globToRe(glob).test(target);
}

// --- touched resources ---------------------------------------------------------

const WORKTREE_PREFIX = 'worktree:';
const PATH_PREFIX = 'path:';
const BRANCH_PREFIX = 'branch:';

/** Path fields the hook payload's tool_input carries — file editors
 *  (`file_path`), glob/read tools (`path`), multi-file ops (`files`). */
function toolPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') {
      out.push(v);
    }
  };
  push(input['file_path']);
  push(input['path']);
  if (Array.isArray(input['files'])) {
    for (const f of input['files']) {
      push(f);
    }
  }
  return out;
}

/** realpath when the path resolves (claims and the cwd may disagree on
 *  symlinks), the lexical absolute form otherwise — a claimed worktree
 *  that was removed still matches by spelling. */
function normPath(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** `inner` is `root` itself or somewhere below it. */
function insideOrEqual(inner: string, root: string): boolean {
  return inner === root || inner.startsWith(`${root}${sep}`) || inner.startsWith(`${root}/`);
}

/** A row's project compatibility — a claim whose claimant could not
 *  prove a project (null) still counts: an unresolvable project id must
 *  not hide a conflict. */
function projectCompatible(row: ClaimRow, project: string | null): boolean {
  return row.project === null || project === null || row.project === project;
}

/** Same-session test — a claim is never a conflict with its own holder.
 *  An unknown/absent host can't disprove same-sid, so sid equality alone
 *  is enough there (a warn on the session's own claim is pure noise). */
function sameSession(row: ClaimRow, session: SessionKey): boolean {
  if (row.sid !== session.sid) {
    return false;
  }
  return session.host === '' || session.host === 'unknown' || row.host === session.host;
}

/** The current branch — one bounded git probe, resolved LAZILY by the
 *  caller only when `branch:` claims exist (the common pre-tool pays
 *  nothing for a resource type nobody claims). */
function currentBranch(dir: string): string | undefined {
  const r = gitTry(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 1000);
  if (r.code !== 0) {
    return undefined;
  }
  const b = r.out.trim();
  return b === '' || b === 'HEAD' ? undefined : b;
}

/** Cap on emitted conflicts — a flood (many claimed path globs hit) is
 *  still one injection budget; the remainder collapses to a count. */
const MAX_CONFLICT_VERDICTS = 5;

export interface ClaimConflictVerdictDeps {
  /** Test seams — production resolves per call site. */
  claims?: ClaimFacade;
  policy?: ClaimConflictPolicy;
  /** The session's own cwd — the arm bridge claims `worktree:<cwd>`;
   *  defaults to the hook process's. */
  cwd?: string;
  /** Project id — defaults to sessionProject(ctx.dir); explicit null
   *  skips resolution (no project → only null-project rows count). */
  project?: string | null;
  /** Current-branch resolver — default probes git in cwd. */
  branch?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** The claims facade for the hook path — resolved like `bro claim`
 *  (`connectors.claims` pin honored), memoized per dir so one hook
 *  process opens the store once. */
const claimsForDir = new Map<string, ClaimFacade>();

function claimsFacadeForDir(dir: string): ClaimFacade {
  let c = claimsForDir.get(dir);
  if (c === undefined) {
    const prefer = loadConfig(dir).connectors;
    c = facade('claims', { dir }, prefer === undefined ? {} : { prefer });
    claimsForDir.set(dir, c);
  }
  return c;
}

interface TouchedClaim {
  uri: string;
  rows: ClaimRow[];
}

/** Group live claim rows by the URIs this tool call touches. */
function touchedClaims(
  rows: ClaimRow[],
  ctx: ConnectorCtx,
  input: Record<string, unknown>,
  deps: ClaimConflictVerdictDeps
): TouchedClaim[] {
  const cwd = deps.cwd ?? process.cwd();
  const cwdReal = normPath(cwd, cwd);
  const paths = toolPaths(input);
  const pathReals = paths.map(p => normPath(p, cwdReal));
  const project = deps.project !== undefined ? deps.project : (sessionProject(ctx.dir) ?? null);
  const groups = new Map<string, ClaimRow[]>();
  let branch: string | undefined;
  let branchResolved = false;
  const branchOnce = (): string | undefined => {
    if (!branchResolved) {
      branchResolved = true;
      branch = (deps.branch ?? (() => currentBranch(cwd)))();
    }
    return branch;
  };
  for (const row of rows) {
    const uri = row.resource;
    let touched = false;
    if (uri.startsWith(WORKTREE_PREFIX)) {
      // worktree claims are path-absolute — project-agnostic. The claim
      // asserts the whole tree below it: the session's cwd inside it
      // conflicts, and so does a tool-carried path landing inside it.
      const claimed = normPath(uri.slice(WORKTREE_PREFIX.length), cwdReal);
      touched = insideOrEqual(cwdReal, claimed) || pathReals.some(p => insideOrEqual(p, claimed));
    } else if (uri.startsWith(PATH_PREFIX)) {
      if (!projectCompatible(row, project)) {
        continue;
      }
      const glob = uri.slice(PATH_PREFIX.length);
      touched = paths.some(
        p =>
          matchClaimPath(p, glob) ||
          matchClaimPath(relative(cwdReal, normPath(p, cwdReal)), glob) ||
          matchClaimPath(relative(ctx.dir, normPath(p, ctx.dir)), glob)
      );
    } else if (uri.startsWith(BRANCH_PREFIX)) {
      if (!projectCompatible(row, project)) {
        continue;
      }
      const b = branchOnce();
      touched = b !== undefined && uri === `${BRANCH_PREFIX}${b}`;
    } else {
      // task:* (the tasks store's), pr:*, role:* — no tool-call mapping
      continue;
    }
    if (!touched) {
      continue;
    }
    const g = groups.get(uri);
    if (g === undefined) {
      groups.set(uri, [row]);
    } else {
      g.push(row);
    }
  }
  return [...groups.entries()].map(([uri, group]) => ({ uri, rows: group }));
}

function holderLabel(row: ClaimRow): string {
  const detail =
    row.detail !== undefined && row.detail !== null && row.detail !== '' ? ` — ${row.detail}` : '';
  return `${row.host}-${row.sid}${detail}`;
}

/** The guard-plane verdict for one about-to-run tool call — the spec's
 *  "in code, guard warns on pre-tool". A conflict needs a different live
 *  session's claim on a touched resource where either side is exclusive
 *  (the claim() rule read symmetric: the call is this session's implicit
 *  claim carrying whatever exclusivity it already holds). Fail-open
 *  everywhere: no sid, a dead claims store, or an `off` policy answer
 *  `[]` — a hook never stalls the client. */
export async function claimConflictVerdicts(
  ctx: ConnectorCtx,
  input: { tool: string; input: Record<string, unknown> },
  deps: ClaimConflictVerdictDeps = {}
): Promise<PreToolVerdict[]> {
  try {
    const sid = ctx.sessionId;
    if (sid === undefined || sid === '') {
      // a sessionless call cannot tell its own claims from foreign ones
      return [];
    }
    const policy = deps.policy ?? claimConflictPolicy(ctx.dir);
    if (policy === 'off') {
      return [];
    }
    const session: SessionKey = { host: ctx.host ?? '', sid };
    const claims = deps.claims ?? claimsFacadeForDir(ctx.dir);
    const rows = await claims.list({});
    const touched = touchedClaims(rows, ctx, input.input, deps);
    const out: PreToolVerdict[] = [];
    let extra = 0;
    for (const { uri, rows: group } of touched) {
      const ownExclusive = group.some(r => sameSession(r, session) && r.exclusive);
      const blocker = group.find(r => !sameSession(r, session) && (r.exclusive || ownExclusive));
      if (blocker === undefined) {
        continue;
      }
      if (out.length >= MAX_CONFLICT_VERDICTS) {
        extra++;
        continue;
      }
      const what = `claim conflict — ${uri} held by ${holderLabel(blocker)}`;
      out.push(
        policy === 'block'
          ? {
              block: `${what}; blocked by claims.conflicts=block — release it (\`bro claim release ${uri}\`) or wait for the lease`,
            }
          : { warn: what }
      );
    }
    if (extra > 0) {
      out.push(
        policy === 'block'
          ? { block: `+${extra} more claim conflict(s) — \`bro claim list --project\`` }
          : { warn: `+${extra} more claim conflict(s) — \`bro claim list --project\`` }
      );
    }
    return out;
  } catch {
    // claims are advisory — a wedged store never vetoes a tool call
    return [];
  }
}

/** The connector — `preTool` in every ACTIVE mode; observe is excluded
 *  (its conflict channel is the inbox note, and a passive session never
 *  pays the claims read). The spec names `code`; the other active modes
 *  run tools and the arm bridge identically. */
export const claimConflictConnector: Connector = {
  name: 'claims',
  hooks: () => ({
    preTool: (ctx, input) => claimConflictVerdicts(ctx, input),
  }),
  activeIn: {
    preTool: ['plan', 'code', 'review', 'orchestrate'],
  },
};

// --- observe-mode inbox note ----------------------------------------------------

export interface RefusedClaimNoteDeps {
  dir: string;
  env?: NodeJS.ProcessEnv;
  session: SessionKey;
  resource: string;
  conflict?: ClaimRow | null;
  /** `modes.default` for the caller's repo — `sessionMode` input.
   *  Defaults to the repo's configured default. */
  defaultMode?: Mode;
  /** Facade injections for tests — production resolves per call. */
  ledger?: LedgerFacade;
  events?: EventsFacade;
  now?: number;
}

/** The repo's `modes.default` for the mode resolution — a session with
 *  no mode file resolves to it (absent → observe). */
function modesDefaultFor(dir: string): Mode | undefined {
  try {
    return loadConfig(dir).modes?.default;
  } catch {
    return undefined;
  }
}

/** The observe half of the conflict policy — a refused `bro claim`
 *  drops a note into the refused session's inbox (`[ -s $HOOK_INBOX ]`
 *  wakes Node for it on the next hook, every mode drains). Answers true
 *  when a delivery was accepted. Non-observe sessions get nothing: their
 *  channel is the pre-tool verdict, which re-derives the standing
 *  conflict on the next tool call. Every leg fail-open — a refused claim
 *  already printed to stdout; the note must never error the command. */
export async function noteRefusedClaim(opts: RefusedClaimNoteDeps): Promise<boolean> {
  try {
    const env = opts.env ?? process.env;
    const defaultMode =
      opts.defaultMode !== undefined ? opts.defaultMode : modesDefaultFor(opts.dir);
    const res = sessionMode({
      env,
      host: opts.session.host,
      sid: opts.session.sid,
      ...(defaultMode !== undefined ? { defaultMode } : {}),
    });
    if (res.mode !== 'observe') {
      return false;
    }
    const c = opts.conflict ?? null;
    const holder = c === null ? 'another session' : `${c.host}-${c.sid}`;
    const detail =
      c !== null && c.detail !== undefined && c.detail !== null && c.detail !== ''
        ? ` (${c.detail})`
        : '';
    const { sendSessionMessage } = await import('./session-msg.ts');
    const out = await sendSessionMessage({
      dir: opts.dir,
      env,
      target: `${opts.session.host}:${opts.session.sid}`,
      text: `claim refused — ${opts.resource} held by ${holder}${detail}`,
      kind: 'info',
      ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
      ...(opts.events !== undefined ? { events: opts.events } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    return out.deliveries.length > 0;
  } catch {
    return false;
  }
}
