/**
 * `bro sessions` — every agent session on the machine, read from the
 * session ledger (epic spec specs/sessions/bro-izpyk.md "Sessions and
 * resume"; impl spec specs/bro-izpyk.1.2.md).
 *
 *   bro sessions                 all sessions, most recently seen first
 *   bro sessions --project       only sessions of the current project
 *   bro sessions --host claude   one host
 *   bro sessions --live          only sessions live now (derived state)
 *   bro sessions --json          the same rows, machine-readable
 *
 * The ledger (`facade('ledger')`) drains pending spool rows on every
 * read, so the listing is always fresh — no worker tick, no lock. The
 * command is read-only: `resume` is F4 (bro-izpyk.4) scope and is NOT
 * implemented here.
 *
 * Two fields are resolved client-side because the ledger does not (and
 * must not — the write path is F1a's) carry them:
 *
 *  - state: the store only writes `live`; `interrupted` is derived at
 *    read time per the epic rule — a session whose last event predates
 *    this boot cannot be live (`os.uptime`, no /proc parsing).
 *  - bead: the spool carries no bead id. The honest binding that exists
 *    today is the agent registry — a bro-spawned session's `spawnedBy`
 *    is its agentId and `<git-common>/bro/agents.json` maps
 *    `molStep → { agentId }`, where molStep IS the bead/step id.
 *    Interactive sessions and unresolvable lookups render `—`.
 */
import { homedir, uptime } from 'node:os';
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  printUsage,
  readAgentRegistry,
  sessionProject,
  type LedgerFacade,
  type Mode,
  type SessionRow,
  type SessionState,
} from '@broject/core';
import { flag, positionals } from './args.ts';
import { loadBroConfig } from '../plugins.ts';

const USAGE = `usage: bro sessions [--project|--all] [--host <h>] [--live] [--json]

  --project    only sessions of the current project (worktrees fold in)
  --all        every session on the machine — the default
  --host <h>   only sessions of this host (claude, codex, devin, …)
  --live       only sessions whose derived state is live
  --json       {sessions, warnings} — epoch-ms times, full sids

State is derived at read time: a session last seen before this boot is
'interrupted'; the ledger itself only records 'live' today. The bead
column resolves bro-spawned agents through the per-project agent
registry — interactive sessions show —.`;

export interface SessionsArgs {
  project: boolean;
  all: boolean;
  host?: string;
  live: boolean;
  json: boolean;
}

/** Parsed sessions flags. `--project` and `--all` are mutually exclusive
 *  spellings of the scope choice (all is the default); strict positional
 *  parsing rejects unknown flags and stray positionals as usage errors. */
export function sessionsArgs(argv: string[]): SessionsArgs {
  const rest = positionals(argv, new Set(['--host']), {
    boolFlags: new Set(['--project', '--all', '--live', '--json']),
    strict: true,
  });
  if (rest.length > 0) {
    throw new CommandError(`error: unexpected argument "${rest[0]}"\n${USAGE}`, EXIT.usage);
  }
  const project = argv.includes('--project');
  const all = argv.includes('--all');
  if (project && all) {
    throw new CommandError('error: --project and --all are mutually exclusive', EXIT.usage);
  }
  const host = flag(argv, '--host');
  if (host !== undefined && host.trim() === '') {
    throw new CommandError('error: --host requires a non-empty value', EXIT.usage);
  }
  return { project, all, host, live: argv.includes('--live'), json: argv.includes('--json') };
}

/** Boot time in epoch ms — `os.uptime()` is seconds since boot, so this
 *  needs no /proc parsing and works on every platform Node runs on. */
export function sessionBootTimeMs(now: number = Date.now(), upSeconds: number = uptime()): number {
  return now - upSeconds * 1000;
}

/** The epic spec's read-time rule: a session whose last event predates
 *  this boot cannot be live — it is `interrupted`. Stored non-live states
 *  (`ended`, `idle`, a future `interrupted`) pass through untouched — a
 *  writer's verdict is never re-derived. */
export function deriveSessionState(row: SessionRow, bootTimeMs: number): SessionState {
  if (row.state === 'live' && row.lastSeen < bootTimeMs) {
    return 'interrupted';
  }
  return row.state;
}

/** Compact relative age for table cells — "45s", "12m", "3h", "2d",
 *  "5mo". Single-unit floor: the --json payload carries exact epoch ms,
 *  the table is a glance surface. */
export function fmtAge(ms: number | null, now: number): string {
  if (ms === null) {
    return '—';
  }
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  if (d < 60) {
    return `${d}d`;
  }
  return `${Math.floor(d / 30)}mo`;
}

/** `~`-collapsed cwd for display — the full path stays in --json. */
export function displayWorktree(cwd: string | null): string {
  if (cwd === null || cwd === '') {
    return '—';
  }
  const home = homedir();
  if (cwd === home) {
    return '~';
  }
  if (cwd.startsWith(`${home}/`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function shortSid(sid: string): string {
  return sid.length > 12 ? `${sid.slice(0, 12)}…` : sid;
}

/** One rendered session — the SessionRow fields plus the two
 *  client-resolved columns (`state` derived, `bead`). */
export interface SessionViewRow {
  host: string;
  sid: string;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  mode: Mode;
  /** Derived display state — see deriveSessionState. */
  state: SessionState;
  pid: number | null;
  pidStart: string | null;
  started: number | null;
  lastSeen: number;
  spawnedBy: string | null;
  /** Resolved molStep/bead for bro-spawned sessions; undefined → `—`. */
  bead?: string;
}

export interface SessionViews {
  rows: SessionViewRow[];
  warnings: string[];
}

/** The project's agent registry, read once per unique cwd — a fleet of
 *  sessions in one repo pays a single git probe + agents.json parse.
 *  undefined = unresolvable (not a git repo, deleted worktree); a thrown
 *  read is a warning, never silent. */
function registryForCwd(
  cwd: string,
  cache: Map<string, ReturnType<typeof readAgentRegistry> | undefined>,
  warnings: string[]
): ReturnType<typeof readAgentRegistry> | undefined {
  if (cache.has(cwd)) {
    return cache.get(cwd);
  }
  let reg: ReturnType<typeof readAgentRegistry> | undefined;
  try {
    reg = readAgentRegistry(cwd);
  } catch (err) {
    warnings.push(
      `agent registry unreadable for ${cwd} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  cache.set(cwd, reg);
  return reg;
}

/** Bead resolver shared across a collect pass — agentId → molStep over
 *  the session cwd's agent registry. Every failure mode (not a git repo,
 *  deleted worktree, no match) is undefined — a missing bead is a
 *  missing fact, not a fault. */
export function beadResolver(warnings: string[] = []): (row: SessionRow) => string | undefined {
  const cache = new Map<string, ReturnType<typeof readAgentRegistry> | undefined>();
  return row => {
    if (row.spawnedBy === null || row.spawnedBy === '' || row.cwd === null || row.cwd === '') {
      return undefined;
    }
    const reg = registryForCwd(row.cwd as string, cache, warnings);
    if (reg === undefined) {
      return undefined;
    }
    for (const [step, entry] of Object.entries(reg)) {
      if (entry.agentId === row.spawnedBy) {
        return step;
      }
    }
    return undefined;
  };
}

export interface CollectSessionsOpts {
  /** Resolved project id — the --project filter. */
  project?: string;
  host?: string;
  /** Keep only derived-live sessions (--live). */
  live?: boolean;
  now?: number;
  bootTimeMs?: number;
  beadFor?: (row: SessionRow) => string | undefined;
}

/** Ledger rows → view rows: derived state, resolved bead, --live filter.
 *  The store already orders by last_seen DESC — the listing keeps that
 *  order (most recently active first). */
export async function collectSessionViews(
  ledger: LedgerFacade,
  opts: CollectSessionsOpts = {}
): Promise<SessionViews> {
  const now = opts.now ?? Date.now();
  const boot = opts.bootTimeMs ?? sessionBootTimeMs(now);
  const warnings: string[] = [];
  const beadFor = opts.beadFor ?? beadResolver(warnings);
  const stored = await ledger.sessions({
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  });
  const rows: SessionViewRow[] = [];
  for (const s of stored) {
    const state = deriveSessionState(s, boot);
    if (opts.live === true && state !== 'live') {
      continue;
    }
    const bead = beadFor(s);
    rows.push({
      host: s.host,
      sid: s.sid,
      project: s.project,
      cwd: s.cwd,
      branch: s.branch,
      mode: s.mode,
      state,
      pid: s.pid,
      pidStart: s.pidStart,
      started: s.started,
      lastSeen: s.lastSeen,
      spawnedBy: s.spawnedBy,
      ...(bead !== undefined ? { bead } : {}),
    });
  }
  return { rows, warnings };
}

/** The --json row — every SessionRow field (state already derived) plus
 *  the resolved bead. Times stay epoch ms: the ledger's native unit. */
export function sessionJsonRow(r: SessionViewRow): Record<string, unknown> {
  return {
    host: r.host,
    sid: r.sid,
    project: r.project,
    cwd: r.cwd,
    branch: r.branch,
    mode: r.mode,
    state: r.state,
    pid: r.pid,
    pidStart: r.pidStart,
    started: r.started,
    lastSeen: r.lastSeen,
    spawnedBy: r.spawnedBy,
    bead: r.bead ?? null,
  };
}

/** Table lines — padded columns, `—` for absent facts. Exported pure so
 *  tests see exactly what the TTY gets. */
export function sessionTableLines(rows: SessionViewRow[], now: number): string[] {
  const cols: [keyof SessionViewRow | 'worktree' | 'agent' | 'seen' | 'startedAge', string][] = [
    ['host', 'HOST'],
    ['sid', 'SID'],
    ['state', 'STATE'],
    ['mode', 'MODE'],
    ['agent', 'AGENT'],
    ['bead', 'BEAD'],
    ['worktree', 'WORKTREE'],
    ['branch', 'BRANCH'],
    ['startedAge', 'STARTED'],
    ['seen', 'SEEN'],
  ];
  const cell = (r: SessionViewRow, k: string): string => {
    switch (k) {
      case 'sid':
        return shortSid(r.sid);
      case 'agent':
        return r.spawnedBy ?? '—';
      case 'bead':
        return r.bead ?? '—';
      case 'worktree':
        return displayWorktree(r.cwd);
      case 'branch':
        return r.branch ?? '—';
      case 'startedAge':
        return fmtAge(r.started, now);
      case 'seen':
        return fmtAge(r.lastSeen, now);
      default: {
        const v = r[k as keyof SessionViewRow];
        return v === null || v === undefined || v === '' ? '—' : String(v);
      }
    }
  };
  const cells = rows.map(r => cols.map(([k]) => cell(r, k)));
  const widths = cols.map(([, h], i) => Math.max(h.length, ...cells.map(c => c[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(cols.map(([, h]) => h)), ...cells.map(c => line(c))];
}

export interface SessionsDeps {
  dir?: string;
  ledger?: LedgerFacade;
  now?: number;
  bootTimeMs?: number;
  beadFor?: (row: SessionRow) => string | undefined;
}

/** Resolve the ledger facade — injectable for tests; production goes
 *  through facade() so a `connectors.ledger` pin is honored. */
function sessionsLedger(dir: string, deps: SessionsDeps): LedgerFacade {
  if (deps.ledger !== undefined) {
    return deps.ledger;
  }
  const prefer = loadBroConfig(dir).connectors;
  return facade('ledger', { dir }, prefer === undefined ? {} : { prefer });
}

export async function runSessionsCommand(argv: string[], deps: SessionsDeps = {}): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  const args = sessionsArgs(argv);
  const dir = deps.dir ?? process.cwd();
  // --project resolves through the same identity ingest uses — worktrees
  // of one repo fold into a single project id. An unresolvable project
  // (deleted cwd, no git+no realpath) matches nothing, never "all".
  let project: string | undefined;
  if (args.project) {
    project = sessionProject(dir);
    if (project === undefined) {
      if (args.json) {
        console.log(JSON.stringify({ sessions: [], warnings: ['project unresolvable'] }, null, 2));
      } else {
        console.log('no sessions in this project');
      }
      return;
    }
  }
  const ledger = sessionsLedger(dir, deps);
  let views: SessionViews;
  try {
    views = await collectSessionViews(ledger, {
      ...(project !== undefined ? { project } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
      ...(args.live ? { live: true } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.bootTimeMs !== undefined ? { bootTimeMs: deps.bootTimeMs } : {}),
      ...(deps.beadFor !== undefined ? { beadFor: deps.beadFor } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(`error: ledger unavailable — ${msg}`, EXIT.error);
  }
  const now = deps.now ?? Date.now();
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          sessions: views.rows.map(sessionJsonRow),
          warnings: views.warnings,
        },
        null,
        2
      )
    );
    return;
  }
  if (views.rows.length === 0) {
    console.log(args.live ? 'no live sessions' : 'no sessions recorded');
  } else {
    for (const line of sessionTableLines(views.rows, now)) {
      console.log(line);
    }
  }
  for (const w of views.warnings) {
    console.error(`warning: ${w}`);
  }
}
