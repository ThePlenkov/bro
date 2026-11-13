/**
 * The classifier bench — offline replay of the decision journal across
 * route contenders (spec bro-0ykhg.5).
 *
 * `brouter bench replay` re-asks every journaled decision — the task
 * text plus the candidate set it had — with each listed contender and
 * scores the answers against the outcome oracle (router.db's verified
 * outcome rows). It is a REPLAY: no worker is dispatched, no cache
 * entry is written, no journal row lands — the store is read-only for
 * this pass.
 *
 * What the numbers mean, exactly:
 *
 * - "historical agreement" — the contender's pick equals the route the
 *   decision historically executed, counted ONLY over decisions whose
 *   verified outcome is a success under that decision's own success
 *   predicate. It is agreement with what ran, NOT routing accuracy:
 *   the observed route is not a counterfactual oracle, and an untried
 *   route is unknown, never incorrect. Failed, abandoned and parked
 *   outcomes carry no agreement target; unlabelled and unverified rows
 *   are excluded and counted.
 * - calibration — requires a paired-run dataset with measured outcomes
 *   per compared route on the same tasks (bro-l8c4f.9); until one
 *   exists the metric reports unavailable, never a number.
 * - recall freeze — T1's evidence is clipped to outcome rows accepted
 *   BEFORE the decision was journaled, minus the decision's own
 *   outcome, so recall can never retrieve its test label.
 */
import { performance } from 'node:perf_hooks';
import type { DecideResult, JudgeFacade, ProviderEntry } from '@broject/core';
import { loadConfig } from '@broject/core';
import {
  chainedJudge,
  judgeConfig,
  providerJudge,
  providerKeyField,
  routePickQuestions,
  synthesizedProviders,
  type JudgeConfig,
} from '@broject/judge';
import { parseFormulaText } from '@broject/router-routes';
import {
  DEFAULT_SUCCESS_PREDICATE,
  getOutcome,
  labelOutcome,
  listDecisions,
  migrateStore,
  openStore,
  recallOutcomeRows,
  routerStorePath,
  SUCCESS_PREDICATES,
  type DecisionRow,
  type OutcomeRow,
  type RecallOutcomeRow,
  type RouterDb,
  type SuccessPredicate,
} from '@broject/router-store';
import { shouldInvokeT2, type InvokeMode } from './cascade.ts';
import { recallDecision, recallTuning, recallVotes, recallVotingWindow } from './recall.ts';
import type { RecallTuning } from './recall.ts';

// ---------------------------------------------------------------------------
// Replay state — one journaled decision, parsed and classified
// ---------------------------------------------------------------------------

/** One candidate the decision had — name plus the pick-question
 *  description (the route's own prose, else its chain). */
export interface ReplayCandidate {
  name: string;
  description: string;
}

/** Why a journaled row cannot be replayed — the skip ledger's keys. */
export type ReplaySkipReason =
  | 'missing-task-text'
  | 'missing-candidates'
  | 'unparseable-candidates'
  | 'empty-candidates'
  | 'missing-table'
  | 'unparseable-table';

/** The outcome's agreement class — 'success' is the only class that
 *  carries an agreement target; the rest are reported, never scored. */
export type OutcomeClass = 'success' | 'failure' | 'unlabelled' | 'unverified' | 'none';

/** One replayable decision — the journal row plus its parsed state and
 *  its outcome's class. */
export interface ReplayDecision {
  decisionId: string;
  contextId: string;
  createdAt: number;
  taskText: string;
  /** the carried inputs — informational, rides the detail record */
  task?: unknown;
  candidates: ReplayCandidate[];
  /** route name → declaration index in the journaled table snapshot */
  tableOrder: Map<string, number>;
  tableHash: string | null;
  formulaHash: string | null;
  /** the formula's prose rubric for the pick state — absent when no
   *  formula drove the decision or its text no longer parses */
  rubric?: string;
  /** the success predicate THIS decision journaled — labels its own
   *  outcome (default merged_first_round) */
  predicate: SuccessPredicate;
  /** the route the decision historically executed — NULL only on rows
   *  that fit nothing (never replayable: empty candidates skip first) */
  observedRoute: string | null;
  outcomeClass: OutcomeClass;
  /** the verified outcome's raw result — merged|failed|abandoned|parked */
  outcomeResult?: string;
  /** pending routes the T0 stage left behind — before/after delta on
   *  the journaled cascade trace (0 when no trace was journaled) */
  pending: number;
  pendingNeeds: boolean;
}

/** A journaled row that cannot be replayed — counted, never scored. */
export interface SkippedDecision {
  decisionId: string;
  reason: ReplaySkipReason;
}

// ---------------------------------------------------------------------------
// Contenders
// ---------------------------------------------------------------------------

/** What one contender answers for one decision. */
export type ContenderAnswer =
  | {
      status: 'answered';
      /** the route name picked — null = the contender named nothing
       *  confident (an answer, not a skip: it counts as a miss) */
      pick: string | null;
      latencyMs: number;
      costUsd?: number;
    }
  | { status: 'skipped'; reason: string }
  | {
      status: 'failed';
      error: string;
      /** the request reached the provider before failing — spend was
       *  possibly incurred but never reported, so the call counts as
       *  unknown-cost (a bind failure or an abort skip made no call) */
      callMade?: boolean;
      /** elapsed ms when a call was made — failed calls belong in the
       *  latency distribution too */
      latencyMs?: number;
    };

/** The per-decision input every contender sees — identical for all of
 *  them, so denominators stay comparable. */
export interface ContenderInput {
  decision: ReplayDecision;
  /** the journaled judge configuration — provider/mode identity */
  judgeConfig?: unknown;
  /** the invoke gate's verdict for THIS decision — model contenders
   *  honor it; built-ins never consult it */
  askModel: boolean;
  gateReason: string;
}

/** One bench contender — a built-in code stage or a configured
 *  provider's judge surface. */
export interface BenchContender {
  id: string;
  kind: 'builtin' | 'model';
  /** provider entry name + pinned model for model contenders */
  provider?: string;
  model?: string;
  /** set when the contender could not bind — reported as failed, the
   *  run continues without it */
  bindError?: string;
  answer(input: ContenderInput): Promise<ContenderAnswer>;
}

// ---------------------------------------------------------------------------
// Parsing the journaled state
// ---------------------------------------------------------------------------

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** A record keyed by DATA (route names, provider ids, journaled
 *  results) — null-prototype so a '__proto__' route name lands as an
 *  own key, never mutates the prototype (the routePick criteria guard,
 *  applied to the report's accumulators). */
const ownBag = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** The report's boundary — a data-keyed bag back to a plain object.
 *  fromEntries lands '__proto__' as an own data property (never the
 *  prototype), so the safety survives serialization. */
const plainBag = <T>(bag: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(bag)) as Record<string, T>;

/** The candidates the decision had — RouteCandidate[] or a bare route
 *  list; only the name + description survive into the replay input. */
function parseCandidates(raw: string | null): ReplayCandidate[] | ReplaySkipReason {
  if (raw === null) return 'missing-candidates';
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return 'unparseable-candidates';
  const out: ReplayCandidate[] = [];
  for (const item of parsed) {
    const route =
      typeof item === 'object' && item !== null
        ? ((item as { route?: unknown }).route ?? item)
        : undefined;
    if (typeof route !== 'object' || route === null) continue;
    const r = route as { name?: unknown; description?: unknown; chain?: unknown };
    if (typeof r.name !== 'string' || r.name === '') continue;
    const chain = Array.isArray(r.chain) ? r.chain : [];
    const providers = chain
      .map(e =>
        typeof e === 'object' && e !== null
          ? String((e as { provider?: unknown }).provider ?? '')
          : ''
      )
      .filter(p => p !== '');
    out.push({
      name: r.name,
      description:
        typeof r.description === 'string' && r.description !== ''
          ? r.description
          : `chain: ${providers.join(' → ') || '(empty)'}`,
    });
  }
  return out.length === 0 ? 'empty-candidates' : out;
}

/** The journaled table snapshot → route name → declaration index. The
 *  static-table contender orders by this — the table's own order, never
 *  the journaled (possibly recall-reordered) candidate order. */
function parseTableOrder(raw: string | null): Map<string, number> | ReplaySkipReason {
  if (raw === null) return 'missing-table';
  const parsed = parseJson(raw);
  const routes =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { routes?: unknown }).routes
      : undefined;
  if (!Array.isArray(routes)) return 'unparseable-table';
  const order = new Map<string, number>();
  routes.forEach((route, i) => {
    const name =
      typeof route === 'object' && route !== null ? (route as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && name !== '' && !order.has(name)) {
      order.set(name, i);
    }
  });
  return order.size === 0 ? 'unparseable-table' : order;
}

/** The T0 stage's pending count — before/after delta on the journaled
 *  cascade trace. Every pending route carries ≥1 unresolved need by
 *  construction (cascadeT0 only pends on missing answers), so
 *  pendingNeeds is the same fact. Absent trace → 0/false. */
function pendingFromStages(raw: string | null): { pending: number; pendingNeeds: boolean } {
  const parsed = parseJson(raw) as
    | { cascade?: { stages?: Array<{ stage?: string; before?: unknown; after?: unknown }> } }
    | undefined;
  const stages = parsed?.cascade?.stages;
  if (!Array.isArray(stages)) return { pending: 0, pendingNeeds: false };
  const t0 = stages.find(s => s?.stage === 'T0');
  const before = Array.isArray(t0?.before) ? t0.before.length : 0;
  const after = Array.isArray(t0?.after) ? t0.after.length : 0;
  const pending = Math.max(0, before - after);
  return { pending, pendingNeeds: pending > 0 };
}

/** The formula's prose rubric — parsed leniently; a formula text that
 *  no longer parses still replays, just without the rubric. */
function rubricOf(formulaText: string | null, formulaPath: string | null): string | undefined {
  if (formulaText === null) return undefined;
  try {
    const prose = parseFormulaText(formulaText, formulaPath ?? 'formula.md').prose;
    return prose === '' ? undefined : prose;
  } catch {
    return undefined;
  }
}

const asPredicate = (raw: string | null): SuccessPredicate =>
  raw !== null && (SUCCESS_PREDICATES as readonly string[]).includes(raw)
    ? (raw as SuccessPredicate)
    : DEFAULT_SUCCESS_PREDICATE;

/** Parse one journaled row into replay state, or name the skip reason.
 *  Required replay state: task text, the candidate set, and the table
 *  snapshot — the three things every contender's answer is checked
 *  against. Everything else degrades gracefully. */
export function parseReplayDecision(row: DecisionRow): ReplayDecision | SkippedDecision {
  const skip = (reason: ReplaySkipReason): SkippedDecision => ({
    decisionId: row.decisionId,
    reason,
  });
  if (row.taskText === null || row.taskText.trim() === '') {
    return skip('missing-task-text');
  }
  const candidates = parseCandidates(row.candidatesJson);
  if (typeof candidates === 'string') {
    return skip(candidates);
  }
  const tableOrder = parseTableOrder(row.tableJson);
  if (typeof tableOrder === 'string') {
    return skip(tableOrder);
  }
  const { pending, pendingNeeds } = pendingFromStages(row.stageAnswers);
  return {
    decisionId: row.decisionId,
    contextId: row.contextId,
    createdAt: row.createdAt,
    taskText: row.taskText,
    task: parseJson(row.taskJson),
    candidates,
    tableOrder,
    tableHash: row.tableHash,
    formulaHash: row.formulaHash,
    rubric: rubricOf(row.formulaText, row.formulaPath),
    predicate: asPredicate(row.successPredicate),
    observedRoute: row.route,
    outcomeClass: 'none', // filled by classifyOutcome
    pending,
    pendingNeeds,
  };
}

/** The outcome's agreement class — verified successes under the
 *  decision's own predicate are the ONLY rows with an agreement
 *  target; everything else is reported, never scored. */
export function classifyOutcome(
  outcome: OutcomeRow | undefined,
  predicate: SuccessPredicate
): OutcomeClass {
  if (outcome === undefined) return 'none';
  if (outcome.verified !== 1) return 'unverified';
  const label = labelOutcome({ result: outcome.result, rounds: outcome.rounds }, predicate);
  if (label === 'success') return 'success';
  if (label === 'unlabelled') return 'unlabelled';
  return 'failure';
}

// ---------------------------------------------------------------------------
// Built-in contenders — the code stages, no model
// ---------------------------------------------------------------------------

/** `static-table` — T0 only: the candidate earliest in the journaled
 *  table's declaration order. The baseline every model must beat. */
function staticTableContender(): BenchContender {
  return {
    id: 'static-table',
    kind: 'builtin',
    answer: async ({ decision }) => {
      const started = performance.now();
      const ranked = [...decision.candidates].sort((a, b) => {
        const ia = decision.tableOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const ib = decision.tableOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });
      return {
        status: 'answered',
        pick: ranked[0]?.name ?? null,
        latencyMs: performance.now() - started,
      };
    },
  };
}

/** `t1-recall` — FTS5 top-k over verified outcomes, frozen to the rows
 *  that existed BEFORE the decision (its own outcome excluded). The
 *  free contender: decided route when recall clears its thresholds,
 *  else the top of the recall order — exactly what T1 hands the next
 *  stage in production. */
function t1RecallContender(deps: { db: RouterDb; tuning: RecallTuning }): BenchContender {
  return {
    id: 't1-recall',
    kind: 'builtin',
    answer: async ({ decision }) => {
      const started = performance.now();
      const names = decision.candidates.map(c => c.name);
      const rows: RecallOutcomeRow[] = await recallOutcomeRows(deps.db, {
        contextId: decision.contextId,
        text: decision.taskText,
        tableHash: decision.tableHash ?? '',
        formulaHash: decision.formulaHash,
        routes: names,
        predicate: decision.predicate,
        limit: deps.tuning.k * 4,
        before: decision.createdAt,
        excludeDecisionId: decision.decisionId,
      });
      const eligible = recallVotingWindow(rows, names, deps.tuning.k, decision.predicate);
      const { votes, order } = recallVotes(eligible, names, decision.predicate);
      const verdict = recallDecision(votes, deps.tuning, names);
      return {
        status: 'answered',
        pick: verdict.decided ?? order[0] ?? null,
        latencyMs: performance.now() - started,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Model contenders — configured provider entries, never hard-wired
// ---------------------------------------------------------------------------

/** Consecutive decide() failures that abort a model contender — a dead
 *  provider must not bill the whole journal's timeouts. */
const MODEL_ABORT_STREAK = 5;

/** A model contender — `provider` or `provider/model` naming a
 *  configured `providers` entry. The re-ask is the route-pick question
 *  over the journaled candidate set; the judge is bound through the
 *  same providerJudge seam production uses, minus any fallback chain —
 *  the bench measures THIS contender, not an escalation policy. */
function modelContender(deps: {
  id: string;
  provider: string;
  model?: string;
  entry: ProviderEntry;
  providers: Record<string, ProviderEntry>;
  judge: JudgeConfig;
  /** the command's shared decide() budget — `judge.maxDecisionsPerRun`
   *  is a per-invocation cost bound enforced by the consuming command
   *  (judge config contract); every model contender spends from it */
  runBudget: { remaining: number };
  makeJudge?: (provider: string, model: string | undefined) => JudgeFacade | Promise<JudgeFacade>;
}): BenchContender {
  const { id, provider, model, entry, providers, judge, runBudget } = deps;
  let facade: JudgeFacade | undefined;
  let bindFailure: string | undefined;
  const bind = async (): Promise<JudgeFacade> => {
    if (facade !== undefined) return facade;
    // a bind that already failed fails the same way — no retry storm
    // against a provider that cannot serve the call surface
    if (bindFailure !== undefined) throw new Error(bindFailure);
    try {
      if (deps.makeJudge !== undefined) {
        facade = await deps.makeJudge(provider, model);
      } else {
        const bound = providerJudge(provider, entry, judge, {
          ...(model === undefined ? {} : { model }),
          keyField: providerKeyField(provider, providers),
        });
        facade = chainedJudge(bound, undefined, {
          confidence: judge.confidence,
          timeoutMs: judge.timeoutMs,
        });
      }
    } catch (err) {
      bindFailure = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return facade;
  };
  let streak = 0;
  let aborted: string | undefined;
  const contender: BenchContender = {
    id,
    kind: 'model',
    provider,
    ...(model === undefined ? {} : { model }),
    answer: async input => {
      // the invoke gate decides first — a decision it never asked is a
      // skip even on an aborted contender, never an execution failure
      if (!input.askModel) {
        return { status: 'skipped', reason: input.gateReason };
      }
      if (aborted !== undefined) {
        return { status: 'failed', error: `contender aborted — ${aborted}` };
      }
      if (runBudget.remaining <= 0) {
        // the configured per-invocation decide() bound is spent — an
        // explicit no-call skip, not a silent pass and never a failure
        return { status: 'skipped', reason: 'run-budget' };
      }
      const { decision } = input;
      const options = decision.candidates.map(c => ({ name: c.name, description: c.description }));
      const questions = routePickQuestions(options);
      const state =
        decision.rubric === undefined
          ? { task: decision.taskText }
          : { task: decision.taskText, rubric: decision.rubric };
      const started = performance.now();
      let res: DecideResult;
      let bound = false;
      try {
        const judge = await bind();
        bound = true;
        runBudget.remaining -= 1; // the invocation is the spend — count it before it lands
        res = await judge.decide(state, questions);
      } catch (err) {
        streak += 1;
        const error = err instanceof Error ? err.message : String(err);
        // a BIND failure is the contender's own defect — it rides
        // bindError so the metrics row reports 'failed', not 0%. A
        // decide() failure is per-call: the failed count carries it
        // and a later success still lands the contender's verdict
        if (!bound) contender.bindError ??= error;
        if (streak >= MODEL_ABORT_STREAK) {
          aborted = `${streak} consecutive decide() failures — last: ${error}`;
        }
        return {
          status: 'failed',
          error,
          ...(bound ? { callMade: true, latencyMs: performance.now() - started } : {}),
        };
      }
      streak = 0;
      const latencyMs = performance.now() - started;
      const answer = res.answers['route'];
      const confident =
        answer?.type === 'choice' &&
        !res.lowConfidence.includes('route') &&
        options.some(o => o.name === answer.choice);
      return {
        status: 'answered',
        pick: confident && answer?.type === 'choice' ? answer.choice : null,
        latencyMs,
        ...(res.usage?.costUsd === undefined ? {} : { costUsd: res.usage.costUsd }),
      };
    },
  };
  return contender;
}

// ---------------------------------------------------------------------------
// Contender resolution — --judges ids → contenders
// ---------------------------------------------------------------------------

export const BUILTIN_CONTENDERS = ['static-table', 't1-recall'] as const;

/** Parse one --judges id: 'static-table' | 't1-recall' | 'provider' |
 *  'provider/model'. Returns the parts, or undefined for builtins. */
export function parseJudgeId(
  id: string
): { builtin: string } | { provider: string; model?: string } | undefined {
  if ((BUILTIN_CONTENDERS as readonly string[]).includes(id)) {
    return { builtin: id };
  }
  const slash = id.indexOf('/');
  if (slash <= 0) {
    return { provider: id };
  }
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  return model === '' ? { provider } : { provider, model };
}

/** Resolve the contender list — builtins always available; a provider
 *  id names a configured `providers` entry (never a hard-wired model).
 *  An id that names nothing is a usage error naming what exists. */
export function resolveContenders(opts: {
  judges: string[];
  providers: Record<string, ProviderEntry>;
  judge: JudgeConfig;
  db: RouterDb;
  recall: RecallTuning;
  /** the run's shared decide() budget — injected so the report can
   *  tell the bound was hit; defaults to `judge.maxDecisionsPerRun`
   *  (absent = unbounded, the test seam's shape) */
  runBudget?: { remaining: number };
  makeJudge?: (provider: string, model: string | undefined) => JudgeFacade | Promise<JudgeFacade>;
}): BenchContender[] {
  const runBudget = opts.runBudget ?? {
    remaining: opts.judge.maxDecisionsPerRun ?? Number.POSITIVE_INFINITY,
  };
  const out: BenchContender[] = [];
  // dedup — a repeated id would collide on the detail record's picks
  for (const id of [...new Set(opts.judges)]) {
    const parsed = parseJudgeId(id);
    if (parsed === undefined) continue;
    if ('builtin' in parsed) {
      out.push(
        parsed.builtin === 'static-table'
          ? staticTableContender()
          : t1RecallContender({ db: opts.db, tuning: opts.recall })
      );
      continue;
    }
    const { provider, model } = parsed;
    // hasOwn — a provider named '__proto__' must not resolve through
    // the prototype chain into a phantom entry
    const entry = Object.hasOwn(opts.providers, provider) ? opts.providers[provider] : undefined;
    if (entry === undefined) {
      throw new Error(
        `unknown contender "${id}" — built-ins: ${BUILTIN_CONTENDERS.join(', ')}; ` +
          `providers: ${Object.keys(opts.providers).join(', ') || '(none configured)'}`
      );
    }
    out.push(
      modelContender({
        id,
        provider,
        ...(model === undefined ? {} : { model }),
        entry,
        providers: opts.providers,
        judge: opts.judge,
        runBudget,
        ...(opts.makeJudge === undefined ? {} : { makeJudge: opts.makeJudge }),
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metrics + report
// ---------------------------------------------------------------------------

/** One contender's score row — the markdown table's line and the JSON's
 *  entry. */
export interface ContenderMetrics {
  id: string;
  kind: 'builtin' | 'model';
  provider?: string;
  model?: string;
  /** 'ok' ran; 'failed' could not bind or never answered — reported as
   *  failed, NEVER as 0% agreement */
  status: 'ok' | 'failed';
  error?: string;
  /** decisions the contender answered (pick may be null = abstained) */
  answered: number;
  /** answered with no confident pick — counted as misses, not skips */
  abstained: number;
  /** decisions the invoke gate kept from the model — no call made */
  skipped: number;
  /** decide() errors — infra honesty: a dead contender is 'failed',
   *  its answered set simply stays small */
  failed: number;
  /** historical agreement — agreed / labelled over verified-success
   *  outcomes only; null when nothing was labelled */
  agreement: { labelled: number; agreed: number } | null;
  latencyMs: { n: number; p50: number; p95: number; mean: number } | null;
  /** measured spend — costUsdPer1k stays 'unknown' while any made
   *  call reported no cost — answered without usage or failed after
   *  reaching the provider (unknown is never zero) */
  cost: { totalUsd: number; knownCalls: number; unknownCalls: number };
  costUsdPer1k: number | 'unknown';
  /** answered picks by route — the disagreement evidence */
  picks: Record<string, number>;
}

/** The journal window's accounting — what the replay saw and what it
 *  could not use. */
export interface JournalReport {
  path: string;
  window: { since: number | null; until: number };
  contexts: string[];
  /** decision rows in the window */
  decisions: number;
  /** rows with complete replay state */
  replayable: number;
  /** rows skipped, by reason */
  skipped: Record<string, number>;
  /** replayable rows by outcome class */
  outcomeClasses: Record<OutcomeClass, number>;
  /** verified outcomes by raw result — failed/abandoned/parked are
   *  reported separately, never folded into agreement */
  outcomeResults: Record<string, number>;
}

export interface BenchReplayReport {
  generatedAt: string;
  journal: JournalReport;
  /** the invoke policy model contenders ran under + how many
   *  decisions its gate would have skipped anyway */
  invoke: { mode: InvokeMode; ambiguousSkips: number };
  /** calibration — outcome-quality claims need a paired-run dataset
   *  with measured outcomes per compared route on the same tasks
   *  (bro-l8c4f.9). Until one is pinned the metric is unavailable —
   *  reported, never fabricated. */
  calibration: { status: 'unavailable'; reason: string };
  contenders: ContenderMetrics[];
  /** per-decision picks — the evidence behind every aggregate */
  detail: Array<{
    decisionId: string;
    contextId: string;
    createdAt: number;
    observedRoute: string | null;
    outcomeClass: OutcomeClass;
    outcomeResult?: string;
    predicate: SuccessPredicate;
    picks: Record<string, string | null | 'skipped' | 'failed'>;
  }>;
  notes: string[];
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

/** Fold one contender's answers into its metrics row. */
function tallyContender(
  contender: BenchContender,
  rows: Array<{ decision: ReplayDecision; answer: ContenderAnswer }>
): ContenderMetrics {
  const metrics: ContenderMetrics = {
    id: contender.id,
    kind: contender.kind,
    ...(contender.provider === undefined ? {} : { provider: contender.provider }),
    ...(contender.model === undefined ? {} : { model: contender.model }),
    status: contender.bindError === undefined ? 'ok' : 'failed',
    ...(contender.bindError === undefined ? {} : { error: contender.bindError }),
    answered: 0,
    abstained: 0,
    skipped: 0,
    failed: 0,
    agreement: null,
    latencyMs: null,
    cost: { totalUsd: 0, knownCalls: 0, unknownCalls: 0 },
    costUsdPer1k: 'unknown',
    picks: ownBag<number>(),
  };
  const latencies: number[] = [];
  let labelled = 0;
  let agreed = 0;
  let madeCalls = 0;
  let costKnown = true;
  for (const { decision, answer } of rows) {
    if (answer.status === 'skipped') {
      metrics.skipped += 1;
      continue;
    }
    if (answer.status === 'failed') {
      metrics.failed += 1;
      if (contender.kind === 'model' && answer.callMade === true) {
        // a request that may have been sent carries unreported spend —
        // the cost metric stays 'unknown' rather than a lowball
        metrics.cost.unknownCalls += 1;
        costKnown = false;
      }
      if ('latencyMs' in answer && typeof answer.latencyMs === 'number') {
        latencies.push(answer.latencyMs);
      }
      continue;
    }
    metrics.answered += 1;
    if (answer.pick === null) {
      metrics.abstained += 1;
    } else {
      metrics.picks[answer.pick] = (metrics.picks[answer.pick] ?? 0) + 1;
    }
    latencies.push(answer.latencyMs);
    madeCalls += 1;
    // cost accounting is a MODEL concern — a code stage makes no call
    // and reports no spend; its per-1k is zero by construction
    if (contender.kind === 'model') {
      if (answer.costUsd === undefined) {
        metrics.cost.unknownCalls += 1;
        costKnown = false;
      } else {
        metrics.cost.knownCalls += 1;
        metrics.cost.totalUsd += answer.costUsd;
      }
    }
    // historical agreement — verified-success outcomes only, and only
    // when the decision actually executed a route to compare against
    if (
      decision.outcomeClass === 'success' &&
      decision.observedRoute !== null &&
      answer.pick !== null
    ) {
      labelled += 1;
      if (answer.pick === decision.observedRoute) agreed += 1;
    } else if (decision.outcomeClass === 'success' && decision.observedRoute !== null) {
      // an abstained contender WAS asked — it counts in the labelled
      // denominator as a miss, never as a skip
      labelled += 1;
    }
  }
  if (metrics.status === 'ok' && metrics.answered === 0 && metrics.failed > 0) {
    // every call failed — the contender produced no verdict at all;
    // that is a failed contender, not a 0% agreement
    metrics.status = 'failed';
    metrics.error ??= 'every decide() call failed';
  }
  if (labelled > 0) {
    metrics.agreement = { labelled, agreed };
  }
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    metrics.latencyMs = {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    };
  }
  // cost per 1k decisions — the denominator is every decision the
  // contender was EVALUATED on (answered + skipped + failed): a skip
  // costs nothing and belongs in the amortized figure. Builtins are
  // free by construction; a model is 'unknown' while any made call —
  // answered or failed in flight — reported no cost.
  const evaluated = metrics.answered + metrics.skipped + metrics.failed;
  if (contender.kind === 'builtin') {
    metrics.costUsdPer1k = 0;
  } else if (evaluated > 0 && madeCalls > 0 && costKnown) {
    metrics.costUsdPer1k = (metrics.cost.totalUsd / evaluated) * 1000;
  } else if (evaluated > 0 && madeCalls === 0 && costKnown) {
    // every evaluated decision skipped or failed before reaching the
    // provider — nothing was spent
    metrics.costUsdPer1k = 0;
  } else {
    metrics.costUsdPer1k = 'unknown';
  }
  metrics.picks = plainBag(metrics.picks);
  return metrics;
}

// ---------------------------------------------------------------------------
// The replay run
// ---------------------------------------------------------------------------

export interface BenchReplayOptions {
  /** the working dir — config anchor for providers/judge/recall/invoke */
  dir: string;
  /** the ledger path — default routerStorePath() */
  storePath?: string;
  /** epoch ms — decisions at/after this replay; absent = whole journal */
  since?: number;
  /** scope to one context namespace */
  contextId?: string;
  /** contender ids — builtins + provider[/model]; absent = the default
   *  set (builtins + the configured decision provider) */
  judges?: string[];
  /** invoke override — default brouter.router.invoke ?? 'ambiguous' */
  invoke?: InvokeMode;
  /** test seams — the store handle, providers, judge config, recall
   *  tuning, the judge factory, and the report clock */
  db?: RouterDb;
  closeDb?: () => void;
  providers?: Record<string, ProviderEntry>;
  judge?: JudgeConfig;
  recall?: { k?: number; minAgreement?: number; minRows?: number };
  makeJudge?: (provider: string, model: string | undefined) => JudgeFacade | Promise<JudgeFacade>;
  now?: number;
}

const REPORT_NOTES = [
  'historical agreement compares picks to the route that historically executed — ' +
    'it is agreement, not routing accuracy; the observed route is not a ' +
    'counterfactual oracle and an untried route is unknown, never incorrect',
  'agreement counts verified successful outcomes under each decision’s own ' +
    'success predicate only; failed/abandoned/parked rows carry no agreement ' +
    'target, unlabelled and unverified rows are excluded and counted',
  'calibration requires a paired-run dataset with measured outcomes per ' +
    'compared route (bro-l8c4f.9) — not measured here',
  'T1 recall is frozen to outcome rows accepted before each decision, its own ' +
    'outcome excluded — recall cannot retrieve its test label',
  'replay writes nothing to router.db — no journal rows, no cache entries, ' + 'no outcome reports',
];

/** The default contender set — the two built-in code stages plus the
 *  configured decision provider when one exists (the incumbent the
 *  bench exists to compare against). */
function defaultJudges(provider: string | undefined): string[] {
  return provider === undefined ? [...BUILTIN_CONTENDERS] : [...BUILTIN_CONTENDERS, provider];
}

/** Run the replay — scan the journal, classify outcomes, ask every
 *  contender, fold the metrics. Pure over its inputs: same journal +
 *  same contenders → same report (the clock is the only wall). */
export async function runBenchReplay(opts: BenchReplayOptions): Promise<BenchReplayReport> {
  const now = opts.now ?? Date.now();
  // the store — injected in tests, else the ledger at storePath (or the
  // default location). Replay only READS it: no journal writes, no
  // cache entries, no outcome reports.
  let db: RouterDb;
  let close: () => void;
  if (opts.db !== undefined) {
    db = opts.db;
    close = () => opts.closeDb?.();
  } else {
    const handle = openStore(opts.storePath ?? routerStorePath());
    if (!handle.ok) {
      throw new Error(`brouter bench: the ledger is unavailable — ${handle.reason}`);
    }
    db = handle.db;
    close = () => {
      handle.close();
      opts.closeDb?.();
    };
  }
  try {
    migrateStore(db);
    const rows = await listDecisions(db, {
      ...(opts.contextId === undefined ? {} : { contextId: opts.contextId }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
    });

    // parse + classify every row first — the skip ledger and the
    // outcome classes are journal facts, computed once for all
    // contenders so denominators stay comparable
    const decisions: ReplayDecision[] = [];
    const skipped: Record<string, number> = ownBag();
    const contexts = new Set<string>();
    for (const row of rows) {
      // every journaled row's context counts toward the window —
      // replayable or skipped alike
      contexts.add(row.contextId);
      const parsed = parseReplayDecision(row);
      if ('reason' in parsed) {
        skipped[parsed.reason] = (skipped[parsed.reason] ?? 0) + 1;
        continue;
      }
      const outcome = await getOutcome(db, parsed.decisionId);
      parsed.outcomeClass = classifyOutcome(outcome, parsed.predicate);
      // the results histogram counts VERIFIED verdicts only — a pending
      // (unverified) report is not a terminal outcome yet
      parsed.outcomeResult = outcome?.verified === 1 ? outcome.result : undefined;
      decisions.push(parsed);
    }

    const outcomeClasses: Record<OutcomeClass, number> = {
      success: 0,
      failure: 0,
      unlabelled: 0,
      unverified: 0,
      none: 0,
    };
    const outcomeResults: Record<string, number> = ownBag();
    for (const d of decisions) {
      outcomeClasses[d.outcomeClass] += 1;
      if (d.outcomeResult !== undefined) {
        outcomeResults[d.outcomeResult] = (outcomeResults[d.outcomeResult] ?? 0) + 1;
      }
    }

    // contenders + the invoke gate — the gate is a property of the
    // DECISION (candidate count + pending needs), identical for every
    // model contender; built-ins never consult it. Providers resolve
    // through the same synthesized registry production binds — legacy
    // judge.* aliases included — unless a test injected its own.
    const cfg = loadConfig(opts.dir);
    const invoke: InvokeMode = opts.invoke ?? cfg.brouter?.router?.invoke ?? 'ambiguous';
    const jcfgAll = judgeConfig(opts.dir);
    const jcfg = opts.judge ?? jcfgAll.judge;
    const recallT = recallTuning(opts.recall ?? cfg.brouter?.router?.recall);
    const providers = opts.providers ?? synthesizedProviders(jcfgAll.judge, jcfgAll.providers);
    const judges = opts.judges ?? defaultJudges(cfg.brouter?.router?.provider);
    // the configured decide() bound — `judge.maxDecisionsPerRun` is a
    // per-invocation cost bound the replay command enforces itself;
    // every model contender spends from this one purse
    const runBudget = {
      remaining: jcfg.maxDecisionsPerRun ?? Number.POSITIVE_INFINITY,
    };
    const contenders = resolveContenders({
      judges,
      providers,
      judge: jcfg,
      db,
      recall: recallT,
      runBudget,
      ...(opts.makeJudge === undefined ? {} : { makeJudge: opts.makeJudge }),
    });

    // ambiguous-share — how many decisions the ambiguous gate would
    // skip regardless of the configured mode (the cascade's savings
    // question the epic asks)
    let ambiguousSkips = 0;
    for (const d of decisions) {
      const gate = shouldInvokeT2({
        invoke: 'ambiguous',
        candidates: d.candidates.length,
        pending: d.pending,
        pendingNeeds: d.pendingNeeds,
      });
      if (!gate.ask) ambiguousSkips += 1;
    }

    // the replay itself — decision-major order so a contender's
    // answers land in journal order (deterministic output)
    const detail: BenchReplayReport['detail'] = [];
    const perContender = new Map<
      string,
      Array<{ decision: ReplayDecision; answer: ContenderAnswer }>
    >();
    for (const c of contenders) perContender.set(c.id, []);
    for (const decision of decisions) {
      const gate = shouldInvokeT2({
        invoke,
        candidates: decision.candidates.length,
        pending: decision.pending,
        pendingNeeds: decision.pendingNeeds,
      });
      const input: ContenderInput = {
        decision,
        askModel: gate.ask,
        gateReason: gate.reason,
      };
      const picks: Record<string, string | null | 'skipped' | 'failed'> = ownBag();
      for (const contender of contenders) {
        let answer: ContenderAnswer;
        try {
          answer = await contender.answer(input);
        } catch (err) {
          // a contender that throws is FAILED for this decision —
          // reported as failed, never as a 0% agreement
          answer = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
        perContender.get(contender.id)!.push({ decision, answer });
        picks[contender.id] = answer.status === 'answered' ? answer.pick : answer.status;
      }
      detail.push({
        decisionId: decision.decisionId,
        contextId: decision.contextId,
        createdAt: decision.createdAt,
        observedRoute: decision.observedRoute,
        outcomeClass: decision.outcomeClass,
        ...(decision.outcomeResult === undefined ? {} : { outcomeResult: decision.outcomeResult }),
        predicate: decision.predicate,
        picks: plainBag(picks),
      });
    }

    const metrics = contenders.map(c => tallyContender(c, perContender.get(c.id) ?? []));

    // the journal's own coverage end — the newest row's timestamp (or
    // the run clock when the window is empty)
    const journalEnd = rows.reduce((m, r) => Math.max(m, r.createdAt), 0);
    return {
      generatedAt: new Date(now).toISOString(),
      journal: {
        path: opts.storePath ?? routerStorePath(),
        window: {
          since: opts.since ?? null,
          until: journalEnd === 0 ? now : journalEnd,
        },
        contexts: [...contexts].sort(),
        decisions: rows.length,
        replayable: decisions.length,
        skipped: plainBag(skipped),
        outcomeClasses,
        outcomeResults: plainBag(outcomeResults),
      },
      invoke: { mode: invoke, ambiguousSkips },
      calibration: {
        status: 'unavailable',
        reason:
          'calibration needs a paired-run dataset with measured outcomes per ' +
          'compared route (bro-l8c4f.9) — none is pinned',
      },
      contenders: metrics,
      detail,
      notes: [
        ...REPORT_NOTES,
        ...(runBudget.remaining <= 0
          ? [
              'judge.maxDecisionsPerRun bounded this replay — decisions past ' +
                'the bound report skipped (run-budget)',
            ]
          : []),
      ],
    };
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Rendering — the markdown table + the artifact writer
// ---------------------------------------------------------------------------

const fmtInt = (n: number): string => String(Math.round(n));
const fmtPct = (a: { labelled: number; agreed: number } | null): string =>
  a === null || a.labelled === 0 ? '—' : `${((100 * a.agreed) / a.labelled).toFixed(1)}%`;
const fmtCost = (v: number | 'unknown'): string =>
  v === 'unknown' ? 'unknown' : `$${v.toFixed(4)}`;

/** The markdown report — journal window and row counts up front, one
 *  table row per contender, the honesty notes underneath. */
export function formatBenchReport(report: BenchReplayReport): string {
  const j = report.journal;
  const lines: string[] = [];
  lines.push('# brouter bench — classifier replay');
  lines.push('');
  lines.push(
    `journal: \`${j.path}\` · window ${j.window.since === null ? 'all time' : new Date(j.window.since).toISOString()} → ${new Date(j.window.until).toISOString()}`
  );
  lines.push(
    `decisions: ${j.decisions} journaled · ${j.replayable} replayable · skipped ${
      Object.entries(j.skipped)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || 'none'
    }`
  );
  lines.push(
    `outcomes: ${
      Object.entries(j.outcomeClasses)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || 'none'
    } · verified results ${
      Object.entries(j.outcomeResults)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || 'none'
    }`
  );
  lines.push(
    `invoke=${report.invoke.mode} · ambiguous-gate skips ${report.invoke.ambiguousSkips}/${j.replayable}`
  );
  lines.push('');
  lines.push(
    '| contender | kind | agreement | labelled | p50 ms | p95 ms | cost/1k | skipped | failed |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of report.contenders) {
    const lat = c.latencyMs;
    lines.push(
      `| ${c.id}${c.status === 'failed' ? ' ⚠' : ''} | ${c.kind} | ${c.status === 'failed' ? `failed — ${c.error ?? 'error'}` : fmtPct(c.agreement)} | ${c.agreement?.labelled ?? 0} | ${lat === null ? '—' : fmtInt(lat.p50)} | ${lat === null ? '—' : fmtInt(lat.p95)} | ${fmtCost(c.costUsdPer1k)} | ${c.skipped} | ${c.failed} |`
    );
  }
  lines.push('');
  lines.push(
    'agreement = historical agreement over verified-success outcomes — not routing accuracy'
  );
  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}
