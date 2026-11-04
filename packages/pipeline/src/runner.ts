/**
 * The pipeline stage-runner — the interpreter half of
 * specs/bro-7d5nb.md. The formula is data (formula.ts); this runner
 * walks its stages:
 *
 *   gate (3 outcomes, fail closed) → journal INTENT → admit? → engine
 *   → journal VERDICT → transition (stage | end|park|retry|close|abandon)
 *
 * `gate_on` evaluates against the pipeline context — the merge of all
 * earlier stage payloads, each also stored under its stage name. A gate
 * that fails synthesizes `skip` (engine never invoked); one that can't
 * evaluate (field absent/malformed) parks with a journal alert — a
 * broken context never fails open.
 *
 * Durability: engines own side effects, the journal owns the resume
 * point. A verdict-less last intent on resume goes through `recheck`
 * (the engine attests whether its side effect landed) — never a blind
 * re-fire. Spawn-like intents ride the `admit` seam, the same
 * go-stamp protocol the agents registry uses: an unadmitted survivor
 * can never double a respawn.
 */
import { type MaybePromise, mintRunId } from '@broject/core';
import {
  entryStage,
  type GateOn,
  type PipelineFormula,
  type PipelineStage,
  SKIP_VERDICT,
  type StageEngine,
  transitionFor,
} from './formula.ts';
import {
  type JournalRow,
  journalRecords,
  openPipelineJournal,
  type PipelineJournal,
} from './journal.ts';

/** The side-effect word a stage's intent carries — derived from its
 *  engine (a formula fact, not handler identity). `spawn` is the
 *  spawn-like intent the `admit` seam gates by default. */
export const STAGE_INTENTS: Record<StageEngine, string> = {
  judge: 'judge',
  fleet: 'spawn',
  'act-gate': 'gate',
  learn: 'capture',
};

/** Intents `opts.admit` is consulted for by default — spawn-like side
 *  effects only. */
export const DEFAULT_ADMIT_INTENTS = ['spawn'];

/** `pipeline.maxAttempts` — contiguous same-stage retry budget. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** `pipeline.fixRounds` — scoped-fix re-entry budget; default mirrors
 *  the act.maxRounds loop contract (spec §review). */
export const DEFAULT_FIX_ROUNDS = 3;

/** The verdict name a scoped-fix re-entry binds to — `review.fix →
 *  work` re-enters work with `notes` as its scope. */
export const DEFAULT_FIX_VERDICT = 'fix';

/** Fail-closed park tags stamped on alert rows. */
export const PARK_ALERTS = {
  gateIndeterminate: 'gate-indeterminate',
  engineUnavailable: 'engine-unavailable',
  fixNotesMissing: 'fix-notes-missing',
  fixRoundsExhausted: 'fix-rounds-exhausted',
  attemptsExhausted: 'attempts-exhausted',
  missingTransition: 'missing-transition',
  formulaDrift: 'formula-drift',
  recheckUnavailable: 'recheck-unavailable',
} as const;
export type ParkAlert = (typeof PARK_ALERTS)[keyof typeof PARK_ALERTS];

/** The accumulated pipeline context — payloads merge flat AND under
 *  their stage name, so `complexity` and `classify.complexity` both
 *  resolve. */
export type PipelineContext = Record<string, unknown>;

/** What an engine returns — the verdict tag plus the typed payload the
 *  next stage reads. */
export interface EngineResult {
  verdict: string;
  payload?: unknown;
}

/** One engine invocation — everything a stage handler needs, nothing
 *  pipeline-internal leaks further. */
export interface StageCall {
  runId: string;
  item: string;
  stage: PipelineStage;
  /** nth invocation of this stage entry (retry bumps it) */
  attempt: number;
  /** scoped-fix round — set on review.fix → work re-entry */
  fixRound?: number;
  /** the fix scope — the review's `notes`, set on scoped re-entry */
  notes?: string;
  ctx: PipelineContext;
  journal: PipelineJournal;
  dir?: string;
}

export type EngineFn = (call: StageCall) => MaybePromise<EngineResult>;

/** Resume verdict for a verdict-less intent: an EngineResult settles
 *  the record ("landed, here's the outcome"), 'pending' means the side
 *  effect is still in flight (runner parks WITHOUT a new row — the
 *  pending intent stays the resume anchor), and undefined attests
 *  "checked, didn't land" → the runner re-fires under its attempt
 *  budget. An engine that cannot tell must return 'pending', not
 *  undefined — undefined IS the attestation that re-fires. With NO
 *  hook bound at all the runner never re-fires a spawn-like intent
 *  blind (recheck-unavailable park). */
export type RecheckFn = (call: StageCall) => MaybePromise<EngineResult | 'pending' | undefined>;

/** An engine binding — `invoke` runs the stage; `recheck` is the
 *  resume hook attesting whether a journaled intent already landed. */
export interface EngineHandler {
  invoke: EngineFn;
  recheck?: RecheckFn;
}

/** Engines by formula name — a bare function is an invoke-only
 *  handler. Real engines land in later beads; this seam is what the
 *  runner and the fake-engine tests share. */
export type EngineMap = Partial<Record<StageEngine, EngineFn | EngineHandler>>;

/** The go-marker seam (spec §write-ahead journal — spawn idempotence
 *  rides the registry go-stamp protocol). Consulted before a
 *  spawn-like intent's side effect fires: `true` admits the attempt
 *  and the engine is invoked; an EngineResult means admission itself
 *  produced the verdict (a refusal mapped to `queue`/`rate_limited`)
 *  and the engine is skipped. The pending record completes either way. */
export type AdmitFn = (call: StageCall) => MaybePromise<true | EngineResult>;

export type RunOutcome = 'end' | 'park' | 'close' | 'abandon';

export interface RunResult {
  runId: string;
  item: string;
  outcome: RunOutcome;
  /** stage the run ended/suspended at — park re-enters here on wake */
  stage: string;
  verdict?: string;
  alert?: string;
  detail?: string;
  ctx: PipelineContext;
}

export interface RunOptions {
  engines: EngineMap;
  /** repo dir resolving the file journal via git common dir */
  dir?: string;
  /** injectable journal — defaults to `openPipelineJournal(dir, runId)` */
  journal?: PipelineJournal;
  /** explicit run id — defaults to a minted one (or the journal's own) */
  runId?: string;
  /** the formula's content-hash stamped on every journal row */
  formulaSha?: string;
  /** go-marker seam — consulted before spawn-like intents */
  admit?: AdmitFn;
  /** which intents count as spawn-like — default ['spawn'] */
  admitIntents?: string[];
  /** contiguous retry budget per stage entry — default 3 */
  maxAttempts?: number;
  /** scoped-fix re-entry budget — default 3 (act.maxRounds contract) */
  fixRounds?: number;
  /** the verdict name scoped-fix mode binds to — default 'fix' */
  fixVerdict?: string;
  /** seed context — journaled payloads replay over it on resume */
  ctx?: PipelineContext;
}

/** One invocation — where the loop is, at which attempt, with what
 *  fix scope. */
interface NextStep {
  stage: string;
  attempt: number;
  fixRound?: number;
  notes?: string;
}

type Step = { go: NextStep } | { halt: RunResult };

interface AlertSpec {
  alert: ParkAlert;
  detail?: string;
  resume?: string;
}

/** The run's threaded context — the Checks-pattern bag that keeps the
 *  helpers under the 4-arg ceiling. */
interface Run {
  formula: PipelineFormula;
  item: string;
  runId: string;
  sha: string;
  dir?: string;
  journal: PipelineJournal;
  engines: Map<string, EngineHandler>;
  admit?: AdmitFn;
  admitIntents: string[];
  maxAttempts: number;
  fixRounds: number;
  fixVerdict: string;
  ctx: PipelineContext;
  seq: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStageName = (run: Run, name: string): boolean =>
  run.formula.stages.some(s => s.name === name);

const intentFor = (stage: PipelineStage): string => STAGE_INTENTS[stage.engine] ?? stage.engine;

/** This run's records only — a shared/injected journal may carry rows
 *  for other run ids; seq order is per-run. */
function recordsOf(run: Run): JournalRow[] {
  return journalRecords(run.journal.rows().filter(r => r.run_id === run.runId));
}

function initRun(
  formula: PipelineFormula,
  item: string,
  opts: RunOptions,
  journal?: PipelineJournal
): Run {
  const runId = opts.runId ?? journal?.runId ?? mintRunId();
  const j =
    journal ?? opts.journal ?? (opts.dir ? openPipelineJournal({ dir: opts.dir, runId }) : null);
  if (j === null) {
    throw new Error(
      'pipeline run needs a journal — pass opts.journal, or opts.dir inside a git repo'
    );
  }
  const engines = new Map<string, EngineHandler>();
  for (const [name, e] of Object.entries(opts.engines)) {
    if (e !== undefined) {
      engines.set(name, typeof e === 'function' ? { invoke: e } : e);
    }
  }
  return {
    formula,
    item,
    runId,
    sha: opts.formulaSha ?? '',
    dir: opts.dir,
    journal: j,
    engines,
    admit: opts.admit,
    admitIntents: opts.admitIntents ?? [...DEFAULT_ADMIT_INTENTS],
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    fixRounds: opts.fixRounds ?? DEFAULT_FIX_ROUNDS,
    fixVerdict: opts.fixVerdict ?? DEFAULT_FIX_VERDICT,
    ctx: { ...(opts.ctx ?? {}) },
    seq: 0,
  };
}

function result(
  run: Run,
  outcome: RunOutcome,
  stage: string,
  extra: Partial<RunResult> = {}
): RunResult {
  return { runId: run.runId, item: run.item, outcome, stage, ctx: run.ctx, ...extra };
}

/** Build the intent row — stamped but not yet appended. `seq` mints
 *  here so the completing verdict re-appends the SAME seq. */
function rowFor(run: Run, to: NextStep, intent: string): JournalRow {
  const row: JournalRow = {
    run_id: run.runId,
    item: run.item,
    seq: ++run.seq,
    stage: to.stage,
    intent,
    attempt: to.attempt,
    formula_sha: run.sha,
    ts: new Date().toISOString(),
  };
  if (to.fixRound !== undefined) row.fix_round = to.fixRound;
  if (to.notes !== undefined) row.notes = to.notes;
  return row;
}

/** The completing record — the intent row re-appended with its verdict
 *  (and payload). Same seq: last row wins when records reconstruct. */
function verdictRow(intent: JournalRow, res: EngineResult): JournalRow {
  const row: JournalRow = { ...intent, verdict: res.verdict, ts: new Date().toISOString() };
  if (res.payload !== undefined) {
    row.payload = res.payload;
  }
  return row;
}

/** A fail-closed park — journal the alert, then halt. The run's world
 *  may repair (context, notes, wiring); `resume` names the stage a
 *  wake re-enters. */
function alertStep(run: Run, to: NextStep, a: AlertSpec): Step {
  const row = rowFor(run, to, 'alert');
  row.alert = a.alert;
  if (a.detail !== undefined) row.detail = a.detail;
  if (a.resume !== undefined) row.resume = a.resume;
  run.journal.append(row);
  return { halt: result(run, 'park', to.stage, { alert: a.alert, detail: a.detail }) };
}

/** A gate field lookup — dotted paths walk nested records
 *  (`classify.complexity`), a bare name reads the flat merge. */
function ctxField(ctx: PipelineContext, field: string): unknown {
  let cur: unknown = ctx;
  for (const key of field.split('.')) {
    if (!isRecord(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

type GateOutcome = 'pass' | 'fail' | 'indeterminate';

/** Three outcomes, never a silent bypass: pass runs the engine, fail
 *  synthesizes `skip`, indeterminate (absent or non-scalar field)
 *  fails closed to park — the review gate cannot fail open. */
function evaluateGate(g: GateOn | undefined, ctx: PipelineContext): GateOutcome {
  if (g === undefined) {
    return 'pass';
  }
  const v = ctxField(ctx, g.field);
  if (v === undefined || v === null) {
    return 'indeterminate';
  }
  if (typeof v === 'object') {
    return 'indeterminate'; // objects/arrays can't answer a scalar gate
  }
  const same = String(v) === g.value;
  if (g.op === '==') {
    return same ? 'pass' : 'fail';
  }
  return same ? 'fail' : 'pass';
}

function stageCall(run: Run, stage: PipelineStage, to: NextStep): StageCall {
  return {
    runId: run.runId,
    item: run.item,
    stage,
    attempt: to.attempt,
    fixRound: to.fixRound,
    notes: to.notes,
    ctx: run.ctx,
    journal: run.journal,
    dir: run.dir,
  };
}

/** A side effect's provenance — `viaAdmit` marks a verdict the
 *  admission seam produced without invoking the engine. Its payload is
 *  refusal detail, not stage output, so it is journaled with
 *  `admit: true` and never absorbed into the pipeline context. */
interface SideEffect {
  res: EngineResult;
  viaAdmit: boolean;
}

/** The side effect: consult `admit` first for spawn-like intents (the
 *  go-marker seam — an EngineResult back means admission itself
 *  produced the verdict and the engine never runs). */
async function sideEffect(
  run: Run,
  stage: PipelineStage,
  handler: EngineHandler,
  to: NextStep
): Promise<SideEffect> {
  const call = stageCall(run, stage, to);
  if (run.admit !== undefined && run.admitIntents.includes(intentFor(stage))) {
    const admitted = await run.admit(call);
    if (admitted !== true) {
      return { res: admitted, viaAdmit: true };
    }
  }
  return { res: await handler.invoke(call), viaAdmit: false };
}

/** Payload → context: stored under its stage name AND merged flat (the
 *  two addressing forms a gate field can take). Non-record payloads
 *  store stage-scoped only. */
function absorb(run: Run, stage: string, payload: unknown): void {
  run.ctx[stage] = payload;
  if (isRecord(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      run.ctx[k] = v;
    }
  }
}

/** The fix scope — required non-empty, else the re-entry is scopeless
 *  and fails closed. The verdict's own payload wins over the flat
 *  merge (an earlier stage's `notes` can't satisfy it). */
function notesFor(run: Run, payload: unknown): string | undefined {
  const v = isRecord(payload) && typeof payload.notes === 'string' ? payload.notes : undefined;
  const notes = v ?? run.ctx.notes;
  return typeof notes === 'string' && notes.trim() !== '' ? notes : undefined;
}

/** Scoped-fix rounds consumed — the highest fix_round journaled. */
function fixRoundsUsed(run: Run): number {
  return recordsOf(run).reduce((m, r) => Math.max(m, r.fix_round ?? 0), 0);
}

/** Transition into another stage — plain re-entry, or the scoped-fix
 *  mode when the verdict binds it: notes REQUIRED non-empty (else park
 *  + alert, never a scopeless re-entry) and rounds bounded (exhaustion
 *  parks, never loops). */
function reentryStep(run: Run, out: EngineResult, target: string, to: NextStep): Step {
  if (out.verdict !== run.fixVerdict) {
    return { go: { stage: target, attempt: 1 } };
  }
  const notes = notesFor(run, out.payload);
  if (notes === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.fixNotesMissing,
      detail: `${to.stage}.${out.verdict} → ${target} requires non-empty notes`,
      resume: to.stage,
    });
  }
  const round = fixRoundsUsed(run) + 1;
  if (round > run.fixRounds) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.fixRoundsExhausted,
      detail: `${round - 1}/${run.fixRounds} fix rounds spent`,
      resume: to.stage,
    });
  }
  return { go: { stage: target, attempt: 1, fixRound: round, notes } };
}

/** `retry` — re-run the SAME stage, bounded by the attempt budget;
 *  exhaustion falls to park (spec §terminal actions). */
function retryStep(run: Run, to: NextStep): Step {
  if (to.attempt >= run.maxAttempts) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.attemptsExhausted,
      detail: `${to.attempt}/${run.maxAttempts} attempts spent`,
      resume: to.stage,
    });
  }
  return { go: { stage: to.stage, attempt: to.attempt + 1 } };
}

/** Terminal targets that map 1:1 to a run outcome — `park` and `retry`
 *  are the only actions with their own mechanics. */
const TERMINAL_OUTCOMES: ReadonlyMap<string, RunOutcome> = new Map([
  ['end', 'end'],
  ['close', 'close'],
  ['abandon', 'abandon'],
]);

/** Where a verdict takes the run — stage re-entry, retry, park, or a
 *  terminal outcome. `out` is the just-settled verdict+payload; `to`
 *  is the invocation that produced it. */
function transitionStep(run: Run, out: EngineResult, to: NextStep): Step {
  const target = transitionFor(run.formula, to.stage, out.verdict);
  if (target === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.missingTransition,
      detail: `${to.stage}.${out.verdict} has no transition`,
      resume: to.stage,
    });
  }
  if (isStageName(run, target)) {
    return reentryStep(run, out, target, to);
  }
  if (target === 'retry') {
    return retryStep(run, to);
  }
  if (target === 'park') {
    return { halt: result(run, 'park', to.stage, { verdict: out.verdict }) };
  }
  const outcome = TERMINAL_OUTCOMES.get(target);
  if (outcome !== undefined) {
    return { halt: result(run, outcome, to.stage, { verdict: out.verdict }) };
  }
  return alertStep(run, to, {
    alert: PARK_ALERTS.missingTransition,
    detail: `unknown transition target ${JSON.stringify(target)}`,
    resume: to.stage,
  });
}

/** A gated stage that failed — journal the synthesized `skip` (intent
 *  'gate', verdict 'skip', complete in one row: no side effect means
 *  no crash window), then follow its transition. */
function skipStage(run: Run, to: NextStep): Step {
  const row = rowFor(run, to, 'gate');
  run.journal.append({ ...row, verdict: SKIP_VERDICT });
  return transitionStep(run, { verdict: SKIP_VERDICT }, to);
}

/** intent → (admit →) engine → verdict → transition, journaled
 *  write-ahead. An engine throw propagates: the pending intent IS the
 *  crash marker resume re-checks. */
async function invokeStage(run: Run, stage: PipelineStage, to: NextStep): Promise<Step> {
  const handler = run.engines.get(stage.engine);
  if (handler === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.engineUnavailable,
      detail: `no engine bound for "${stage.engine}"`,
      resume: stage.name,
    });
  }
  const intent = rowFor(run, to, intentFor(stage));
  run.journal.append(intent);
  const { res, viaAdmit } = await sideEffect(run, stage, handler, to);
  const done = verdictRow(intent, res);
  if (viaAdmit) {
    done.admit = true;
  }
  run.journal.append(done);
  if (!viaAdmit) {
    absorb(run, stage.name, res.payload);
  }
  return transitionStep(run, res, to);
}

/** One loop tick: stage exists → gate → skip or invoke. */
async function stepOnce(run: Run, to: NextStep): Promise<Step> {
  const stage = run.formula.stages.find(s => s.name === to.stage);
  if (stage === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.formulaDrift,
      detail: `stage "${to.stage}" is not in this formula`,
      resume: to.stage,
    });
  }
  const gate = evaluateGate(stage.gate_on, run.ctx);
  if (gate === 'indeterminate') {
    return alertStep(run, to, {
      alert: PARK_ALERTS.gateIndeterminate,
      detail: `${stage.gate_on?.field} is absent or malformed in the pipeline context`,
      resume: stage.name,
    });
  }
  return gate === 'fail' ? skipStage(run, to) : invokeStage(run, stage, to);
}

async function drive(run: Run, start: NextStep): Promise<RunResult> {
  let to = start;
  for (;;) {
    const step = await stepOnce(run, to);
    if ('halt' in step) {
      return step.halt;
    }
    to = step.go;
  }
}

/** Re-fire a verdict-less intent with NO recheck hook bound: never
 *  for spawn-like intents (an unadmitted-marker world cannot be told
 *  apart from a landed one — fail closed), else a fresh bounded
 *  attempt. */
function refire(run: Run, stage: PipelineStage, last: JournalRow, to: NextStep): Step {
  if (run.admitIntents.includes(intentFor(stage))) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.recheckUnavailable,
      detail: `"${stage.engine}" has no recheck hook — a spawn-like intent is never re-fired blind`,
      resume: last.stage,
    });
  }
  return refireAttempt(run, last, to);
}

/** A bounded re-fire — a fresh intent at attempt+1, parked once the
 *  attempt budget is spent. Reached by the no-hook path and by a hook
 *  that attested "didn't land" (any intent kind — the hook IS the
 *  attestation). */
function refireAttempt(run: Run, last: JournalRow, to: NextStep): Step {
  if (last.attempt >= run.maxAttempts) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.attemptsExhausted,
      detail: `${last.attempt}/${run.maxAttempts} attempts spent`,
      resume: last.stage,
    });
  }
  return { go: { stage: last.stage, attempt: last.attempt + 1 } };
}

/** A recheck verdict settles the pending record — same seq completes
 *  it — then the transition applies as if the engine had just answered. */
function settleRecheck(run: Run, last: JournalRow, res: EngineResult, to: NextStep): Step {
  run.journal.append(verdictRow(last, res));
  absorb(run, last.stage, res.payload);
  return unpark(last, transitionStep(run, res, to));
}

/** The pending-intent path: ask the engine whether its side effect
 *  landed. 'pending' → park WITHOUT a new row — the verdict-less
 *  intent stays the resume anchor and the next wake re-checks again.
 *  The no-hook branch is the fail-closed one; an existing hook that
 *  answers undefined attested "didn't land" — re-firing THAT is safe
 *  for any intent kind. */
async function recheckStep(run: Run, last: JournalRow, to: NextStep): Promise<Step> {
  const stage = run.formula.stages.find(s => s.name === last.stage);
  if (stage === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.formulaDrift,
      detail: `stage "${last.stage}" is not in this formula`,
      resume: last.stage,
    });
  }
  const recheck = run.engines.get(stage.engine)?.recheck;
  if (recheck === undefined) {
    return refire(run, stage, last, to);
  }
  const r = await recheck(stageCall(run, stage, to));
  if (r === 'pending') {
    return { halt: result(run, 'park', last.stage, { detail: 'side effect still in flight' }) };
  }
  return r === undefined ? refireAttempt(run, last, to) : settleRecheck(run, last, r, to);
}

/** Parked runs resume by re-entering the SAME stage (spec §terminal
 *  actions) — a verdict whose transition is `park` becomes a fresh
 *  attempt on resume instead of another halt. Alert parks keep their
 *  halt. */
function unpark(last: JournalRow, step: Step): Step {
  const parked = 'halt' in step && step.halt.outcome === 'park' && step.halt.alert === undefined;
  return parked ? { go: { stage: last.stage, attempt: 1 } } : step;
}

function toFromRecord(r: JournalRow): NextStep {
  return { stage: r.stage, attempt: r.attempt, fixRound: r.fix_round, notes: r.notes };
}

/** A mid-run formula change — the journal's sha and the loaded
 *  formula's disagree — is an operator decision, never auto-resumed. */
function drifted(run: Run, last: JournalRow): boolean {
  return run.sha !== '' && last.formula_sha !== '' && last.formula_sha !== run.sha;
}

/** Where a journaled run continues: alert → the row's resume stage;
 *  verdict-less intent → recheck (never blind re-fire); settled → its
 *  transition (park re-enters, terminal replays as the outcome). */
async function resumeStep(run: Run, last: JournalRow): Promise<Step> {
  const to = toFromRecord(last);
  if (drifted(run, last)) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.formulaDrift,
      detail: `journal sha ${last.formula_sha.slice(0, 12)}… ≠ loaded formula`,
      resume: last.stage,
    });
  }
  if (last.alert !== undefined) {
    return { go: { stage: last.resume ?? last.stage, attempt: 1 } };
  }
  if (last.verdict === undefined) {
    return recheckStep(run, last, to);
  }
  return unpark(last, transitionStep(run, { verdict: last.verdict, payload: last.payload }, to));
}

/** A row that produced real stage output — alerts carry no verdict,
 *  admit rows carry refusal detail (not stage output, and skipping
 *  them here keeps the replayed context identical to the live one). */
const settledRow = (r: JournalRow): boolean =>
  r.alert === undefined && r.verdict !== undefined && r.admit !== true;

/** Journaled payloads replay into the context — verdict-settled
 *  records only, in seq order (a pending intent produced nothing). */
function replayCtx(run: Run, records: JournalRow[]): void {
  for (const r of records) {
    if (settledRow(r)) {
      absorb(run, r.stage, r.payload);
    }
  }
}

/** The shared entry: reconstruct journal state, then drive — fresh at
 *  the entry stage, or from wherever the journal last settled. */
async function begin(run: Run): Promise<RunResult> {
  const records = recordsOf(run);
  run.seq = records.reduce((m, r) => Math.max(m, r.seq), 0);
  replayCtx(run, records);
  const last = records.at(-1);
  if (last === undefined) {
    return drive(run, { stage: entryStage(run.formula).name, attempt: 1 });
  }
  const step = await resumeStep(run, last);
  return 'halt' in step ? step.halt : drive(run, step.go);
}

/** Run an item through the formula from the top — or continue the
 *  journal when `runId`/`journal` already carries one (a "run" over a
 *  non-empty journal IS a resume: the journal is the state). */
export async function runPipeline(
  formula: PipelineFormula,
  item: string,
  opts: RunOptions
): Promise<RunResult> {
  return begin(initRun(formula, item, opts));
}

/** Resume a run from its journal — the same engine as
 *  {@link runPipeline} with the journal recovered by the caller.
 *  Reads the last record: a verdict-less intent re-checks first
 *  (engine `recheck` hook, `admit` for spawn-like intents), an alert
 *  re-enters its `resume` stage, a settled record applies its
 *  transition — a `park` target re-enters the same stage, terminal
 *  targets replay the outcome. */
export async function resumePipeline(
  formula: PipelineFormula,
  item: string,
  journal: PipelineJournal,
  opts: RunOptions
): Promise<RunResult> {
  return begin(initRun(formula, item, opts, journal));
}
