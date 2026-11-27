import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function usageRow(agent: string, value: unknown): UsageRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'usage') return undefined;
  const ts = stringValue(row.ts);
  if (ts === undefined || Number.isNaN(Date.parse(ts))) return undefined;
  return {
    agent,
    ...(stringValue(row.bead) === undefined ? {} : { bead: stringValue(row.bead) }),
    ts,
    ...(stringValue(row.provider) === undefined ? {} : { provider: stringValue(row.provider) }),
    ...(stringValue(row.model) === undefined ? {} : { model: stringValue(row.model) }),
    ...(nonNegativeNumber(row.inputTokens) === undefined
      ? {}
      : { inputTokens: nonNegativeNumber(row.inputTokens) }),
    ...(nonNegativeNumber(row.outputTokens) === undefined
      ? {}
      : { outputTokens: nonNegativeNumber(row.outputTokens) }),
    ...(nonNegativeNumber(row.costUsd) === undefined
      ? {}
      : { costUsd: nonNegativeNumber(row.costUsd) }),
  };
}

function readRows(dir: string): UsageRow[] {
  const common = stateCommonDir(dir);
  if (common === null) return [];
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(common, 'bro', 'agents'))) {
      if (name.endsWith('.events.jsonl')) ids.add(name.slice(0, -'.events.jsonl'.length));
    }
  } catch {
    return [];
  }
  const rows: UsageRow[] = [];
  for (const agent of ids) {
    const file = eventsFile(common, agent);
    if (!existsSync(file)) continue;
    let lines: string;
    try {
      lines = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of lines.split(/\r?\n/)) {
      if (line === '') continue;
      try {
        const row = usageRow(agent, JSON.parse(line) as unknown);
        if (row !== undefined) rows.push(row);
      } catch {
        // A torn or corrupt telemetry line must not hide the rest of the archive.
      }
    }
  }
  return rows;
}

function windowFor(rows: UsageRow[], fromMs: number, toMs: number): UsageBudgetWindow {
  const selected = rows.filter(row => {
    const time = Date.parse(row.ts);
    return time >= fromMs && time <= toMs;
  });
  const grouped = new Map<string, UsageBudgetGroup>();
  for (const row of selected) {
    const key = JSON.stringify([
      row.agent,
      row.bead ?? null,
      row.provider ?? null,
      row.model ?? null,
    ]);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
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
      });
      continue;
    }
    current.rows++;
    if (Date.parse(row.ts) < Date.parse(current.from)) current.from = row.ts;
    if (Date.parse(row.ts) > Date.parse(current.to)) current.to = row.ts;
    if (row.inputTokens !== undefined)
      current.inputTokens = (current.inputTokens ?? 0) + row.inputTokens;
    if (row.outputTokens !== undefined)
      current.outputTokens = (current.outputTokens ?? 0) + row.outputTokens;
    if (row.costUsd !== undefined) current.costUsd = (current.costUsd ?? 0) + row.costUsd;
    else current.unknownCost.count++;
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows: selected.length,
    unknownCostRows: selected.filter(row => row.costUsd === undefined).length,
    groups: [...grouped.values()].sort(
      (a, b) => a.agent.localeCompare(b.agent) || a.from.localeCompare(b.from)
    ),
  };
}

export function readFleetUsageBudget(dir: string, now = Date.now()): FleetUsageBudget {
  const rows = readRows(dir);
  return aggregateUsageRows(rows, now);
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
