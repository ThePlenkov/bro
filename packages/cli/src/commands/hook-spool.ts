import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import {
  parseSpoolLine,
  resolveHookSpoolPath as coreResolveHookSpoolPath,
  type SpoolOutcome,
  type SpoolRow,
} from '@broject/core';

/** Spool rotation bound — `rotateHookSpool` drops `.1` past this size.
 *  Exported so doctor's drain-freshness row (bro-izpyk.1.3) can warn at
 *  a fraction of the bound instead of duplicating the number. */
export const MAX_SPOOL_BYTES = 1024 * 1024;
const DEFAULT_WATCHDOG_SECONDS = 8;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const DURATION_UNIT_MS = new Map<string, number>([
  ['ms', 1],
  ['s', 1000],
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
]);

/** Aggregation buckets — the v1 columns plus `fastpath` (the shell
 *  fast-path exit's own signal) and `killed` (a paired end that reported
 *  the kill; unpaired starts past the watchdog still count on the
 *  top-level `killed` field). Canonical ledger outcomes the writer never
 *  emits are tolerated and aliased: `timeout`→watchdog, `error`→nonzero. */
type HookOutcome = 'ok' | 'nonzero' | 'watchdog' | 'no-cli' | 'fastpath' | 'killed';

const OUTCOME_BUCKETS: Record<SpoolOutcome, HookOutcome> = {
  ok: 'ok',
  nonzero: 'nonzero',
  watchdog: 'watchdog',
  timeout: 'watchdog',
  'no-cli': 'no-cli',
  fastpath: 'fastpath',
  killed: 'killed',
  error: 'nonzero',
};

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

interface HookIdentity {
  host: string;
  event: string;
}

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
  outcomes: {
    ok: number;
    nonzero: number;
    watchdog: number;
    'no-cli': number;
    fastpath: number;
    killed: number;
  };
  /** Starts with no end past the watchdog — host kills. */
  killed: number;
}

export interface HookSpoolReadOptions {
  sinceMs?: number;
  nowMs?: number;
  watchdogSeconds?: number;
}

interface HookSpoolReadContext {
  aggregates: Map<string, HookSpoolAggregate>;
  sinceMs: number;
  nowSeconds: number;
  watchdogSeconds: number;
}

interface KilledStartContext extends HookSpoolReadContext {
  endedIds: Set<string>;
}

interface PercentileInput {
  values: number[];
  fraction: number;
}

interface StatusArgsInput {
  argv: string[];
  nowMs: number;
}

/** The spool's home — core's canonical resolver (`$BRO_HOOK_SPOOL` pins
 *  it, literal `0` disables, else `$XDG_STATE_HOME/bro/hooks.spool`). */
export function resolveHookSpoolPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return coreResolveHookSpoolPath(env);
}

/** True when the live spool is over the rotation bound — the caller
 *  drains pending rows before `rotateHookSpool` drops `.1`, so an
 *  over-limit rotation can't silently discard backlog the ledger never
 *  saw. Same stat the rotator itself does; best-effort false on error. */
export function spoolRotationPending(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const path = resolveHookSpoolPath(env);
    if (path === null) {
      return false;
    }
    return statSync(path).size > MAX_SPOOL_BYTES;
  } catch {
    return false;
  }
}

export function rotateHookSpool(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = resolveHookSpoolPath(env);
    if (path === null) {
      return;
    }
    if (statSync(path).size <= MAX_SPOOL_BYTES) {
      return;
    }
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  } catch {
    // Spool rotation is best-effort — a host with no resolvable home
    // (os.homedir throws when neither $HOME nor a passwd entry exists)
    // or an unwritable spool must not break the hook it guards.
  }
}

/** One parsed spool row → the reader's record shape. The core parser is
 *  version-tolerant (v1 + v2); end rows without rc/outcome can't pair a
 *  duration and are dropped, same as the old strict parser. */
function toRecord(row: SpoolRow): HookRecord | undefined {
  if (row.phase === 'start') {
    return { kind: 'start', ts: row.ts, id: row.id, host: row.host, event: row.event };
  }
  if (row.rc === undefined || row.outcome === undefined) {
    return undefined;
  }
  return {
    kind: 'end',
    ts: row.ts,
    id: row.id,
    host: row.host,
    event: row.event,
    rc: row.rc,
    outcome: OUTCOME_BUCKETS[row.outcome],
  };
}

function parseRecord(line: string): HookRecord | undefined {
  const row = parseSpoolLine(line);
  return row === undefined ? undefined : toRecord(row);
}

function readRecords(path: string): HookRecord[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap(line => {
        const record = parseRecord(line);
        return record === undefined ? [] : [record];
      });
  } catch {
    return [];
  }
}

function aggregateFor(
  aggregates: Map<string, HookSpoolAggregate>,
  identity: HookIdentity
): HookSpoolAggregate {
  const key = JSON.stringify([identity.host, identity.event]);
  const existing = aggregates.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const aggregate: HookSpoolAggregate = {
    host: identity.host,
    event: identity.event,
    count: 0,
    durations: [],
    outcomes: new Map(),
    killed: 0,
  };
  aggregates.set(key, aggregate);
  return aggregate;
}

function percentile({ values, fraction }: PercentileInput): number | null {
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
    p50: percentile({ values: aggregate.durations, fraction: 0.5 }),
    p95: percentile({ values: aggregate.durations, fraction: 0.95 }),
    outcomes: {
      ok: aggregate.outcomes.get('ok') ?? 0,
      nonzero: aggregate.outcomes.get('nonzero') ?? 0,
      watchdog: aggregate.outcomes.get('watchdog') ?? 0,
      'no-cli': aggregate.outcomes.get('no-cli') ?? 0,
      fastpath: aggregate.outcomes.get('fastpath') ?? 0,
      killed: aggregate.outcomes.get('killed') ?? 0,
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
  const aggregate = aggregateFor(aggregates, end);
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
  context: HookSpoolReadContext
): void {
  for (const end of ends) {
    if (end.ts * 1000 < context.sinceMs) {
      continue;
    }
    addEnd(end, starts, context.aggregates);
  }
}

function isKilledStart(start: StartRecord, context: KilledStartContext): boolean {
  if (context.endedIds.has(start.id)) {
    return false;
  }
  if (start.ts * 1000 < context.sinceMs) {
    return false;
  }
  return context.nowSeconds - start.ts > context.watchdogSeconds + 5;
}

function addKilledStarts(starts: Map<string, StartRecord>, context: KilledStartContext): void {
  for (const start of starts.values()) {
    if (!isKilledStart(start, context)) {
      continue;
    }
    const aggregate = aggregateFor(context.aggregates, start);
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
  const context: HookSpoolReadContext = {
    aggregates: new Map(),
    sinceMs,
    nowSeconds,
    watchdogSeconds,
  };
  addEndRecords(records.ends, records.starts, context);
  addKilledStarts(records.starts, {
    ...context,
    endedIds: new Set(records.ends.map(end => end.id)),
  });
  return [...context.aggregates.values()]
    .map(toRow)
    .sort((a, b) => a.host.localeCompare(b.host) || a.event.localeCompare(b.event));
}

function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  const amountText = match?.at(1);
  const unit = match?.at(2);
  if (amountText === undefined || unit === undefined) {
    return undefined;
  }
  const factor = DURATION_UNIT_MS.get(unit);
  if (factor === undefined) {
    return undefined;
  }
  const duration = Number(amountText) * factor;
  return Number.isFinite(duration) ? duration : undefined;
}

/** `BRO_HOOK_WATCHDOG_S` env → seconds, default 8 — the same bound
 *  run.sh enforces and `bro hooks status` reads. Exported for doctor's
 *  killed-start row so the two surfaces can't disagree on the horizon. */
export function hookSpoolWatchdogSeconds(env: NodeJS.ProcessEnv): number {
  const value = env.BRO_HOOK_WATCHDOG_S;
  if (value !== undefined && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_WATCHDOG_SECONDS;
}

function parseSinceDuration(value: string | undefined): number {
  if (value === undefined) {
    throw new Error('usage: bro hooks status [--since <dur>] [--json]');
  }
  const parsed = parseDurationMs(value);
  if (parsed === undefined) {
    throw new Error(`invalid --since duration: ${value}`);
  }
  return parsed;
}

function statusArgs({ argv, nowMs }: StatusArgsInput): { json: boolean; sinceMs: number } {
  let json = false;
  let duration = DEFAULT_SINCE_MS;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv.at(i);
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--since') {
      duration = parseSinceDuration(argv.at(i + 1));
      i += 1;
      continue;
    }
    if (arg?.startsWith('--since=')) {
      duration = parseSinceDuration(arg.slice('--since='.length));
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
  const args = statusArgs({ argv, nowMs });
  const rows = readHookSpool(resolveHookSpoolPath(env), {
    sinceMs: args.sinceMs,
    nowMs,
    watchdogSeconds: hookSpoolWatchdogSeconds(env),
  });
  if (rows.length === 0) {
    return args.json ? '[]' : 'no hook runs recorded';
  }
  if (args.json) {
    return JSON.stringify(rows, null, 2);
  }
  return [
    'host\tevent\tcount\tp50(s)\tp95(s)\tok\tnonzero\twatchdog\tno-cli\tfastpath\tkilled',
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
        row.outcomes.fastpath,
        // paired ends that reported a kill + unpaired starts past the
        // watchdog — both are "the run died" for a status glance
        row.outcomes.killed + row.killed,
      ].join('\t')
    ),
  ].join('\n');
}
