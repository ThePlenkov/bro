/**
 * The T1 recall stage — similar successful tasks vote for a route
 * (spec bro-0ykhg.2).
 *
 * Vector-free by contract: FTS5/BM25 over the outcome rows' retained
 * task text, restricted to the decision's own namespace — the active
 * `contextId`, the table hash, the formula hash, verified rows only —
 * then the shared success predicate labels each row. Only VERIFIED
 * successful rows vote positively; failures count separately and never
 * create agreement; unlabelled rows (merged with unknown rounds under
 * `merged_first_round`) count for nothing.
 *
 * Retrieval intersects the current candidates: a route the table no
 * longer offers cannot be recalled into existence, and same-named
 * routes in different contexts never share votes — context_id is part
 * of the store query, not a post-filter.
 *
 * T1 decides only when the top-k successful rows agree above the
 * configured thresholds (`brouter.router.recall = {k, minAgreement,
 * minRows}`); below them it reorders the candidates by vote strength
 * and passes the set on. Every failure — no store, no rows, a broken
 * query — passes through empty: recall is evidence, never a gate.
 */

import type { RouteTable } from '@broject/router-routes';
import {
  contentHash,
  DEFAULT_SUCCESS_PREDICATE,
  labelOutcome,
  migrateStore,
  openStore,
  type RecallOutcomeRow,
  recallOutcomeRows,
  routerStorePath,
  type SuccessPredicate,
  textHash,
} from '@broject/router-store';
import { decisionContextId } from './context.ts';

/** The recall tuning — `brouter.router.recall`, defaults applied. */
export interface RecallTuning {
  k: number;
  minAgreement: number;
  minRows: number;
}

/** The defaults — a small top-k, a clear majority, a minimum evidence
 *  floor: recall must prove agreement, not merely suggest it. */
export const DEFAULT_RECALL: RecallTuning = { k: 5, minAgreement: 0.6, minRows: 3 };

/** Resolve the tuning — absent fields take the defaults; nonsense
 *  values clamp rather than disable (k≥1, agreement∈(0,1], rows≥1). */
export function recallTuning(raw?: {
  k?: number;
  minAgreement?: number;
  minRows?: number;
}): RecallTuning {
  const k = raw?.k;
  const minAgreement = raw?.minAgreement;
  const minRows = raw?.minRows;
  return {
    k: typeof k === 'number' && Number.isFinite(k) && k >= 1 ? Math.floor(k) : DEFAULT_RECALL.k,
    minAgreement:
      typeof minAgreement === 'number' && Number.isFinite(minAgreement) && minAgreement > 0
        ? Math.min(1, minAgreement)
        : DEFAULT_RECALL.minAgreement,
    minRows:
      typeof minRows === 'number' && Number.isFinite(minRows) && minRows >= 1
        ? Math.floor(minRows)
        : DEFAULT_RECALL.minRows,
  };
}

/** What the recall stage needs — the decision's namespace, resolved
 *  exactly as the journal resolves it. */
export interface RecallScope {
  dir: string;
  tablePath?: string;
  table: RouteTable;
  /** the formula file's raw bytes — NULL hash for a formula-less
   *  decision; the SAME text the journal snapshots */
  formulaText?: string;
}

/** The scoped recall read — one store open, one BM25 query, one close.
 *  Undefined on any failure: the caller's T1 passes through empty. */
export async function recallOutcomeRowsScoped(
  scope: RecallScope,
  text: string,
  /** the recall window — the fetch limit plus the SQL-side narrowing:
   *  contender route names and the success predicate's votable shape,
   *  so the limit only ever holds eligible labelled evidence
   *  (bro-0ykhg.2 review) */
  query: {
    limit: number;
    routes?: readonly string[];
    predicate?: SuccessPredicate;
  }
): Promise<RecallOutcomeRow[] | undefined> {
  try {
    const contextId = decisionContextId(scope.dir, {
      ...(scope.tablePath === undefined ? {} : { tablePath: scope.tablePath }),
    });
    const tableHash = contentHash(scope.table);
    const formulaHash = scope.formulaText === undefined ? null : textHash(scope.formulaText);
    const handle = openStore(routerStorePath());
    if (!handle.ok) {
      return undefined;
    }
    try {
      migrateStore(handle.db);
      return await recallOutcomeRows(handle.db, {
        contextId,
        text,
        tableHash,
        formulaHash,
        ...(query.routes === undefined ? {} : { routes: query.routes }),
        ...(query.predicate === undefined ? {} : { predicate: query.predicate }),
        limit: query.limit,
      });
    } finally {
      handle.close();
    }
  } catch (error) {
    // fail-open — recall is advisory: an unreadable store or a broken
    // query must never break a route decision, but one stderr line
    // keeps a dead recall plane visible (same shape as the provider
    // warning in route-decide.ts)
    console.error(
      `warning: brouter outcome recall — ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/** One route's recall tally — verified successes vote for, verified
 *  failures count against (never for), unlabelled rows count for
 *  nothing. */
export interface RouteVotes {
  route: string;
  successes: number;
  failures: number;
}

/** The rows allowed to occupy the top-k voting window — the success
 *  predicate must be able to LABEL them. Unlabelled rows count for
 *  nothing in recallVotes, so letting them fill the window would crowd
 *  real votes out of the k slots and silently weaken T1
 *  (bro-0ykhg.2 review). */
export function votableRecallRows(
  rows: RecallOutcomeRow[],
  predicate: SuccessPredicate = DEFAULT_SUCCESS_PREDICATE
): RecallOutcomeRow[] {
  return rows.filter(
    r => labelOutcome({ result: r.result, rounds: r.rounds }, predicate) !== 'unlabelled'
  );
}

/** The top-k rows allowed to occupy the voting window — contender
 *  routes only, the predicate's unlabelled shape removed BEFORE the
 *  slice, so dead-route and unvotable rows can never crowd real
 *  evidence out of the k slots (bro-0ykhg.2 review). */
export function recallVotingWindow(
  rows: RecallOutcomeRow[],
  contenders: readonly string[],
  k: number,
  predicate: SuccessPredicate = DEFAULT_SUCCESS_PREDICATE
): RecallOutcomeRow[] {
  const allowed = new Set(contenders);
  return votableRecallRows(
    rows.filter(r => r.route !== null && allowed.has(r.route)),
    predicate
  ).slice(0, k);
}

/** The votes over the recalled rows — only rows naming a CURRENT
 *  contender vote (retrieval ∩ candidates); the success predicate
 *  labels each. `order` is the contenders reordered by success votes
 *  desc, stable — the reorder T1 passes on when it does not decide. */
export function recallVotes(
  rows: RecallOutcomeRow[],
  contenders: readonly string[],
  predicate: SuccessPredicate = DEFAULT_SUCCESS_PREDICATE
): { votes: Map<string, RouteVotes>; order: string[] } {
  const allowed = new Set(contenders);
  const votes = new Map<string, RouteVotes>();
  for (const row of rows) {
    if (row.route === null || !allowed.has(row.route)) {
      continue;
    }
    const label = labelOutcome({ result: row.result, rounds: row.rounds }, predicate);
    if (label === 'unlabelled') {
      continue;
    }
    const bucket = votes.get(row.route) ?? { route: row.route, successes: 0, failures: 0 };
    if (label === 'success') {
      bucket.successes += 1;
    } else {
      bucket.failures += 1;
    }
    votes.set(row.route, bucket);
  }
  // reorder: success-vote desc, then the contender's own standing —
  // unvoted contenders keep their relative order at the tail
  const strength = (name: string): number => votes.get(name)?.successes ?? 0;
  const order = [...contenders].sort((a, b) => {
    const d = strength(b) - strength(a);
    return d !== 0 ? d : contenders.indexOf(a) - contenders.indexOf(b);
  });
  return { votes, order };
}

/** T1's verdict — the decided route when the top-k successful rows
 *  agree above the thresholds, else undefined (pass the set on).
 *  Unanimous FAILED outcomes never decide: a route every similar task
 *  failed on is evidence against it, not for it. */
export function recallDecision(
  votes: Map<string, RouteVotes>,
  tuning: RecallTuning,
  contenders: readonly string[]
): { decided?: string; note: string } {
  // the winner: most successes among contenders; ties break by fewer
  // failures, then contender order
  let best: RouteVotes | undefined;
  for (const name of contenders) {
    const v = votes.get(name);
    if (v === undefined || v.successes === 0) {
      continue;
    }
    if (
      best === undefined ||
      v.successes > best.successes ||
      (v.successes === best.successes && v.failures < best.failures)
    ) {
      best = v;
    }
  }
  if (best === undefined) {
    return { note: 'no verified successes recalled' };
  }
  // the top-k successful rows: only successes vote for agreement —
  // count the winner's successes against the total successes recalled
  let totalSuccesses = 0;
  for (const v of votes.values()) {
    totalSuccesses += v.successes;
  }
  const agreement = totalSuccesses === 0 ? 0 : best.successes / totalSuccesses;
  const rows = best.successes;
  if (rows < tuning.minRows || agreement < tuning.minAgreement) {
    return {
      note:
        `recall split — ${best.route} ${best.successes} success(es) of ` +
        `${totalSuccesses} recalled (needs ≥${tuning.minRows} rows, ` +
        `≥${Math.round(tuning.minAgreement * 100)}% agreement)`,
    };
  }
  return {
    decided: best.route,
    note:
      `recall decided ${best.route} — ${best.successes} of ${totalSuccesses} ` +
      `verified successes agreed`,
  };
}
