import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_SPOOL_BYTES = 1024 * 1024;
const DEFAULT_WATCHDOG_SECONDS = 8;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

type HookOutcome = 'ok' | 'nonzero' | 'watchdog' | 'no-cli';

interface StartRecord {
  kind: 'start';
  ts: number;
  id: string;
  host: string;
  event: string;
}

interface EndRecord {
  kind: 'end';
  ts: number;
  id: string;
  host: string;
  event: string;
  rc: number;
  outcome: HookOutcome;
}

type HookRecord = StartRecord | EndRecord;

interface HookSpoolAggregate {
  host: string;
  event: string;
  count: number;
  durations: number[];
  outcomes: Map<HookOutcome, number>;
  killed: number;
}

export interface HookSpoolRow {
  host: string;
  event: string;
  count: number;
  p50: number | null;
  p95: number | null;
  outcomes: { ok: number; nonzero: number; watchdog: number; 'no-cli': number };
  killed: number;
}

export interface HookSpoolReadOptions {
  sinceMs?: number;
  nowMs?: number;
  watchdogSeconds?: number;
}

export function resolveHookSpoolPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BRO_HOOK_SPOOL === '0') {
    return null;
  }
  const home = env.HOME || homedir();
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return resolve(env.BRO_HOOK_SPOOL || join(stateHome, 'bro', 'hooks.spool'));
}

export function rotateHookSpool(env: NodeJS.ProcessEnv = process.env): void {
  const path = resolveHookSpoolPath(env);
  if (path === null) {
    return;
  }
  try {
    if (statSync(path).size <= MAX_SPOOL_BYTES) {
      return;
    }
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  } catch {
    // Spool rotation is best-effort.
  }
}

function isOutcome(value: string | undefined): value is HookOutcome {
  switch (value) {
    case 'ok':
    case 'nonzero':
    case 'watchdog':
    case 'no-cli':
      return true;
    default:
      return false;
  }
}

interface RecordIdentity {
  id: string;
  host: string;
  event: string;
}

function parseIdentity(fields: string[]): RecordIdentity | undefined {
  const id = fields.at(3);
  const host = fields.at(4);
  const event = fields.at(5);
  if (!id || !host) {
    return undefined;
  }
  if (event === undefined) {
    return undefined;
  }
  return { id, host, event };
}

function parseStart(ts: number, fields: string[]): StartRecord | undefined {
  const identity = parseIdentity(fields);
  if (identity === undefined) {
    return undefined;
  }
  return { kind: 'start', ts, ...identity };
}

function parseEnd(ts: number, fields: string[]): EndRecord | undefined {
  const identity = parseIdentity(fields);
  if (identity === undefined) {
    return undefined;
  }
  const rcText = fields.at(6);
  if (rcText === undefined || !/^\d+$/.test(rcText)) {
    return undefined;
  }
  const outcome = fields.at(7);
  if (!isOutcome(outcome)) {
    return undefined;
  }
  return { kind: 'end', ts, ...identity, rc: Number(rcText), outcome };
}

function parseRecord(line: string): HookRecord | undefined {
  const fields = line.split('\t');
  if (fields.at(0) !== 'v1') {
    return undefined;
  }
  const tsText = fields.at(1);
  if (tsText === undefined || !/^\d+$/.test(tsText)) {
    return undefined;
  }
  const ts = Number(tsText);
  if (!Number.isSafeInteger(ts)) {
    return undefined;
  }
  const kind = fields.at(2);
  if (kind === 'start') {
    return parseStart(ts, fields);
  }
  if (kind === 'end') {
    return parseEnd(ts, fields);
  }
  return undefined;
}

function readRecords(path: string): HookRecord[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap(line => {
        const row = line.endsWith('\r') ? line.slice(0, -1) : line;
        const record = row === '' ? undefined : parseRecord(row);
        return record === undefined ? [] : [record];
      });
  } catch {
    return [];
  }
}

function aggregateFor(
  aggregates: Map<string, HookSpoolAggregate>,
  host: string,
  event: string
): HookSpoolAggregate {
  const key = JSON.stringify([host, event]);
  const existing = aggregates.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const aggregate: HookSpoolAggregate = {
    host,
    event,
    count: 0,
    durations: [],
    outcomes: new Map(),
    killed: 0,
  };
  aggregates.set(key, aggregate);
  return aggregate;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = sorted.at(Math.floor(position));
  const high = sorted.at(Math.ceil(position));
  if (low === undefined || high === undefined) {
    return null;
  }
  return low + (high - low) * (position - Math.floor(position));
}

function toRow(aggregate: HookSpoolAggregate): HookSpoolRow {
  return {
    host: aggregate.host,
    event: aggregate.event,
    count: aggregate.count,
    p50: percentile(aggregate.durations, 0.5),
    p95: percentile(aggregate.durations, 0.95),
    outcomes: {
      ok: aggregate.outcomes.get('ok') ?? 0,
      nonzero: aggregate.outcomes.get('nonzero') ?? 0,
      watchdog: aggregate.outcomes.get('watchdog') ?? 0,
      'no-cli': aggregate.outcomes.get('no-cli') ?? 0,
    },
    killed: aggregate.killed,
  };
}

function partitionRecords(records: HookRecord[]): {
  starts: Map<string, StartRecord>;
  ends: EndRecord[];
} {
  const starts = new Map<string, StartRecord>();
  const ends: EndRecord[] = [];
  for (const record of records) {
    if (record.kind === 'start') {
      starts.set(record.id, record);
    } else {
      ends.push(record);
    }
  }
  return { starts, ends };
}

function addEnd(
  end: EndRecord,
  starts: Map<string, StartRecord>,
  aggregates: Map<string, HookSpoolAggregate>
): void {
  const aggregate = aggregateFor(aggregates, end.host, end.event);
  aggregate.count += 1;
  aggregate.outcomes.set(end.outcome, (aggregate.outcomes.get(end.outcome) ?? 0) + 1);
  const start = starts.get(end.id);
  if (start === undefined) {
    return;
  }
  if (start.host !== end.host) {
    return;
  }
  if (start.event !== end.event) {
    return;
  }
  const duration = end.ts - start.ts;
  if (duration >= 0) {
    aggregate.durations.push(duration);
  }
}

function addEndRecords(
  ends: EndRecord[],
  starts: Map<string, StartRecord>,
  aggregates: Map<string, HookSpoolAggregate>,
  sinceMs: number
): void {
  for (const end of ends) {
    if (end.ts * 1000 < sinceMs) {
      continue;
    }
    addEnd(end, starts, aggregates);
  }
}

function addKilledStarts(
  starts: Map<string, StartRecord>,
  endedIds: Set<string>,
  aggregates: Map<string, HookSpoolAggregate>,
  sinceMs: number,
  nowSeconds: number,
  watchdogSeconds: number
): void {
  for (const start of starts.values()) {
    if (endedIds.has(start.id)) {
      continue;
    }
    if (start.ts * 1000 < sinceMs) {
      continue;
    }
    if (nowSeconds - start.ts <= watchdogSeconds + 5) {
      continue;
    }
    const aggregate = aggregateFor(aggregates, start.host, start.event);
    aggregate.count += 1;
    aggregate.killed += 1;
  }
}

export function readHookSpool(
  path: string | null,
  options: HookSpoolReadOptions = {}
): HookSpoolRow[] {
  if (path === null) {
    return [];
  }
  const records = partitionRecords([...readRecords(`${path}.1`), ...readRecords(path)]);
  const sinceMs = options.sinceMs ?? 0;
  const nowSeconds = (options.nowMs ?? Date.now()) / 1000;
  const watchdogSeconds = options.watchdogSeconds ?? DEFAULT_WATCHDOG_SECONDS;
  const aggregates = new Map<string, HookSpoolAggregate>();
  addEndRecords(records.ends, records.starts, aggregates, sinceMs);
  addKilledStarts(
    records.starts,
    new Set(records.ends.map(end => end.id)),
    aggregates,
    sinceMs,
    nowSeconds,
    watchdogSeconds
  );
  return [...aggregates.values()]
    .map(toRow)
    .sort((a, b) => a.host.localeCompare(b.host) || a.event.localeCompare(b.event));
}

function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  const amountText = match?.at(1);
  const unit = match?.at(2);
  if (amountText === undefined || unit === undefined) {
    return undefined;
  }
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  const duration = Number(amountText) * factor;
  return Number.isFinite(duration) ? duration : undefined;
}

function watchdogSeconds(env: NodeJS.ProcessEnv): number {
  const value = env.BRO_HOOK_WATCHDOG_S;
  if (value !== undefined && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_WATCHDOG_SECONDS;
}

function statusArgs(argv: string[], nowMs: number): { json: boolean; sinceMs: number } {
  let json = false;
  let duration = DEFAULT_SINCE_MS;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv.at(i);
    if (arg === '--json') {
      json = true;
      continue;
    }
    let value: string | undefined;
    if (arg === '--since') {
      i += 1;
      value = argv.at(i);
    } else if (arg?.startsWith('--since=')) {
      value = arg.slice('--since='.length);
    }
    if (value !== undefined) {
      const parsed = parseDurationMs(value);
      if (parsed === undefined) {
        throw new Error(`invalid --since duration: ${value}`);
      }
      duration = parsed;
      continue;
    }
    throw new Error('usage: bro hooks status [--since <dur>] [--json]');
  }
  return { json, sinceMs: nowMs - duration };
}

export function renderHookSpoolStatus(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): string {
  const args = statusArgs(argv, nowMs);
  const rows = readHookSpool(resolveHookSpoolPath(env), {
    sinceMs: args.sinceMs,
    nowMs,
    watchdogSeconds: watchdogSeconds(env),
  });
  if (rows.length === 0) {
    return 'no hook runs recorded';
  }
  if (args.json) {
    return JSON.stringify(rows, null, 2);
  }
  return [
    'host\tevent\tcount\tp50(s)\tp95(s)\tok\tnonzero\twatchdog\tno-cli\tkilled',
    ...rows.map(row =>
      [
        row.host,
        row.event,
        row.count,
        row.p50 ?? '-',
        row.p95 ?? '-',
        row.outcomes.ok,
        row.outcomes.nonzero,
        row.outcomes.watchdog,
        row.outcomes['no-cli'],
        row.killed,
      ].join('\t')
    ),
  ].join('\n');
}
