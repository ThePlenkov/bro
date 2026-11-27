import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { eventsFile } from '@broject/acp-session';
import { stateCommonDir } from '@broject/core';

export interface UsageBudgetGroup {
  agent: string;
  bead?: string;
  provider?: string;
  model?: string;
  from: string;
  to: string;
  rows: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  unknownCost: { count: number; reason: string };
}

export interface UsageBudgetWindow {
  from: string;
  to: string;
  rows: number;
  unknownCostRows: number;
  groups: UsageBudgetGroup[];
}

export interface FleetUsageBudget {
  basis: 'agent-events';
  day: UsageBudgetWindow;
  window: UsageBudgetWindow;
  degraded?: string[];
}

export interface UsageRow {
  agent: string;
  bead?: string;
  ts: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

const UNKNOWN_COST_REASON = 'provider did not report cost';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'usage') return undefined;
  return row;
}

function validTimestamp(value: unknown): string | undefined {
  const ts = stringValue(value);
  return ts !== undefined && !Number.isNaN(Date.parse(ts)) ? ts : undefined;
}

function buildUsageRow(agent: string, row: Record<string, unknown>, ts: string): UsageRow {
  const bead = stringValue(row.bead);
  const provider = stringValue(row.provider);
  const model = stringValue(row.model);
  const inputTokens = nonNegativeNumber(row.inputTokens);
  const outputTokens = nonNegativeNumber(row.outputTokens);
  const costUsd = nonNegativeNumber(row.costUsd);
  const usage: UsageRow = { agent, ts };
  if (bead !== undefined) usage.bead = bead;
  if (provider !== undefined) usage.provider = provider;
  if (model !== undefined) usage.model = model;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

function usageRow(agent: string, value: unknown): UsageRow | undefined {
  const row = usageRecord(value);
  if (row === undefined) return undefined;
  const ts = validTimestamp(row.ts);
  return ts === undefined ? undefined : buildUsageRow(agent, row, ts);
}

function pathIsInside(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

function journalPath(common: string, agent: string): string | undefined {
  const directory = resolve(common, 'bro', 'agents');
  const candidate = resolve(eventsFile(common, agent));
  if (!pathIsInside(candidate, directory)) return undefined;
  try {
    const realDirectory = realpathSync(directory);
    const realCandidate = realpathSync(candidate);
    return pathIsInside(realCandidate, realDirectory) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

function agentIds(common: string, degraded: string[]): string[] {
  const dir = join(common, 'bro', 'agents');
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.events.jsonl'))
      .map(name => name.slice(0, -'.events.jsonl'.length));
  } catch (e) {
    // ENOENT is the normal empty state — no journals written yet. Anything
    // else (EACCES, ENOTDIR, corrupt fs) is a project error and must be
    // visible in the budget output, never silently zeroed.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      degraded.push(`agent events directory unreadable: ${(e as Error).message}`);
    }
    return [];
  }
}

function parseLines(agent: string, lines: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of lines.split(/\r?\n/)) {
    if (line === '') continue;
    try {
      const row = usageRow(agent, JSON.parse(line) as unknown);
      if (row !== undefined) rows.push(row);
    } catch {
      // A torn or corrupt telemetry line must not hide the rest of the archive.
    }
  }
  return rows;
}

function readJournal(agent: string, file: string, degraded: string[]): UsageRow[] {
  if (!existsSync(file)) return [];
  try {
    return parseLines(agent, readFileSync(file, 'utf8'));
  } catch (e) {
    degraded.push(`journal for ${agent} unreadable: ${(e as Error).message}`);
    return [];
  }
}

function readRows(dir: string, degraded: string[]): UsageRow[] {
  const common = stateCommonDir(dir);
  if (common === null) return [];
  return agentIds(common, degraded).flatMap(agent => {
    const file = journalPath(common, agent);
    return file === undefined ? [] : readJournal(agent, file, degraded);
  });
}

function selectRows(rows: UsageRow[], fromMs: number, toMs: number): UsageRow[] {
  return rows.filter(row => {
    const time = Date.parse(row.ts);
    return time >= fromMs && time <= toMs;
  });
}

function groupKey(row: UsageRow): string {
  return JSON.stringify([row.agent, row.bead ?? null, row.provider ?? null, row.model ?? null]);
}

function newGroup(row: UsageRow): UsageBudgetGroup {
  return {
    agent: row.agent,
    ...(row.bead === undefined ? {} : { bead: row.bead }),
    ...(row.provider === undefined ? {} : { provider: row.provider }),
    ...(row.model === undefined ? {} : { model: row.model }),
    from: row.ts,
    to: row.ts,
    rows: 1,
    ...(row.inputTokens === undefined ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === undefined ? {} : { outputTokens: row.outputTokens }),
    ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
    unknownCost: { count: row.costUsd === undefined ? 1 : 0, reason: UNKNOWN_COST_REASON },
  };
}

function addToGroup(group: UsageBudgetGroup, row: UsageRow): void {
  group.rows++;
  if (Date.parse(row.ts) < Date.parse(group.from)) group.from = row.ts;
  if (Date.parse(row.ts) > Date.parse(group.to)) group.to = row.ts;
  if (row.inputTokens !== undefined) group.inputTokens = (group.inputTokens ?? 0) + row.inputTokens;
  if (row.outputTokens !== undefined)
    group.outputTokens = (group.outputTokens ?? 0) + row.outputTokens;
  if (row.costUsd !== undefined) group.costUsd = (group.costUsd ?? 0) + row.costUsd;
  else group.unknownCost.count++;
}

function groupRows(rows: UsageRow[]): UsageBudgetGroup[] {
  const grouped = new Map<string, UsageBudgetGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, newGroup(row));
    else addToGroup(group, row);
  }
  return [...grouped.values()].sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.from.localeCompare(b.from)
  );
}

function windowFor(rows: UsageRow[], fromMs: number, toMs: number): UsageBudgetWindow {
  const selected = selectRows(rows, fromMs, toMs);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows: selected.length,
    unknownCostRows: selected.filter(row => row.costUsd === undefined).length,
    groups: groupRows(selected),
  };
}

export function readFleetUsageBudget(dir: string, now = Date.now()): FleetUsageBudget {
  const degraded: string[] = [];
  const rows = readRows(dir, degraded);
  const budget = aggregateUsageRows(rows, now);
  if (degraded.length > 0) budget.degraded = degraded;
  return budget;
}

export function aggregateUsageRows(rows: UsageRow[], now = Date.now()): FleetUsageBudget {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  return {
    basis: 'agent-events',
    day: windowFor(rows, dayStart.getTime(), now),
    window: windowFor(rows, now - 24 * 60 * 60 * 1000, now),
  };
}
