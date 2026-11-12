/**
 * The score shape's outcome stats — the .7 wiring (spec bro-0ykhg.7).
 *
 * `routerOutcomeStats` builds the `OutcomeStatsSource` the formula
 * scorer reads: one fetch of the verified terminal outcomes inside the
 * decision's own namespace — the same `contextId` `journalDecision`
 * writes under, the same `contentHash(table)`/`textHash(formulaText)`
 * digests, the read-model's 30-day window — then a synchronous reduce
 * per candidate through `reduceOutcomeStats`, the JS half of
 * `outcomeStats` the store package exports for exactly this seam. The
 * rows arrive pre-grouped by route, so `statsFor` reduces only the
 * candidate's own slice — a scoring pass touches each row once, not
 * once per candidate.
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

/** The decision's namespace digests — context, table and formula
 *  hashes resolved exactly as the journal resolves them; undefined
 *  when any input cannot produce one (the caller degrades to the
 *  prior). */
function outcomeScope(
  input: RouterOutcomeStatsInput,
  formulaText: string
): { contextId: string; tableHash: string; formulaHash: string } | undefined {
  try {
    return {
      contextId: decisionContextId(input.dir, { tablePath: input.tablePath }),
      tableHash: contentHash(input.table),
      formulaHash: textHash(formulaText),
    };
  } catch {
    return undefined;
  }
}

/** The one async read — migrate, fetch the verified rows inside the
 *  window and the decision's scope, close. Undefined on any failure:
 *  the caller degrades to the prior. */
async function fetchScopedRows(
  scope: { contextId: string; tableHash: string; formulaHash: string },
  now?: number
): Promise<StatsRow[] | undefined> {
  const handle = openStore(routerStorePath());
  if (!handle.ok) {
    return undefined;
  }
  try {
    migrateStore(handle.db);
    const at = now ?? Date.now();
    return await outcomeStatsRows(handle.db, {
      contextId: scope.contextId,
      tableHash: scope.tableHash,
      formulaHash: scope.formulaHash,
      since: at - OUTCOME_WINDOW_MS,
      now: at,
    });
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}

/** Rows grouped by route name — `statsFor` then reduces only the
 *  candidate's own slice, so a scoring pass touches each row once, not
 *  once per candidate. Rows with no route can never match a candidate
 *  name, so they never enter the map. */
function groupRowsByRoute(rows: StatsRow[]): Map<string, StatsRow[]> {
  const byRoute = new Map<string, StatsRow[]>();
  for (const row of rows) {
    if (row.route === null) continue;
    const bucket = byRoute.get(row.route);
    if (bucket === undefined) {
      byRoute.set(row.route, [row]);
    } else {
      bucket.push(row);
    }
  }
  return byRoute;
}

/** The live outcome stats for one decision — the `OutcomeStatsSource`
 *  `decideByFormula` scores against when `brouter.formula` declares
 *  `shape: score`. Never throws: every failure is the prior. */
export async function routerOutcomeStats(
  input: RouterOutcomeStatsInput
): Promise<OutcomeStatsSource> {
  const formulaText = input.formulaText;
  if (formulaText === undefined) {
    return priorOnlyOutcomes;
  }
  const scope = outcomeScope(input, formulaText);
  if (scope === undefined) {
    return priorOnlyOutcomes;
  }
  const rows = await fetchScopedRows(scope, input.now);
  if (rows === undefined) {
    return priorOnlyOutcomes;
  }
  const byRoute = groupRowsByRoute(rows);
  return {
    statsFor(route, features, formula) {
      const stats = reduceOutcomeStats(byRoute.get(route.name) ?? [], {
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
