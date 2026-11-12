/**
 * The score shape's outcome stats — the .7 wiring (spec bro-0ykhg.7).
 *
 * `routerOutcomeStats` builds the `OutcomeStatsSource` the formula
 * scorer reads: one fetch of the verified terminal outcomes inside the
 * decision's own namespace — the same `contextId` `journalDecision`
 * writes under, the same `contentHash(table)`/`textHash(formulaText)`
 * digests, the read-model's 30-day window — then a synchronous reduce
 * per candidate through `reduceOutcomeStats`, the JS half of
 * `outcomeStats` the store package exports for exactly this seam.
 *
 * `statsFor` is synchronous by contract (score.ts: a scoring pass
 * never awaits IO it does not need), so the async fetch happens ONCE
 * at construction and the store closes before the verdict runs. Every
 * failure — no formula text to hash, an unopenable or unmigrated
 * store, a query error — degrades to `priorOnlyOutcomes`: the Beta(1,1)
 * prior at n = 0, exactly the behavior before the store plugged in.
 * A broken ledger costs the ranking, never the route.
 *
 * The source is bound to ONE decision: the namespace (context, hashes,
 * window, rows) is fixed at construction; `statsFor` reads the route,
 * the task's features, and the formula's `success` predicate per call.
 */
import { readFileSync } from 'node:fs';
import {
  priorOnlyOutcomes,
  type OutcomeStatsSource,
  type RouteTable,
} from '@broject/router-routes';
import {
  contentHash,
  migrateStore,
  openStore,
  OUTCOME_WINDOW_MS,
  outcomeStatsRows,
  reduceOutcomeStats,
  routerStorePath,
  textHash,
} from '@broject/router-store';
import type { StatsRow } from '@broject/router-store';
import { decisionContextId } from './context.ts';

/** What the source needs — the decision's namespace, resolved exactly
 *  as the journal resolves it. */
export interface RouterOutcomeStatsInput {
  /** the working dir — the journal and the config anchor here */
  dir: string;
  /** the table's file path — the context fallback when no repo id
   *  exists; the same value the journal passes */
  tablePath?: string;
  /** the table the decision reads — `contentHash` scopes the stats */
  table: RouteTable;
  /** the formula file's raw bytes — `textHash` scopes the stats; the
   *  SAME text the journal snapshots, so reads and writes share the
   *  namespace. Absent → the prior: the hash cannot be computed, so no
   *  outcome row can ever join this formula's stats. */
  formulaText?: string;
  /** epoch ms — the window's "now"; defaults to Date.now() */
  now?: number;
}

/** The formula file's raw text — best-effort like every journal
 *  snapshot: the decision stands even when the bytes cannot be re-read
 *  (the hash then stays unknown and the stats stay the prior). */
export function formulaTextOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The live outcome stats for one decision — the `OutcomeStatsSource`
 *  `decideByFormula` scores against when `brouter.formula` declares
 *  `shape: score`. Never throws: every failure is the prior. */
export async function routerOutcomeStats(
  input: RouterOutcomeStatsInput
): Promise<OutcomeStatsSource> {
  if (input.formulaText === undefined) {
    return priorOnlyOutcomes;
  }
  let contextId: string;
  let tableHash: string;
  let formulaHash: string;
  try {
    contextId = decisionContextId(input.dir, { tablePath: input.tablePath });
    tableHash = contentHash(input.table);
    formulaHash = textHash(input.formulaText);
  } catch {
    return priorOnlyOutcomes;
  }
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return priorOnlyOutcomes;
  }
  let rows: StatsRow[];
  try {
    migrateStore(handle.db);
    const now = input.now ?? Date.now();
    rows = await outcomeStatsRows(handle.db, {
      contextId,
      tableHash,
      formulaHash,
      since: now - OUTCOME_WINDOW_MS,
      now,
    });
  } catch {
    return priorOnlyOutcomes;
  } finally {
    handle.close();
  }
  return {
    statsFor(route, features, formula) {
      const stats = reduceOutcomeStats(rows, {
        route: route.name,
        features,
        featureKeys: Object.keys(formula.questions),
        success: formula.success,
      });
      return {
        p: stats.p,
        n: stats.n,
        // NULL measures stay unknown — absent, never zero (score.ts)
        ...(stats.costUsd === null ? {} : { costUsd: stats.costUsd }),
        ...(stats.wallSec === null ? {} : { wallSec: stats.wallSec }),
      };
    },
  };
}
