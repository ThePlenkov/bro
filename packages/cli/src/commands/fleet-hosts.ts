/**
 * `bro fleet hosts` — the hosts × installs board over the session
 * ledger (epic spec specs/sessions/bro-izpyk.md "Visibility"; impl spec
 * specs/bro-izpyk.1.2.md). Distinct from `bro fleet` itself, which is
 * the spawned-agents board (mols × steps × worktrees × PRs): this view
 * answers "which agent hosts is bro wired into, are their hooks firing,
 * and how do sessions distribute across projects" — machine-wide, from
 * `installs()` + `sessions()` + `stats()`.
 *
 *   bro fleet hosts           hosts table + sessions-per-project
 *   bro fleet hosts --json    {hosts, projects, generatedAt}
 *
 * Honest limitation, stated in the footer: the installs table learns a
 * host BY firing — a wired-but-never-fired install is invisible to the
 * ledger. "Installed but silent" detection is doctor scope
 * (bro-izpyk.1.3), not this board's.
 */
import { basename } from 'node:path';
import {
  CommandError,
  EXIT,
  facade,
  hasHelpFlag,
  printUsage,
  type HookStat,
  type InstallRow,
  type LedgerFacade,
  type SessionRow,
} from '@broject/core';
import { loadBroConfig } from '../plugins.ts';
import { deriveSessionState, fmtAge, sessionBootTimeMs } from './sessions.ts';

const USAGE = `usage: bro fleet hosts [--json]

  hosts × installs over the session ledger — adapter version, plugin
  roots, last firing, firing|quiet|silent status, session and hook-event
  counts, worst p95, timeouts, errors, last error day; then sessions
  grouped per project. Read-only; the ledger drains pending spool rows
  on read.`;

/** Recency buckets on the host's last-seen timestamp — a glance
 *  surface, not a monitor: firing = seen in the last day, quiet = last
 *  week, silent = older (or never). */
export const HOST_FIRING_MS = 24 * 60 * 60 * 1000;
export const HOST_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

export type HostStatus = 'firing' | 'quiet' | 'silent';

export function hostStatusFor(lastSeen: number, now: number): HostStatus {
  const age = now - lastSeen;
  if (age < HOST_FIRING_MS) {
    return 'firing';
  }
  if (age < HOST_QUIET_MS) {
    return 'quiet';
  }
  return 'silent';
}

export interface FleetHostRow {
  host: string;
  /** adapterVersion of the most recently seen install row. */
  adapter?: string;
  /** Distinct plugin roots bro is wired through for this host. */
  pluginRoots: string[];
  firstSeen: number;
  /** Max last-seen across installs, sessions and stats days. */
  lastSeen: number;
  status: HostStatus;
  sessions: number;
  liveSessions: number;
  /** Summed hook events over retained daily stats. */
  events: number;
  /** Worst daily p95 across the host's event rows (ms). */
  p95?: number;
  timeouts: number;
  errors: number;
  /** Most recent UTC day with errors > 0. */
  lastErrorDay?: string;
}

export interface FleetProjectRow {
  /** Ledger project id; null when the session carried none. */
  project: string | null;
  /** basename of the group's most recently seen cwd (`—` when none). */
  label: string;
  sessions: number;
  liveSessions: number;
  hosts: string[];
}

export interface FleetHostsPayload {
  hosts: FleetHostRow[];
  projects: FleetProjectRow[];
  generatedAt: number;
  warnings: string[];
}

interface HostAcc {
  host: string;
  adapter?: string;
  adapterSeen: number;
  roots: Set<string>;
  firstSeen: number;
  lastSeen: number;
  sessions: number;
  liveSessions: number;
  events: number;
  p95?: number;
  timeouts: number;
  errors: number;
  lastErrorDay?: string;
}

function accFor(map: Map<string, HostAcc>, host: string): HostAcc {
  let a = map.get(host);
  if (a === undefined) {
    a = {
      host,
      adapterSeen: -1,
      roots: new Set<string>(),
      firstSeen: Number.POSITIVE_INFINITY,
      lastSeen: 0,
      sessions: 0,
      liveSessions: 0,
      events: 0,
      timeouts: 0,
      errors: 0,
    };
    map.set(host, a);
  }
  return a;
}

function foldInstalls(map: Map<string, HostAcc>, installs: InstallRow[]): void {
  for (const i of installs) {
    const a = accFor(map, i.host);
    if (i.pluginRoot !== null && i.pluginRoot !== '') {
      a.roots.add(i.pluginRoot);
    }
    a.firstSeen = Math.min(a.firstSeen, i.firstSeen);
    a.lastSeen = Math.max(a.lastSeen, i.lastSeen);
    // the freshest install row owns the adapter version — a stale root's
    // older version must not overwrite what fired last, and a freshest
    // row that reports NO version clears it rather than borrowing the
    // stale root's (the board attributes the newest install's truth)
    if (i.lastSeen >= a.adapterSeen) {
      a.adapterSeen = i.lastSeen;
      if (i.adapterVersion === null) {
        delete a.adapter;
      } else {
        a.adapter = i.adapterVersion;
      }
    }
  }
}

function foldSessions(map: Map<string, HostAcc>, sessions: SessionRow[], boot: number): void {
  for (const s of sessions) {
    const a = accFor(map, s.host);
    a.sessions += 1;
    if (deriveSessionState(s, boot) === 'live') {
      a.liveSessions += 1;
    }
    a.lastSeen = Math.max(a.lastSeen, s.lastSeen);
  }
}

/** A stats day is day-granular — the latest possible instant on that UTC
 *  day stands in for last-seen (installs/sessions carry exact ms and
 *  almost always dominate; this only matters for append()-fed hosts).
 *  The stand-in is clamped at `now`: a stats row for the CURRENT day
 *  would otherwise date the host into the future and print "0s". */
function statDayEndMs(day: string, now: number): number {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(t) ? Math.min(t + 86_400_000 - 1, now) : 0;
}

function foldStats(map: Map<string, HostAcc>, stats: HookStat[], now: number): void {
  for (const st of stats) {
    const a = accFor(map, st.host);
    a.events += st.n;
    a.timeouts += st.timeouts;
    a.errors += st.errors;
    if (st.p95 !== null && (a.p95 === undefined || st.p95 > a.p95)) {
      a.p95 = st.p95;
    }
    if (st.errors > 0 && (a.lastErrorDay === undefined || st.day > a.lastErrorDay)) {
      a.lastErrorDay = st.day;
    }
    a.lastSeen = Math.max(a.lastSeen, statDayEndMs(st.day, now));
  }
}

function hostRow(a: HostAcc, now: number): FleetHostRow {
  return {
    host: a.host,
    ...(a.adapter !== undefined ? { adapter: a.adapter } : {}),
    pluginRoots: [...a.roots].sort(),
    firstSeen: a.firstSeen === Number.POSITIVE_INFINITY ? 0 : a.firstSeen,
    lastSeen: a.lastSeen,
    status: hostStatusFor(a.lastSeen, now),
    sessions: a.sessions,
    liveSessions: a.liveSessions,
    events: a.events,
    ...(a.p95 !== undefined ? { p95: a.p95 } : {}),
    timeouts: a.timeouts,
    errors: a.errors,
    ...(a.lastErrorDay !== undefined ? { lastErrorDay: a.lastErrorDay } : {}),
  };
}

interface ProjectAcc {
  project: string | null;
  cwd?: string;
  lastSeen: number;
  sessions: number;
  liveSessions: number;
  hosts: Set<string>;
}

/** Sessions grouped by ledger project id; a null project falls back to
 *  grouping by its own cwd (unknown project, known location), and a
 *  session with neither lands in one `—` bucket. The no-project key is
 *  NUL-prefixed — a ledger project id can never contain NUL, so the
 *  sentinel can never collide with a real `"none"` project. */
function foldProjects(sessions: SessionRow[], boot: number): Map<string, ProjectAcc> {
  const byProject = new Map<string, ProjectAcc>();
  for (const s of sessions) {
    const key = s.project ?? (s.cwd !== null && s.cwd !== '' ? `cwd:${s.cwd}` : '\0none');
    let p = byProject.get(key);
    if (p === undefined) {
      p = {
        project: s.project,
        sessions: 0,
        liveSessions: 0,
        hosts: new Set<string>(),
        lastSeen: 0,
      };
      byProject.set(key, p);
    }
    p.sessions += 1;
    if (deriveSessionState(s, boot) === 'live') {
      p.liveSessions += 1;
    }
    p.hosts.add(s.host);
    if (s.lastSeen >= p.lastSeen) {
      p.lastSeen = s.lastSeen;
      if (s.cwd !== null && s.cwd !== '') {
        p.cwd = s.cwd;
      }
    }
  }
  return byProject;
}

function projectRow(key: string, p: ProjectAcc): FleetProjectRow {
  const label =
    p.cwd !== undefined
      ? `${basename(p.cwd)}${p.project !== null ? ` (${p.project.slice(0, 8)})` : ''}`
      : p.project !== null
        ? p.project.slice(0, 8)
        : '—';
  return {
    project: p.project,
    label: key === '\0none' ? '—' : label,
    sessions: p.sessions,
    liveSessions: p.liveSessions,
    hosts: [...p.hosts].sort(),
  };
}

/** Ledger reads → board rows. Exported for tests; the command wraps it
 *  with facade resolution and rendering. */
export async function collectFleetHosts(
  ledger: LedgerFacade,
  opts: { now?: number; bootTimeMs?: number } = {}
): Promise<FleetHostsPayload> {
  const now = opts.now ?? Date.now();
  const boot = opts.bootTimeMs ?? sessionBootTimeMs(now);
  const [installs, sessions, stats] = await Promise.all([
    ledger.installs(),
    ledger.sessions(),
    ledger.stats(),
  ]);
  // a failed opportunistic drain still answers — but the board may be
  // stale, and the read surface says so rather than implying freshness
  const drain = ledger.drainWarning?.();
  const warnings =
    drain === undefined ? [] : [`spool drain failed — the board may be stale (${drain})`];
  const acc = new Map<string, HostAcc>();
  foldInstalls(acc, installs);
  foldSessions(acc, sessions, boot);
  foldStats(acc, stats, now);
  const hosts = [...acc.values()]
    .map(a => hostRow(a, now))
    .sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host));
  const projects = [...foldProjects(sessions, boot).entries()]
    .map(([key, p]) => projectRow(key, p))
    .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
  return { hosts, projects, generatedAt: now, warnings };
}

function fmtCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tableLines(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(r => line(r))];
}

/** Human rendering — hosts table, then sessions-per-project. Exported
 *  pure for tests. */
export function fleetHostsLines(payload: FleetHostsPayload, now: number): string[] {
  const lines: string[] = [];
  if (payload.hosts.length === 0) {
    lines.push('no hosts in the ledger — nothing has fired a bro hook yet');
  } else {
    lines.push('hosts (ledger — hosts that have fired at least once)');
    lines.push(
      ...tableLines(
        [
          'HOST',
          'ADAPTER',
          'ROOTS',
          'SEEN',
          'STATUS',
          'SESSIONS',
          'EVENTS',
          'P95',
          'TIMEOUTS',
          'ERRORS',
          'LAST ERROR',
        ],
        payload.hosts.map(h => [
          h.host,
          h.adapter ?? '—',
          String(h.pluginRoots.length),
          fmtAge(h.lastSeen, now),
          h.status,
          `${h.sessions} (${h.liveSessions} live)`,
          fmtCount(h.events),
          fmtMs(h.p95),
          String(h.timeouts),
          String(h.errors),
          h.lastErrorDay ?? '—',
        ])
      )
    );
  }
  lines.push('');
  if (payload.projects.length === 0) {
    lines.push('no sessions in the ledger');
  } else {
    lines.push('sessions per project');
    lines.push(
      ...tableLines(
        ['PROJECT', 'SESSIONS', 'LIVE', 'HOSTS'],
        payload.projects.map(p => [
          p.label,
          String(p.sessions),
          String(p.liveSessions),
          p.hosts.join(', '),
        ])
      )
    );
  }
  return lines;
}

export interface FleetHostsDeps {
  dir?: string;
  ledger?: LedgerFacade;
  now?: number;
  bootTimeMs?: number;
}

function hostsLedger(dir: string, deps: FleetHostsDeps): LedgerFacade {
  if (deps.ledger !== undefined) {
    return deps.ledger;
  }
  const prefer = loadBroConfig(dir).connectors;
  return facade('ledger', { dir }, prefer === undefined ? {} : { prefer });
}

export async function runFleetHostsCommand(
  dir: string,
  argv: string[],
  deps: FleetHostsDeps = {}
): Promise<void> {
  if (hasHelpFlag(argv)) {
    printUsage(USAGE, EXIT.ok);
  }
  // strict: --json is the only flag; no positionals exist on this verb
  const rest = argv.filter(a => a !== '--json' && a !== '--help' && a !== '-h');
  if (rest.length > 0) {
    throw new CommandError(`error: unexpected argument "${rest[0]}"\n${USAGE}`, EXIT.usage);
  }
  const json = argv.includes('--json');
  const ledger = hostsLedger(dir, deps);
  let payload: FleetHostsPayload;
  try {
    payload = await collectFleetHosts(ledger, {
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.bootTimeMs !== undefined ? { bootTimeMs: deps.bootTimeMs } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(`error: ledger unavailable — ${msg}`, EXIT.error);
  }
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const now = deps.now ?? Date.now();
  for (const line of fleetHostsLines(payload, now)) {
    console.log(line);
  }
  console.error(
    'note: the ledger sees only hosts that have fired — a wired-but-never-fired install is invisible here (doctor owns installed-but-silent, bro-izpyk.1.3)'
  );
}
