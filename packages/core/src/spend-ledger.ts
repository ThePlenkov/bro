import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { withFileLock } from './filelock.ts';

export interface SpendRow {
  ts: string;
  bead: string;
  provider: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SpendSummary {
  basis: 'provider-reported';
  rows: number;
  unknownCostRows: number;
  totalCostUsd?: number;
  byBead: Array<{ bead: string; costUsd?: number; rows: number }>;
  byProvider: Array<{ provider: string; costUsd?: number; rows: number }>;
}

const MAX_ROWS = 10_000;

export function spendLedgerPath(stateHome = process.env.XDG_STATE_HOME): string {
  return join(stateHome || join(homedir(), '.local', 'state'), 'bro', 'spend.jsonl');
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validInteger(value: unknown): value is number {
  return validNumber(value) && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown, validator: (value: unknown) => boolean): boolean {
  return value === undefined || validator(value);
}

function validRow(value: unknown): value is SpendRow {
  if (!isRecord(value)) return false;
  const row = value as Record<string, unknown>;
  return [
    typeof row.ts === 'string' && Number.isFinite(Date.parse(row.ts)),
    nonEmptyString(row.bead),
    nonEmptyString(row.provider),
    optionalString(row.model),
    optionalNumber(row.costUsd, validNumber),
    optionalNumber(row.inputTokens, validInteger),
    optionalNumber(row.outputTokens, validInteger),
  ].every(Boolean);
}

function parseRow(line: string): SpendRow | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return validRow(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read only the tail needed for the bounded ledger. Writes therefore do
 * not become slower as old rows accumulate. */
function tailLines(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let offset = size;
    let newlineCount = 0;
    while (offset > 0 && newlineCount <= MAX_ROWS) {
      const length = Math.min(64 * 1024, offset);
      offset -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, offset);
      chunks.unshift(chunk);
      newlineCount += chunk.toString('utf8').split('\n').length - 1;
    }
    return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).slice(-MAX_ROWS);
  } finally {
    closeSync(fd);
  }
}

function readRows(path: string): SpendRow[] {
  try {
    return tailLines(path)
      .map(parseRow)
      .filter((row): row is SpendRow => row !== undefined);
  } catch {
    return [];
  }
}

export function recordSpend(row: SpendRow, path = spendLedgerPath()): void {
  if (!validRow(row)) throw new Error('invalid provider usage row');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  withFileLock(`${path}.lock`, () => {
    const rows = readRows(path);
    rows.push(row);
    const kept = rows.slice(-MAX_ROWS);
    if (kept.length === MAX_ROWS) {
      writeFileSync(path, `${kept.map(value => JSON.stringify(value)).join('\n')}\n`, {
        mode: 0o600,
      });
    } else {
      appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    }
  });
}

function groups(rows: SpendRow[], key: 'bead' | 'provider') {
  const map = new Map<string, { rows: number; costUsd?: number }>();
  for (const row of rows) {
    const group = map.get(row[key]) ?? { rows: 0 };
    group.rows += 1;
    if (row.costUsd !== undefined) group.costUsd = (group.costUsd ?? 0) + row.costUsd;
    map.set(row[key], group);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      [key]: name,
      ...value,
    })) as
    | Array<{ bead: string; costUsd?: number; rows: number }>
    | Array<{
        provider: string;
        costUsd?: number;
        rows: number;
      }>;
}

export function spendSummary(path = spendLedgerPath()): SpendSummary {
  const rows = readRows(path);
  const priced = rows.filter(row => row.costUsd !== undefined);
  return {
    basis: 'provider-reported',
    rows: rows.length,
    unknownCostRows: rows.length - priced.length,
    ...(priced.length > 0
      ? {
          totalCostUsd: priced.reduce(
            (sum, row) => sum + (row.costUsd === undefined ? 0 : row.costUsd),
            0
          ),
        }
      : {}),
    byBead: groups(rows, 'bead') as SpendSummary['byBead'],
    byProvider: groups(rows, 'provider') as SpendSummary['byProvider'],
  };
}
