/**
 * The decision's context and its journal write (spec bro-0ykhg.4).
 *
 * `contextId` is the stable project namespace outcomes group under:
 * the canonical repository id when the dir sits in a git project,
 * the operator's configured `brouter.contextId` for standalone callers,
 * and the canonical route-table location as the last resort — never a
 * route name across projects.
 *
 * `taskTextRetentionDays` (default 30) gates text persistence: zero
 * disables task text, replay snapshots and FTS recall entirely.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { loadConfig, projectId } from '@broject/core';
import {
  migrateStore,
  newDecisionId,
  openStore,
  recordDecision,
  routerStorePath,
} from '@broject/router-store';
import type { DecisionInput } from '@broject/router-store';

/** sha256-16 — the same digest shape projectId uses for paths. */
function digest(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/** The canonical path for hashing — realpath when it resolves, the
 *  given path otherwise (a table need not exist to namespace by it). */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The project namespace a decision journals under. */
export function decisionContextId(dir: string, opts: { tablePath?: string } = {}): string {
  try {
    return projectId(dir);
  } catch {
    // no git project — standalone callers configure one, else the
    // canonical table location namespaces the outcomes
  }
  const configured = loadConfig(dir).brouter?.contextId;
  if (configured !== undefined && configured.trim() !== '') {
    return configured.trim();
  }
  if (opts.tablePath !== undefined) {
    return `table:${digest(canonicalPath(opts.tablePath))}`;
  }
  return `dir:${digest(canonicalPath(dir))}`;
}

/** The configured text retention — days; 0 disables text persistence. */
export function taskTextRetentionDays(dir: string): number {
  const configured = loadConfig(dir).brouter?.taskTextRetentionDays;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : 30;
}

/** Journal one decision into the router's ledger — best-effort like
 *  every ledger write: the record is observability, never a gate, so a
 *  store that cannot take it costs the row, not the decision. The id
 *  is minted before journaling (or taken from the caller, which pins
 *  it first); `contextId` resolves through decisionContextId when the
 *  caller does not carry one. Returns the id and whether the row
 *  landed. */
export async function journalDecision(
  input: Omit<DecisionInput, 'contextId'> & { dir: string; contextId?: string }
): Promise<{ decisionId: string; contextId: string; recorded: boolean }> {
  const decisionId = input.decisionId ?? newDecisionId();
  const contextId =
    input.contextId !== undefined && input.contextId.trim() !== ''
      ? input.contextId.trim()
      : decisionContextId(input.dir, { tablePath: input.tablePath });
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return { decisionId, contextId, recorded: false };
  }
  try {
    migrateStore(handle.db);
    const recorded = await recordDecision(handle, {
      ...input,
      contextId,
      persistText: input.persistText ?? taskTextRetentionDays(input.dir) !== 0,
    });
    return { decisionId, contextId, recorded };
  } catch {
    return { decisionId, contextId, recorded: false };
  } finally {
    handle.close();
  }
}
