/**
 * `bro sessions resume <id|--last|--pick>` — the F4 resume command
 * (specs/sessions/bro-izpyk.md "Sessions and resume"; impl
 * specs/bro-izpyk.4.md).
 *
 *   bro sessions resume claude:3f2a…   a session key, sid, or agentId
 *   bro sessions resume --last         the most recently seen session
 *   bro sessions resume --pick         interactive picker (TTY only)
 *   bro sessions resume <id> --print   show the argv, spawn nothing
 *
 * Resolution asks the session plane for `resumeArgv(nativeSessionId,
 * cwd)` — `claude --resume <id>`, `codex resume <id>`,
 * `opencode --session <id>`, `agent --resume <id>`, `devin --resume
 * <id>`. A host with no resume command reports that instead of
 * guessing; launching into tmux/herdr is the F5 launcher facade, out
 * of scope — this command runs the host CLI itself, stdio inherited,
 * in the session's recorded cwd.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  loadConfig,
  printUsage,
  type LedgerFacade,
} from '@broject/core';
import { positionals } from './args.ts';
import { sessionResumeArgv } from '../session-planes/resume.ts';
import { resolveMsgTarget, sessionMsgRows, type MsgSessionRow } from './session-msg.ts';
import { shortSid } from './sessions.ts';

const USAGE = `usage: bro sessions resume [--print] [--last|--pick] [<host>:<sid>|<sid>|<agentId>]

  <id>        session key, sid (exact or unique prefix), or agentId
  --last      the most recently seen session
  --pick      interactive picker — needs a TTY
  --print     render the resume argv without spawning it

Runs the host CLI's own resume command in the session's recorded cwd.
A host with no resume command is reported, never guessed.`;

export interface SessionsResumeDeps {
  dir?: string;
  ledger?: LedgerFacade;
  now?: number;
  bootTimeMs?: number;
  /** Test seams — production uses process.stdin/child_process. */
  pick?: (rows: MsgSessionRow[]) => Promise<number | null>;
  stdinTTY?: boolean;
  spawn?: (argv: string[], cwd: string) => Promise<number>;
  out?: (line: string) => void;
}

function resumeArgs(argv: string[]): { print: boolean; last: boolean; pick: boolean; id?: string } {
  const rest = positionals(argv, new Set(), {
    boolFlags: new Set(['--print', '--last', '--pick']),
    strict: true,
  });
  const print = argv.includes('--print');
  const last = argv.includes('--last');
  const pick = argv.includes('--pick');
  const selectors = [last, pick, rest.length > 0 ? 1 : 0].filter(Boolean).length;
  if (selectors > 1 || rest.length > 1) {
    throw new CommandError('error: choose one of <id>, --last, or --pick', EXIT.usage);
  }
  if (selectors === 0) {
    throw new CommandError(`error: bro sessions resume needs a target\n${USAGE}`, EXIT.usage);
  }
  return { print, last, pick, id: rest[0] };
}

/** Rows for resume — same ledger read `bro msg` uses, most recently
 *  seen first (the store's own ordering, re-sorted defensively so a
 *  backend without the ordering contract still answers --last right). */
async function resumeRows(
  deps: SessionsResumeDeps
): Promise<{ rows: MsgSessionRow[]; warnings: string[] }> {
  const dir = deps.dir ?? process.cwd();
  let ledger = deps.ledger;
  if (ledger === undefined) {
    const prefer = loadConfig(dir).connectors;
    ledger = facade('ledger', { dir }, prefer === undefined ? {} : { prefer });
  }
  const res = await sessionMsgRows(ledger, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.bootTimeMs !== undefined ? { bootTimeMs: deps.bootTimeMs } : {}),
  });
  res.rows.sort((a, b) => b.lastSeen - a.lastSeen);
  return res;
}

/** One-based picker answer → zero-based index, or null on junk. Each
 *  rejection is its own check — a compound condition reads as one
 *  dense branch and hides which rule refused. */
function pickIndex(answer: string, count: number): number | null {
  const n = Number(answer.trim());
  if (!Number.isInteger(n)) {
    return null;
  }
  if (n < 1) {
    return null;
  }
  if (n > count) {
    return null;
  }
  return n - 1;
}

/** The --pick flow — numbered list, one line back. Injectable for
 *  tests; production reads process.stdin through readline. */
async function pickSession(rows: MsgSessionRow[]): Promise<number | null> {
  const out = (line: string) => console.log(line);
  out('sessions (newest first):');
  rows.forEach((r, i) => {
    out(
      `  ${String(i + 1).padStart(3)}  ${r.host}:${shortSid(r.sid)}  [${r.state}]  ${r.cwd ?? '—'}`
    );
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => {
      rl.question('resume> ', resolve);
    });
    return pickIndex(answer, rows.length);
  } finally {
    rl.close();
  }
}

/** Spawn the resume argv — stdio inherited so the host CLI owns the
 *  terminal; resolves with the child's exit code. */
function spawnResume(argv: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: 'inherit',
      cwd,
    });
    child.on('error', err => {
      reject(
        new CommandError(
          `error: cannot launch ${argv[0]} — ${err instanceof Error ? err.message : String(err)}`,
          EXIT.error
        )
      );
    });
    child.on('exit', code => resolve(code ?? 1));
  });
}

/** The <id> leg — the shared fleet grammar narrowed to exactly one
 *  session. Ambiguity and zero-match are usage errors, never guesses. */
function resumeById(rows: MsgSessionRow[], id: string): MsgSessionRow {
  const resolution = resolveMsgTarget(rows, id);
  if (resolution.error !== undefined) {
    throw new CommandError(`error: ${resolution.error}`, EXIT.usage);
  }
  const matched = resolution.deliveries
    .map(d => d.session)
    .filter((s): s is MsgSessionRow => s !== undefined);
  const distinct = new Map(matched.map(s => [`${s.host}:${s.sid}`, s]));
  if (distinct.size === 0) {
    throw new CommandError(
      `error: no ledger session matches "${id}" — the session may not be wired yet`,
      EXIT.usage
    );
  }
  if (distinct.size > 1) {
    const list = [...distinct.keys()].join(', ');
    throw new CommandError(
      `error: "${id}" resolves to ${distinct.size} sessions (${list}) — name one with <host>:<sid>`,
      EXIT.usage
    );
  }
  return [...distinct.values()][0];
}

/** The --pick leg — TTY gate, then the picker. A cancelled picker and
 *  an injected pick answering out of range are the same outcome: no
 *  session to resume. */
async function resumeByPick(
  rows: MsgSessionRow[],
  deps: SessionsResumeDeps,
  out: (line: string) => void
): Promise<MsgSessionRow | null> {
  const tty = deps.stdinTTY ?? process.stdin.isTTY === true;
  if (!tty) {
    throw new CommandError('error: --pick needs an interactive terminal', EXIT.usage);
  }
  const pick = deps.pick ?? pickSession;
  const idx = await pick(rows);
  const picked = idx === null ? undefined : rows[idx];
  if (picked === undefined) {
    out('resume: cancelled');
    return null;
  }
  return picked;
}

/** Which session the invocation names — --last (rows arrive
 *  lastSeen-desc), --pick (TTY picker), or the shared fleet grammar.
 *  Every path yields exactly one row or throws a usage error; null
 *  means the user cancelled the picker. */
async function resumeTarget(
  args: { last: boolean; pick: boolean; id?: string },
  rows: MsgSessionRow[],
  deps: SessionsResumeDeps,
  out: (line: string) => void
): Promise<MsgSessionRow | null> {
  if (args.last) {
    // rows arrive lastSeen-desc from the store — the first is "last"
    // (the caller already refused an empty list)
    return rows[0];
  }
  if (args.pick) {
    return resumeByPick(rows, deps, out);
  }
  return resumeById(rows, args.id!);
}

/** Everything resumeTarget's caller already resolved — kept as one
 *  bag so launch helpers stay under the argument-count threshold. */
interface ResumeCtx {
  deps: SessionsResumeDeps;
  dir: string;
  out: (line: string) => void;
}

/** Render and launch the resume — --print short-circuits before any
 *  spawn; an unsupported host reports instead of guessing. */
async function launchResume(
  session: MsgSessionRow,
  args: { print: boolean },
  ctx: ResumeCtx
): Promise<void> {
  const cwd = session.cwd ?? ctx.dir;
  const resumeArgv = sessionResumeArgv(session.host, session.sid, cwd);
  const stateNote = ` [${session.state}]`;
  if (resumeArgv === null) {
    // report, never guess — the spec's unsupported-host contract
    ctx.out(
      `resume: host '${session.host}' has no resume command — ` +
        `${session.host}:${shortSid(session.sid)}${stateNote} (${cwd})`
    );
    return;
  }
  const cmdline = resumeArgv.join(' ');
  if (args.print) {
    ctx.out(
      `resume: ${session.host}:${shortSid(session.sid)}${stateNote} — ${cmdline}  (cwd: ${cwd})`
    );
    return;
  }
  ctx.out(`resume: ${session.host}:${shortSid(session.sid)}${stateNote} — ${cmdline}`);
  const spawnFn = ctx.deps.spawn ?? spawnResume;
  const code = await spawnFn(resumeArgv, cwd);
  if (code !== 0) {
    throw new CommandError(`error: resume exited ${code}`, EXIT.error);
  }
}

export async function runSessionsResume(
  argv: string[],
  deps: SessionsResumeDeps = {}
): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  const args = resumeArgs(argv);
  const dir = deps.dir ?? process.cwd();
  const out = deps.out ?? ((line: string) => console.log(line));
  const { rows, warnings } = await resumeRows(deps);
  for (const w of warnings) {
    console.error(`warning: ${w}`);
  }
  if (rows.length === 0) {
    throw new CommandError('error: no sessions in the ledger', EXIT.error);
  }

  const session = await resumeTarget(args, rows, deps, out);
  if (session === null) {
    return;
  }
  await launchResume(session, args, { deps, dir, out });
}
