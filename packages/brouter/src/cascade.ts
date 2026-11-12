/**
 * The classification cascade's shared stages (spec bro-0ykhg.2) —
 * T0 rules, T1 recall, the invoke gate, and the stage trace every rung
 * leaves. The formula path's three shapes and the no-formula path all
 * run the same rungs; this module owns the parts they share so the
 * stages can never drift apart between shapes.
 *
 * Stage contract: each rung either decides (a route name) or passes
 * the surviving contender set on, cheapest first, every stage
 * optional and fail-open. `mode` still owns TRUST — whether a T2/T3
 * answer may route; `invoke` owns whether the judge is ASKED.
 */
import type {
  CascadeDecider,
  CascadeStage,
  CascadeStageName,
  CascadeTrace,
  PendingRoute,
  RouteCandidate,
  RouteTable,
} from '@broject/router-routes';
import type { RecallOutcomeRow, SuccessPredicate } from '@broject/router-store';
import {
  type RecallTuning,
  recallDecision,
  recallOutcomeRowsScoped,
  recallVotes,
  votableRecallRows,
} from './recall.ts';

/** The invoke modes — `brouter.router.invoke`, 'ambiguous' the default. */
export type InvokeMode = 'always' | 'ambiguous' | 'never';

/** One stage's record — the contenders it saw, the contenders it left,
 *  the wall-clock it cost. */
export function stageRecord(
  stage: CascadeStageName,
  before: readonly string[],
  after: readonly string[],
  latencyMs: number,
  extra?: { decided?: string; note?: string }
): CascadeStage {
  return {
    stage,
    before: [...before],
    after: [...after],
    latencyMs,
    ...(extra?.decided === undefined ? {} : { decided: extra.decided }),
    ...(extra?.note === undefined ? {} : { note: extra.note }),
  };
}

/** The T0 output the cascade carries forward — the resolved candidates,
 *  the routes still pending on formula answers, and the rejects. */
export interface T0Set {
  candidates: RouteCandidate[];
  pending: PendingRoute[];
  rejected: { route: { name: string }; reason: string }[];
}

/** What T1 hands back — a decided route, or the reordered contender
 *  names the next stage sees. */
export interface T1Result {
  decided?: string;
  /** contender names in recall order — candidates not reordered keep
   *  their standing at the tail */
  order: string[];
  stage: CascadeStage;
  note: string;
}

/** Run T1 — fetch the scoped recall rows (or take the test seam's),
 *  label them by the success predicate, intersect with the contenders,
 *  and decide-or-reorder. Never throws: broken recall passes through
 *  with an empty order note. */
export async function runT1(opts: {
  dir: string;
  tablePath?: string;
  table: RouteTable;
  formulaText?: string;
  text: string;
  /** contender route names — the resolved candidates T1 may reorder */
  contenders: readonly string[];
  tuning: RecallTuning;
  predicate: SuccessPredicate;
  /** test seam — pre-fetched rows; production reads the store */
  rows?: RecallOutcomeRow[];
}): Promise<T1Result> {
  const started = Date.now();
  const rows =
    opts.rows ??
    (await recallOutcomeRowsScoped(
      {
        dir: opts.dir,
        table: opts.table,
        ...(opts.tablePath === undefined ? {} : { tablePath: opts.tablePath }),
        ...(opts.formulaText === undefined ? {} : { formulaText: opts.formulaText }),
      },
      opts.text,
      // fetch a window wider than k — the scope filters narrow it, the
      // vote count is what k bounds. The contender names AND the
      // predicate's unlabelled shape go into the SQL itself so dead-route
      // and unvotable rows never occupy the window (bro-0ykhg.2 review)
      opts.tuning.k * 4,
      opts.contenders.length === 0 ? undefined : opts.contenders,
      opts.predicate
    ));
  const latencyMs = Date.now() - started;
  if (rows === undefined) {
    return {
      order: [...opts.contenders],
      stage: stageRecord('T1', opts.contenders, opts.contenders, latencyMs, {
        note: 'recall unavailable — the store did not answer',
      }),
      note: 'recall unavailable',
    };
  }
  // only the top-k ELIGIBLE rows vote — the wider fetch exists so the
  // scope filters (context/table/formula/verified) can narrow it, and
  // rows naming routes that are no longer contenders never consume a
  // slot. Unlabelled rows are excluded BEFORE the slice too: they vote
  // for nothing, so they must not occupy a voting slot either
  // (bro-0ykhg.2 review). Agreement and reorder must read the SAME
  // top-k the tuning names; lower-ranked rows would dilute the vote.
  const allowed = new Set(opts.contenders);
  const eligible = votableRecallRows(
    rows.filter(r => r.route !== null && allowed.has(r.route)),
    opts.predicate
  ).slice(0, opts.tuning.k);
  const { votes, order } = recallVotes(eligible, opts.contenders, opts.predicate);
  const verdict = recallDecision(votes, opts.tuning, opts.contenders);
  if (verdict.decided !== undefined) {
    return {
      decided: verdict.decided,
      order,
      stage: stageRecord('T1', opts.contenders, [verdict.decided], latencyMs, {
        decided: verdict.decided,
        note: verdict.note,
      }),
      note: verdict.note,
    };
  }
  return {
    order,
    stage: stageRecord('T1', opts.contenders, order, latencyMs, { note: verdict.note }),
    note: verdict.note,
  };
}

/** The invoke gate — should T2 (the judge) be ASKED? `always` asks on
 *  every task; `ambiguous` asks only when more than one candidate
 *  survives T0+T1 OR a pending match/hard filter still needs an absent
 *  formula answer; `never` never asks. mode=off and a missing judge are
 *  handled by the caller — this gate only reads `invoke`. */
export function shouldInvokeT2(opts: {
  invoke: InvokeMode;
  /** resolved candidate count after T0 (+T1 reorder) */
  candidates: number;
  /** routes still pending on formula answers */
  pending: number;
  /** any pending route still has unresolved needs */
  pendingNeeds: boolean;
}): { ask: boolean; reason: string } {
  const contenders = opts.candidates + opts.pending;
  if (opts.invoke === 'always') {
    return { ask: true, reason: 'invoke=always — the judge is asked on every task' };
  }
  if (opts.invoke === 'never') {
    return {
      ask: false,
      reason: 'invoke=never — T0 rules and T1 recall only, the judge is never called',
    };
  }
  // ambiguous (the default)
  if (opts.pendingNeeds || contenders > 1) {
    return {
      ask: true,
      reason:
        contenders > 1
          ? `invoke=ambiguous — ${contenders} contenders survive T0/T1`
          : 'invoke=ambiguous — a pending match or hard filter needs a formula answer',
    };
  }
  return {
    ask: false,
    reason:
      contenders === 1
        ? 'invoke=ambiguous — one candidate survived T0/T1, decided by rules'
        : 'invoke=ambiguous — no eligible route, the judge is not asked',
  };
}

/** Assemble the cascade trace — T0's record plus whatever later rungs
 *  appended, and who decided. */
export function finishTrace(
  stages: CascadeStage[],
  decidedBy: CascadeDecider | undefined
): CascadeTrace {
  return { stages, ...(decidedBy === undefined ? {} : { decidedBy }) };
}
