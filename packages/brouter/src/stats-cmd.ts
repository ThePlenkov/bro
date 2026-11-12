/**
 * `brouter stats outcomes` — P(success | route, features) over the
 * verified terminal outcomes (spec bro-0ykhg.4).
 *
 * The read-model the formula scorer (.1 via .7), T1 recall (.2),
 * replay labels (.5) and cache invalidation (.3) all share: verified
 * rows inside the window, the shared success predicate, the Beta(1,1)
 * prior. Zero rows report p=0.5 with n=0 — the prior, never a judge
 * score.
 *
 *   brouter stats outcomes [--json] [--context ID] [--route NAME]
 *     [--success merged|merged_first_round] [--days N]
 *     [--table-hash H] [--formula-hash H]
 */
import { flag } from '@broject/core';
import {
  DEFAULT_SUCCESS_PREDICATE,
  migrateStore,
  openStore,
  outcomeStats,
  outcomeStatsByRoute,
  routerStorePath,
  SUCCESS_PREDICATES,
} from '@broject/router-store';
import type { OutcomeStats, OutcomeStatsQuery, SuccessPredicate } from '@broject/router-store';
import { decisionContextId } from './context.ts';
import { routeTablePath } from './routes-cmd.ts';

/** One stats row, rendered — the predicate's own accounting. */
function renderStats(
  label: string,
  stats: OutcomeStats,
  predicate: SuccessPredicate,
  windowDays: number
): void {
  console.log(
    `${label}\tp=${stats.p.toFixed(3)}\tn=${stats.n}\t` +
      `successes=${stats.successes}\tfailures=${stats.failures}\t` +
      `excluded=${stats.excluded}\tpredicate=${predicate}\twindow=${windowDays}d`
  );
  if (stats.costUsd !== null)
    console.log(
      `  costUsd=${stats.costUsd.toFixed(4)}\twallSec=${(stats.wallSec ?? 0).toFixed(1)}`
    );
}

/** `brouter stats outcomes` — the outcome read-model, per route and total. */
export async function runStatsOutcomesCommand(argv: string[]): Promise<void> {
  const path = flag(argv, '--path') ?? routerStorePath();
  const handle = openStore(path);
  if (!handle.ok) {
    console.error(`brouter stats: the ledger is unavailable — ${handle.reason}`);
    process.exit(1);
  }
  try {
    migrateStore(handle.db);
    // resolve the context EXACTLY as `brouter route` did — same
    // --routes flag, same config table — or the stats read a different
    // namespace than the decisions journaled under (spec bro-0ykhg.4)
    const dir = process.cwd();
    const contextId =
      flag(argv, '--context') ?? decisionContextId(dir, { tablePath: routeTablePath(dir, argv) });
    const successRaw = flag(argv, '--success');
    let success: SuccessPredicate = DEFAULT_SUCCESS_PREDICATE;
    if (successRaw !== undefined) {
      if (!(SUCCESS_PREDICATES as readonly string[]).includes(successRaw)) {
        console.error(`brouter stats: --success must be one of ${SUCCESS_PREDICATES.join('|')}`);
        process.exit(2);
      }
      success = successRaw as SuccessPredicate;
    }
    const daysRaw = flag(argv, '--days');
    const days = daysRaw === undefined ? 30 : Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0) {
      console.error(
        `brouter stats: --days must be a positive number — got ${JSON.stringify(daysRaw)}`
      );
      process.exit(2);
    }
    const now = Date.now();
    const query: OutcomeStatsQuery = {
      contextId,
      success,
      now,
      since: now - days * 24 * 60 * 60 * 1000,
      ...(flag(argv, '--route') === undefined ? {} : { route: flag(argv, '--route') }),
      ...(flag(argv, '--table-hash') === undefined
        ? {}
        : { tableHash: flag(argv, '--table-hash') }),
      ...(flag(argv, '--formula-hash') === undefined
        ? {}
        : { formulaHash: flag(argv, '--formula-hash') }),
    };
    const route = query.route;
    if (argv.includes('--json')) {
      const result =
        route === undefined
          ? await outcomeStatsByRoute(handle.db, query)
          : { total: await outcomeStats(handle.db, query), routes: [] };
      console.log(
        JSON.stringify(
          {
            contextId,
            predicate: success,
            window: { days, since: query.since, until: now },
            ...result,
          },
          null,
          2
        )
      );
      return;
    }
    if (route === undefined) {
      const { total, routes } = await outcomeStatsByRoute(handle.db, query);
      for (const row of routes) {
        renderStats(`route ${row.route}`, row.stats, success, days);
      }
      renderStats('all routes', total, success, days);
      return;
    }
    renderStats(`route ${route}`, await outcomeStats(handle.db, query), success, days);
  } finally {
    handle.close();
  }
}
