/**
 * `bro goal` — session-scoped completion goals (spec:
 * specs/goal/bro-6vcll.md). Codex's "persisted thread objective" +
 * Claude's `/goal` lifecycle, keyed to bro's session state instead of a
 * vendor runtime.
 *
 *   bro goal <condition…>   set/replace — [--session <id>] [--turns N]
 *   bro goal                status — condition, status, age, evals, verdict
 *   bro goal pause|resume   suspend / reactivate (resume resets evals)
 *   bro goal clear          resolve (aliases: stop, off, reset, none, cancel)
 *                           [--json] everywhere
 *
 * State: `<git-common-dir>/bro/hooks/goal/<session>.json` — a `goal/`
 * SUBDIR of the hooks state dir, never flat: readArmed scans
 * `<session>.*` files as gate aspects, so a flat `<session>.goal` would
 * arm a phantom aspect on every goal write (same rule as hinted/,
 * trace/, perf/).
 *
 * Session resolution: `--session` > env (BRO_SESSION_ID, DEVIN_SESSION_ID,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID, CODEX_SESSION_ID,
 * OPENCODE_SESSION_ID) > the repo
 * seed `_default` — what a bare-shell `bro goal` writes, materialized as
 * the NEXT session's goal when its hook first evaluates it.
 *
 * Verdicts are advisory — the stop hook injects context, never
 * `decision: block` (judge shadow contract; gates not loops).
 */
import { execFileSync } from 'node:child_process';
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  hasHelpFlag,
  LockTimeout,
  printUsage,
  spawnSelf,
  withFileLock,
  type DecideResult,
  type JudgeAnswer,
} from '@broject/core';
import { appendRow, judgeConfig, judgeFacade } from '@broject/judge';
import { loadBroConfig } from '../plugins.ts';
import type { GoalConfig } from './goal-config.ts';

export type GoalStatus = 'active' | 'paused' | 'achieved' | 'impossible' | 'budget' | 'cleared';

export interface GoalRecord {
  condition: string;
  status: GoalStatus;
  createdAt: number;
  /** Stop-hook evaluations run against this goal (judged turns only). */
  evals: number;
  /** Turn budget — 0 = no cap. */
  maxTurns: number;
  lastVerdict?: 'met' | 'not_met' | 'impossible';
  lastReason?: string;
  resolvedAt?: number;
}

/** The repo-level seed — `bro goal` on a bare shell writes here; the
 *  next session's hook materializes it as that session's goal. */
const SEED = '_default';

const SESSION_ENV = [
  'BRO_SESSION_ID',
  'DEVIN_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENCODE_SESSION_ID',
] as const;

/** `<git-common-dir>/bro/hooks/goal` — sibling of the arming markers,
 *  shared across linked worktrees so a goal set in one worktree is
 *  visible to the session running in another. Null outside a git dir. */
function goalDir(dir: string): string | null {
  try {
    const gd = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      // NOSONAR
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // rev-parse answers relative to the CWD it ran in — resolve against
    // `dir` so callers (tests, hooks in worktrees) get an absolute path
    return gd ? join(isAbsolute(gd) ? gd : resolve(dir, gd), 'bro', 'hooks', 'goal') : null;
  } catch {
    return null;
  }
}

const safe = (id: string): string => id.replace(/[^\w.-]/g, '_');

function goalPath(dir: string, session: string): string | null {
  const d = goalDir(dir);
  return d ? join(d, `${safe(session)}.json`) : null;
}

/** The session's eval/update lock — serializes the stop hook's
 *  recheck+write against `bro goal pause|clear|set` so a write landing
 *  mid-eval is seen, never clobbered back to active. */
function goalLock(dir: string, session: string): string | null {
  const p = goalPath(dir, session);
  return p === null ? null : `${p}.lock`;
}

/** A mutating verb serializes against an in-flight stop-hook eval —
 *  its read-modify-write must never interleave the eval's recheck+write.
 *  A wedged lock fails open: `bro goal` must keep working. */
const withGoalLock = <T>(dir: string, target: string, fn: () => T): T => {
  const lock = goalLock(dir, target);
  if (lock === null) {
    return fn();
  }
  try {
    return withFileLock(lock, fn, { waitMs: 5_000, label: 'goal update lock' });
  } catch (err) {
    if (err instanceof LockTimeout) {
      return fn();
    }
    throw err;
  }
};

export function readGoal(dir: string, session: string): GoalRecord | null {
  const path = goalPath(dir, session);
  if (path === null || !existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoalRecord>;
    if (typeof raw.condition !== 'string' || raw.condition === '') {
      return null;
    }
    return {
      condition: raw.condition,
      status: (typeof raw.status === 'string' ? raw.status : 'active') as GoalStatus,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      evals: typeof raw.evals === 'number' ? raw.evals : 0,
      maxTurns: typeof raw.maxTurns === 'number' ? raw.maxTurns : 0,
      ...(raw.lastVerdict !== undefined ? { lastVerdict: raw.lastVerdict } : {}),
      ...(raw.lastReason !== undefined ? { lastReason: raw.lastReason } : {}),
      ...(raw.resolvedAt !== undefined ? { resolvedAt: raw.resolvedAt } : {}),
    };
  } catch {
    return null;
  }
}

function writeGoal(dir: string, session: string, goal: GoalRecord): void {
  const path = goalPath(dir, session);
  if (path === null) {
    throw new Error('not inside a git worktree — goal state needs the common git dir');
  }
  mkdirSync(goalDir(dir)!, { recursive: true }); // NOSONAR — goalPath proved non-null
  writeFileSync(path, `${JSON.stringify(goal, null, 2)}\n`, 'utf8');
}

/** This session's goal — materializing the repo seed when no session
 *  record exists yet (the seed is a template, not shared mutable state:
 *  every session gets its own eval counter). */
export function sessionGoal(dir: string, sessionId: string): GoalRecord | null {
  const own = readGoal(dir, sessionId);
  if (own !== null || sessionId === SEED) {
    return own;
  }
  const seed = readGoal(dir, SEED);
  if (seed !== null && sessionId !== '') {
    try {
      writeGoal(dir, sessionId, {
        ...seed,
        evals: 0,
        lastVerdict: undefined,
        lastReason: undefined,
        resolvedAt: undefined,
      });
      rmSync(goalPath(dir, SEED)!, { force: true }); // NOSONAR — writeGoal proved non-null
      return sessionGoal(dir, sessionId);
    } catch {
      // a failed materialization still serves the seed read-only —
      // the next session retries the copy
      return seed;
    }
  }
  return seed;
}

function goalConfig(dir: string): GoalConfig {
  try {
    return (loadBroConfig(dir) as Record<string, unknown>).goal as GoalConfig;
  } catch {
    return { maxTurns: 25, judge: true };
  }
}

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) {
    return 'just now';
  }
  if (m < 60) {
    return `${m}m`;
  }
  return `${Math.round(m / 60)}h`;
}

/** One-line status — the CLI's `bro goal` readout and the hook's
 *  session-start rehydration share it. */
export function goalStatusLine(goal: GoalRecord): string {
  const budget = goal.maxTurns > 0 ? `${goal.evals}/${goal.maxTurns}` : `${goal.evals}`;
  const tail =
    goal.lastVerdict !== undefined && goal.status === 'active'
      ? ` · last: ${goal.lastVerdict}${goal.lastReason ? ` — ${goal.lastReason}` : ''}`
      : '';
  return `goal [${goal.status} · ${fmtAge(Date.now() - goal.createdAt)} · turns ${budget}]: "${goal.condition}"${tail}`;
}

/** A queued eval request — the stop hook writes it, `bro goal eval`
 *  claims it by rename. `createdAt`/`evals` pin the merge to the goal
 *  generation the evidence described: a set/pause/resume landing
 *  mid-eval (or a newer verdict landing first) makes the recheck
 *  drop this verdict instead of merging stale answers. */
interface GoalEvalReq {
  createdAt: number;
  evals: number;
  condition: string;
  trace: string;
  context?: string;
}

/** How fresh a req marks an eval pending — also the retry backoff a
 *  wedged/failed eval leaves behind. Comfortably longer than a slow
 *  decide() so an in-flight worker is never double-spawned. */
const GOAL_REQ_FRESH_MS = 120_000;

const GOAL_VERDICT_QUESTION = {
  type: 'choice',
  instructions:
    'An agent session is working toward this completion condition. Judge the ' +
    'conversation evidence (tool trace) against it. "met" = the condition is ' +
    'demonstrably satisfied by surfaced evidence (test output, clean tree, landed ' +
    'artifact) — belief is not evidence. "not_met" = still reachable, work ' +
    'continues. "impossible" = no defensible path remains under current limits.',
  criteria: {
    met: 'condition satisfied by concrete evidence in the trace',
    not_met: 'evidence absent or incomplete but the path is still open',
    impossible: 'the condition can never be satisfied — blocker named',
  },
} as const;

const goalReqPath = (dir: string, session: string): string | null => {
  const d = goalDir(dir);
  return d === null ? null : join(d, `${safe(session)}.req.json`);
};

const goalNoticePath = (dir: string, session: string): string | null => {
  const d = goalDir(dir);
  return d === null ? null : join(d, `${safe(session)}.notice`);
};

const reminder = (condition: string): string =>
  `goal: "${condition}" — verify it before reporting done ` +
  '(`bro goal` shows status · `bro goal clear` resolves)';

function freshFile(path: string, freshMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < freshMs;
  } catch {
    return false;
  }
}

/** Consume the eval worker's transition announcement — rename-claim so
 *  exactly one stop emits it; a torn or missing notice is silence. */
function claimGoalNotice(dir: string, sessionId: string): string | null {
  const notice = goalNoticePath(dir, sessionId);
  if (notice === null) {
    return null;
  }
  const claimed = `${notice}.seen-${process.pid}`;
  try {
    renameSync(notice, claimed);
  } catch {
    return null;
  }
  try {
    const text = readFileSync(claimed, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

/** The in-flight half of "pending" — a claimed req rides as
 *  `<req>.work-<pid>` while its eval decides, so the req file itself
 *  is absent for that span and the fresh-req check alone would see an
 *  empty queue. A fresh claim means an eval is running. */
function workClaimFresh(req: string): boolean {
  const d = dirname(req);
  const prefix = `${basename(req)}.work-`;
  let names: string[];
  try {
    names = readdirSync(d);
  } catch {
    return false;
  }
  return names.some(f => f.startsWith(prefix) && freshFile(join(d, f), GOAL_REQ_FRESH_MS));
}

/** Queue the off-hook eval — a fresh req or a fresh work claim marks
 *  one pending (an eval holding the claim is mid-decide; a second
 *  spawn would burn a paid decide whose verdict the merge's
 *  eval-count recheck drops), so writing is the throttle and only a
 *  just-written req earns the spawn. The detached `bro goal eval`
 *  claims it by rename; a spawn that never ran leaves the req to age
 *  out — the re-arm is a later stop seeing it stale (bro-36sx7.4). */
async function enqueueGoalEval(
  dir: string,
  sessionId: string,
  goal: GoalRecord,
  evidence: { trace: string; context?: string | Promise<string | undefined> }
): Promise<void> {
  const req = goalReqPath(dir, sessionId);
  if (req === null) {
    return;
  }
  if (freshFile(req, GOAL_REQ_FRESH_MS) || workClaimFresh(req)) {
    return;
  }
  try {
    mkdirSync(goalDir(dir)!, { recursive: true }); // NOSONAR — req proved non-null
    const body: GoalEvalReq = {
      createdAt: goal.createdAt,
      evals: goal.evals,
      condition: goal.condition,
      // the trace journal is metadata (tool/command/paths/ok), not
      // output — the context text carries the checkable surface
      // (bd state, gate, tree) the verdict needs
      trace: evidence.trace.slice(-8000),
      context: (await evidence.context)?.slice(-8000),
    };
    const tmp = `${req}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, req);
    spawnSelf(['goal', 'eval', '--session', sessionId], dir);
  } catch {
    // a queue failure degrades to the plain reminder — never a stall
  }
}

/** The stop-hook evaluation — returns context lines, never a block.
 *  The judge never runs here (bro-36sx7.4): the hook queues the eval
 *  for a detached `bro goal eval` and reads only the record — a
 *  reminder, or the last verdict's "turn N — not yet met" — plus any
 *  transition notice the worker left. Anything unverifiable degrades
 *  to the plain reminder. */
export async function goalStopLines(
  dir: string,
  sessionId: string,
  evidence: { trace: string; context?: string | Promise<string | undefined> }
): Promise<string[]> {
  // a queued transition announcement outranks the record read — met/
  // impossible/budget flipped the status, which would otherwise
  // swallow the one line the session needs to see
  const notice = claimGoalNotice(dir, sessionId);
  const lines: string[] = notice === null ? [] : [notice];
  const goal = sessionGoal(dir, sessionId);
  // A paused goal stays silent: any per-stop context re-wakes the host,
  // so a reminder here turns an idle wait into an unbounded turn loop.
  if (goal === null || goal.status !== 'active') {
    return lines;
  }
  const cfg = goalConfig(dir);
  const jcfg = judgeConfig(dir).judge;
  // provider-mode AND legacy connector-mode judge configs both resolve
  // through judgeFacade — off-hook now, in the detached eval worker
  const judged = cfg.judge && jcfg.mode !== 'off' && sessionId !== '';
  if (!judged) {
    lines.push(reminder(goal.condition));
    return lines;
  }
  await enqueueGoalEval(dir, sessionId, goal, evidence);
  // the evidence await is the one async seam a pause/clear can land
  // through — re-read before emitting so a mid-write pause stays
  // silent instead of re-waking the host (the queued req's merge
  // recheck drops its own verdict the same way)
  const fresh = sessionGoal(dir, sessionId);
  if (fresh === null || fresh.status !== 'active') {
    return lines;
  }
  lines.push(
    fresh.lastVerdict === 'not_met'
      ? `goal turn ${fresh.evals}${fresh.maxTurns > 0 ? `/${fresh.maxTurns}` : ''} — not yet met: ` +
          `"${fresh.condition}" — keep going (\`bro goal clear\` resolves it)`
      : reminder(fresh.condition)
  );
  return lines;
}

/** Merge a produced verdict into the LATEST record — the worker-side
 *  half of the old in-hook eval: recheck under the session lock (a
 *  pause/clear/replace landing mid-decide, or a concurrent eval
 *  merging first, drops this verdict), journal the row, apply the
 *  transitions. Returns the announcement lines plus whether the goal
 *  left 'active' — transitions are what `.notice` carries. */
function mergeGoalVerdict(
  dir: string,
  sessionId: string,
  snap: { createdAt: number; evals: number },
  choice: string,
  res: DecideResult
): { lines: string[]; transitioned: boolean } {
  const finish = (): { lines: string[]; transitioned: boolean } => {
    const fresh = sessionGoal(dir, sessionId);
    if (
      fresh === null ||
      fresh.createdAt !== snap.createdAt ||
      fresh.evals !== snap.evals ||
      fresh.status !== 'active'
    ) {
      return { lines: [], transitioned: false };
    }
    fresh.lastVerdict = choice as GoalRecord['lastVerdict'];
    fresh.evals += 1;
    try {
      appendRow(dir, {
        ts: new Date().toISOString(),
        kind: 'goal-verdict',
        subject: { threadId: sessionId || undefined },
        questions: {},
        answers: res.answers,
        model: res.model,
        latencyMs: res.latencyMs,
        ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
      });
    } catch {
      // the journal is a nicety, not the verdict
    }
    if (choice === 'met') {
      fresh.status = 'achieved';
      fresh.resolvedAt = Date.now();
      writeGoal(dir, sessionId, fresh);
      return {
        lines: [`◎ goal met: "${fresh.condition}" (${fresh.evals} turns) — cleared`],
        transitioned: true,
      };
    }
    if (choice === 'impossible') {
      fresh.status = 'impossible';
      fresh.resolvedAt = Date.now();
      writeGoal(dir, sessionId, fresh);
      return {
        lines: [
          `goal judged impossible: "${fresh.condition}" — cleared; ` +
            'report the blocker or set a new goal',
        ],
        transitioned: true,
      };
    }
    if (fresh.maxTurns > 0 && fresh.evals >= fresh.maxTurns) {
      fresh.status = 'budget';
      fresh.resolvedAt = Date.now();
      writeGoal(dir, sessionId, fresh);
      return {
        lines: [
          `goal turn budget reached (${fresh.evals}/${fresh.maxTurns}): "${fresh.condition}" ` +
            '— paused; `bro goal resume` continues, `bro goal clear` drops it',
        ],
        transitioned: true,
      };
    }
    writeGoal(dir, sessionId, fresh);
    return { lines: [], transitioned: false };
  };
  const lock = goalLock(dir, sessionId);
  return lock === null
    ? finish()
    : withFileLock(lock, finish, { waitMs: 5_000, label: 'goal eval lock' });
}

/** `bro goal eval` — the detached eval worker (internal; the stop hook
 *  spawns it, users never see it). Claims the session's req by rename,
 *  decides against the real facade, merges under the goal lock, and
 *  leaves transition announcements in `.notice` for the next stop.
 *  A thrown/wedged decide restores the req — its age is the retry
 *  backoff. Stale `.work-*`/`.seen-*` rinds are reaped on entry. */
async function cmdGoalEval(dir: string, session: string): Promise<void> {
  const req = goalReqPath(dir, session);
  if (req === null) {
    return;
  }
  sweepGoalWork(req);
  const work = `${req}.work-${process.pid}`;
  try {
    renameSync(req, work);
  } catch {
    return; // no pending eval — or a peer worker claimed it
  }
  let body: Partial<GoalEvalReq>;
  try {
    body = JSON.parse(readFileSync(work, 'utf8')) as Partial<GoalEvalReq>;
  } catch {
    rmSync(work, { force: true });
    return;
  }
  if (typeof body.condition !== 'string' || typeof body.createdAt !== 'number') {
    rmSync(work, { force: true });
    return;
  }
  const restore = (): void => {
    try {
      renameSync(work, req);
    } catch {
      rmSync(work, { force: true });
    }
  };
  let res: DecideResult;
  try {
    res = await judgeFacade(dir).decide(
      {
        goal: body.condition,
        trace: (typeof body.trace === 'string' ? body.trace : '').slice(-8000),
        context: typeof body.context === 'string' ? body.context.slice(-8000) : undefined,
      },
      { verdict: GOAL_VERDICT_QUESTION }
    );
  } catch {
    restore();
    return;
  }
  const answer = res.answers.verdict as JudgeAnswer | undefined;
  if (answer === undefined || answer.type !== 'choice' || res.lowConfidence.includes('verdict')) {
    restore();
    return;
  }
  const merged = mergeGoalVerdict(
    dir,
    session,
    { createdAt: body.createdAt, evals: typeof body.evals === 'number' ? body.evals : 0 },
    answer.choice,
    res
  );
  rmSync(work, { force: true });
  if (merged.transitioned) {
    const notice = goalNoticePath(dir, session);
    if (notice !== null) {
      try {
        const tmp = `${notice}.tmp-${process.pid}`;
        writeFileSync(tmp, merged.lines.join('\n'));
        renameSync(tmp, notice);
      } catch {
        // a lost notice still left the transition in the record
      }
    }
  }
}

/** Reap eval debris older than the req freshness window — work claims
 *  a wedged worker abandoned, notice rinds, tmp orphans. Runs on the
 *  eval path (one readdir per spawn), never the hook's. */
function sweepGoalWork(req: string): void {
  let names: string[];
  try {
    names = readdirSync(dirname(req));
  } catch {
    return;
  }
  const cutoff = Date.now() - GOAL_REQ_FRESH_MS;
  for (const f of names) {
    if (!/\.(work|seen|tmp)-\d+/.test(f)) {
      continue;
    }
    try {
      const p = join(dirname(req), f);
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { force: true });
      }
    } catch {
      // raced removal — the next spawn sweeps it
    }
  }
}

/** Session-start/post-compaction line — Claude's resume-restores-goal,
 *  from a file so it survives compaction and session death alike. */
export function goalContextLines(dir: string, sessionId: string): string[] {
  const goal = sessionId !== '' ? sessionGoal(dir, sessionId) : readGoal(dir, SEED);
  if (goal === null || (goal.status !== 'active' && goal.status !== 'paused')) {
    return [];
  }
  return [goalStatusLine(goal)];
}

// --- CLI -----------------------------------------------------------------------

function sessionFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const k of SESSION_ENV) {
    const v = env[k]?.trim();
    if (v) {
      return v;
    }
  }
  return undefined;
}

const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

interface GoalArgs {
  /** --session > env > undefined (repo seed target). */
  session?: string;
  /** --turns override — undefined keeps the config default. */
  turns?: number;
  asJson: boolean;
  /** Non-flag argv after consuming --session/--turns values. */
  positional: string[];
}

function parseGoalArgs(argv: string[]): GoalArgs {
  const si = argv.indexOf('--session');
  const ti = argv.indexOf('--turns');
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`error: ${flag} requires a value`);
      process.exit(2);
    }
    return v;
  };
  let turns: number | undefined;
  if (ti >= 0) {
    const n = Number(valueOf(ti, '--turns'));
    if (!Number.isInteger(n) || n < 0) {
      console.error(
        `error: --turns expects a non-negative integer — got ${JSON.stringify(argv[ti + 1])}`
      );
      process.exit(2);
    }
    turns = n;
  }
  const valueIdx = new Set([si, ti].filter(i => i >= 0).map(i => i + 1));
  return {
    session: si >= 0 ? valueOf(si, '--session') : sessionFromEnv(process.env),
    turns,
    asJson: argv.includes('--json'),
    positional: argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i)),
  };
}

function printStatus(goal: GoalRecord | null, session: string, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ session, goal }, null, 2));
    return;
  }
  console.log(goal === null ? 'no goal set' : goalStatusLine(goal));
}

function report(target: string, goal: GoalRecord, asJson: boolean, text: string): void {
  if (asJson) {
    console.log(JSON.stringify({ session: target, goal }, null, 2));
    return;
  }
  console.log(text);
}

function clearGoal(dir: string, target: string, goal: GoalRecord | null, asJson: boolean): void {
  if (goal === null) {
    console.log('No goal set');
    return;
  }
  goal.status = 'cleared';
  goal.resolvedAt = Date.now();
  writeGoal(dir, target, goal);
  report(target, goal, asJson, `Goal cleared: ${goal.condition}`);
}

function pauseResumeGoal(
  dir: string,
  target: string,
  verb: 'pause' | 'resume',
  goal: GoalRecord | null,
  asJson: boolean
): void {
  if (goal === null) {
    console.log('No goal set');
    return;
  }
  goal.status = verb === 'pause' ? 'paused' : 'active';
  if (verb === 'resume') {
    goal.evals = 0;
    goal.resolvedAt = undefined;
  }
  writeGoal(dir, target, goal);
  report(target, goal, asJson, `goal ${verb}d: "${goal.condition}"`);
}

function setGoal(
  dir: string,
  target: string,
  condition: string,
  turns: number | undefined,
  asJson: boolean
): void {
  if (condition.length > 4000) {
    console.error('error: goal condition is capped at 4000 characters');
    process.exit(2);
  }
  const goal: GoalRecord = {
    condition,
    status: 'active',
    createdAt: Date.now(),
    evals: 0,
    maxTurns: turns ?? goalConfig(dir).maxTurns,
  };
  withGoalLock(dir, target, () => writeGoal(dir, target, goal));
  report(
    target,
    goal,
    asJson,
    `goal set (${target === SEED ? 'repo — binds to next session' : `session ${target.slice(0, 12)}`}): ` +
      `"${condition}"${goal.maxTurns > 0 ? ` · ${goal.maxTurns} turns` : ''}`
  );
}

export function runGoalCommand(argv: string[]): void | Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(
      'usage: bro goal [<condition> | clear|pause|resume|status] [--session <id>] [--turns <n>] [--json]',
      0
    );
  }
  const dir = process.cwd();
  const { session, turns, asJson, positional } = parseGoalArgs(argv);
  const target = session ?? SEED;
  const verb = positional[0];
  // the detached eval worker — internal, spawned by the stop hook and
  // always --session-bound so a bare `bro goal eval` can never swallow
  // a goal literally named "eval"
  if (verb === 'eval' && session !== undefined) {
    return cmdGoalEval(dir, target);
  }
  // a session-scoped verb binds the session's materialized goal — the
  // seed is consumed, not left behind to re-seed the next session
  const verbGoal = () => (session === undefined ? readGoal(dir, SEED) : sessionGoal(dir, target));

  if (verb !== undefined && CLEAR_ALIASES.has(verb)) {
    withGoalLock(dir, target, () => clearGoal(dir, target, verbGoal(), asJson));
    return;
  }
  if (verb === 'pause' || verb === 'resume') {
    withGoalLock(dir, target, () => pauseResumeGoal(dir, target, verb, verbGoal(), asJson));
    return;
  }
  if (verb === 'status' || verb === undefined) {
    printStatus(verbGoal(), target, asJson);
    return;
  }
  setGoal(dir, target, positional.join(' '), turns, asJson);
}
