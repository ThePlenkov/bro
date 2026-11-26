/**
 * Read-only Devin account diagnostics.  This deliberately lives in the
 * provider facade: the core can ask a provider for visibility without
 * learning that provider's process, sqlite, or journal formats.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devinLocksDir, devinPidCwd, devinPidIsOwned, listDevinSessions } from './plane.ts';
import { devinStorePath } from './usage.ts';

export interface DevinConsumer {
  pid: number;
  command: string;
  cwd?: string;
  managed: boolean;
  sessionLocks: string[];
}

export interface DevinAccountDiagnostic {
  consumers: DevinConsumer[];
  managed: number;
  unmanaged: number;
  ok: boolean;
  warnings: string[];
}

export interface DevinRateLimitHit {
  rowId?: number;
  sessionId?: string;
  model?: string;
  timestamp?: string;
  message: string;
}

export interface DevinServeTurnSummary {
  turns: number;
  spawns: number;
  deadloops: number;
  rateLimits: number;
}

export interface DevinRateLimitDiagnostic {
  lastLock?: DevinRateLimitHit;
  hits: DevinRateLimitHit[];
  activeSessions: ReturnType<typeof listDevinSessions>;
  consumers: DevinAccountDiagnostic;
  serveTurns: DevinServeTurnSummary;
  ok: boolean;
  warnings: string[];
}

export interface DevinDiagnosticOptions {
  env?: Record<string, string | undefined>;
  procDir?: string;
  locksDir?: string;
  storePath?: string;
  serveTurnsPath?: string;
  limit?: number;
}

const field = (row: Record<string, unknown>, name: string): unknown =>
  Object.getOwnPropertyDescriptor(row, name)?.value;

function processCommand(procDir: string, pid: number): string | undefined {
  try {
    return readFileSync(join(procDir, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(Boolean)
      .join(' ');
  } catch {
    return undefined;
  }
}

function lockNamesByPid(dir: string): Map<number, string[]> {
  const result = new Map<number, string[]>();
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.lock'));
  } catch {
    return result;
  }
  for (const name of names) {
    try {
      const pid = Number.parseInt(readFileSync(join(dir, name), 'utf8').trim(), 10);
      if (!Number.isInteger(pid)) continue;
      const namesForPid = result.get(pid) ?? [];
      namesForPid.push(name.slice(0, -5));
      result.set(pid, namesForPid);
    } catch {
      // A lock disappearing during a diagnostic is not a diagnostic failure.
    }
  }
  return result;
}

/** Count every live Devin process, including interactive `devin -r` and
 * ad-hoc `devin acp` processes which never carry a bro worker badge. */
export function inspectDevinAccount(options: DevinDiagnosticOptions = {}): DevinAccountDiagnostic {
  const procDir = options.procDir ?? '/proc';
  const locksDir = options.locksDir ?? devinLocksDir({}, options.env);
  const locks = lockNamesByPid(locksDir);
  const consumers: DevinConsumer[] = [];
  let pids: string[];
  try {
    pids = readdirSync(procDir);
  } catch {
    return {
      consumers: [],
      managed: 0,
      unmanaged: 0,
      ok: false,
      warnings: [`cannot read ${procDir}`],
    };
  }
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const command = processCommand(procDir, pid);
    if (command === undefined || !/(^|\/)devin(?:\0|\s|$)/.test(command)) continue;
    const managed = devinPidIsOwned(pid, procDir);
    consumers.push({
      pid,
      command,
      cwd: devinPidCwd(pid, procDir),
      managed,
      sessionLocks: locks.get(pid) ?? [],
    });
  }
  consumers.sort((a, b) => a.pid - b.pid);
  const managed = consumers.filter(consumer => consumer.managed).length;
  return { consumers, managed, unmanaged: consumers.length - managed, ok: true, warnings: [] };
}

type Sqlite = {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
};

async function openStore(path: string): Promise<Sqlite | undefined> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Sqlite;
    };
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(strings);
}

function parseHit(row: Record<string, unknown>): DevinRateLimitHit | undefined {
  const raw = strings(row).find(value => /reached free model rate limit|rate limit/i.test(value));
  if (raw === undefined) return undefined;
  const sessionId = field(row, 'session_id') ?? field(row, 'sessionId');
  const model = field(row, 'model');
  const timestamp = field(row, 'created_at') ?? field(row, 'timestamp') ?? field(row, 'updated_at');
  const rowId = field(row, 'row_id');
  return {
    rowId: typeof rowId === 'number' ? rowId : undefined,
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    model: typeof model === 'string' ? model : undefined,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    message: raw,
  };
}

async function rateLimitHits(
  path: string,
  limit: number
): Promise<{ hits: DevinRateLimitHit[]; ok: boolean }> {
  const db = await openStore(path);
  if (db === undefined) return { hits: [], ok: false };
  try {
    const rows = db
      .prepare(
        `SELECT m.row_id, m.session_id, s.model, m.chat_message
         FROM message_nodes m LEFT JOIN sessions s ON s.id = m.session_id
         ORDER BY row_id DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    const hits = rows.flatMap(row => {
      const message = field(row, 'chat_message');
      let parsed: unknown = row;
      if (typeof message === 'string') {
        try {
          const parsedMessage = JSON.parse(message) as Record<string, unknown>;
          const { chat_message: _chatMessage, ...rowWithoutMessage } = row;
          parsed = { ...rowWithoutMessage, ...parsedMessage };
        } catch {
          /* keep row */
        }
      }
      const hit = parseHit(parsed as Record<string, unknown>);
      return hit === undefined ? [] : [hit];
    });
    return { hits, ok: true };
  } catch {
    return { hits: [], ok: false };
  } finally {
    db.close();
  }
}

function serveSummary(path: string | undefined): { summary: DevinServeTurnSummary; ok: boolean } {
  const summary: DevinServeTurnSummary = { turns: 0, spawns: 0, deadloops: 0, rateLimits: 0 };
  if (path === undefined) return { summary, ok: true };
  try {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const event = String(field(row, 'event') ?? '').toLowerCase();
      summary.turns += event.includes('turn') ? 1 : 0;
      summary.spawns += event.includes('spawn') ? 1 : 0;
      summary.deadloops += event.includes('deadloop') ? 1 : 0;
      summary.rateLimits += event.includes('429') || event.includes('rate_limit') ? 1 : 0;
    }
    return { summary, ok: true };
  } catch {
    return { summary, ok: false };
  }
}

/** Reconstruct the last lock from the store, live locks/processes, and the
 * serve journal. Every source is best-effort and never mutates host state. */
export async function diagnoseDevinRateLimit(
  options: DevinDiagnosticOptions = {}
): Promise<DevinRateLimitDiagnostic> {
  const warnings: string[] = [];
  const hitsResult = await rateLimitHits(
    options.storePath ?? devinStorePath(options.env),
    options.limit ?? 20_000
  );
  if (!hitsResult.ok) warnings.push('Devin sessions.db unavailable');
  const serve = serveSummary(options.serveTurnsPath);
  if (!serve.ok) warnings.push('serve-turns journal unavailable');
  const consumers = inspectDevinAccount(options);
  warnings.push(...consumers.warnings);
  let activeSessions: ReturnType<typeof listDevinSessions> = [];
  try {
    activeSessions = listDevinSessions(
      [options.locksDir ?? devinLocksDir({}, options.env)],
      options.procDir
    );
  } catch {
    warnings.push('session locks unavailable');
  }
  return {
    lastLock: hitsResult.hits[0],
    hits: hitsResult.hits,
    activeSessions,
    consumers,
    serveTurns: serve.summary,
    ok: hitsResult.ok && serve.ok && consumers.ok,
    warnings,
  };
}
