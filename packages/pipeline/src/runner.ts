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
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MaybePromise, mintRunId } from '@broject/core';
import {
  entryStage,
  type GateOn,
  isTerminalAction,
  type PipelineFormula,
  type PipelineStage,
  SKIP_VERDICT,
  type StageEngine,
  transitionFor,
} from './formula.ts';
import {
  fileJournal,
  type JournalRow,
  journalRecords,
  openPipelineJournal,
  type PipelineJournal,
  pendingRecord,
  pipelineDir,
} from './journal.ts';

/** The side-effect word a stage's intent carries — derived from its
 *  engine (a formula fact, not handler identity). `spawn` is the
 *  spawn-like intent the `admit` seam gates by default. */
export const STAGE_INTENTS: Record<StageEngine, string> = {
  judge: 'judge',
  fleet: 'spawn',
  'act-gate': 'gate',
  learn: 'capture',
  intake: 'spec',
  e2e: 'verify',
  accept: 'emit',
};

/** Intents `opts.admit` is consulted for by default — spawn-like side
 *  effects only. */
export const DEFAULT_ADMIT_INTENTS = ['spawn'];

/** `pipeline.maxAttempts` — contiguous same-stage retry budget. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Stage-entry budget for one wake — every stepOnce tick counts.
 *  Verdict loops (work → rate_limited → route → spawn → work) don't
 *  consume attempts, so a global step bound is what makes any cycle
 *  bounded; 32 covers ~3 fix rounds plus retries with headroom. */
export const DEFAULT_MAX_STEPS = 32;

/** `pipeline.fixRounds` — scoped-fix re-entry budget; default mirrors
 *  the act.maxRounds loop contract (spec §review). */
export const DEFAULT_FIX_ROUNDS = 3;

/** The verdict name a scoped-fix re-entry binds to — `review.fix →
 *  work` re-enters work with `notes` as its scope. */
export const DEFAULT_FIX_VERDICT = 'fix';

/** The verdict names a scoped-fix re-entry binds to by default —
 *  `review.fix`, the accept gate's `rejected`, AND verify's `failed`
 *  all re-enter `work` with the emitter's `notes` as the fix scope
 *  (spec §stage semantics: review's internal scope, the customer's
 *  rejection notes, and the failed-AC scope share one fail-closed
 *  contract). */
export const DEFAULT_FIX_VERDICTS = [DEFAULT_FIX_VERDICT, 'rejected', 'failed'];

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
  admissionUnavailable: 'admission-unavailable',
  itemMismatch: 'item-mismatch',
  cycleExhausted: 'cycle-budget-exhausted',
  /** an accept-gate verdict signed by anyone but the run's recorded
   *  customer — a worker can never self-accept */
  customerMismatch: 'customer-mismatch',
  /** the customer's verdict record failed shape validation — a
   *  record the stage cannot trust never settles the gate */
  verdictMalformed: 'verdict-malformed',
  /** the customer's answer record failed shape validation — drained
   *  and consumed so the same bad row can't re-alert every wake */
  answerMalformed: 'answer-malformed',
} as const;
export type ParkAlert = (typeof PARK_ALERTS)[keyof typeof PARK_ALERTS];

/** The capacity-wait park tag — stamped on an alert row when an item
 *  is held out of a saturated stage (or the pipeline itself, under
 *  `limits.in_flight`). Deliberately NOT in PARK_ALERTS: that union is
 *  the fail-closed contract (the world must repair before a wake
 *  helps), while a saturated park waits for a slot to free — an
 *  occupant's verdict transitioning it out is the wake. Same
 *  queue-shaped semantics as `route`'s `queue` verdict on
 *  `QUEUE_REASONS.saturated`: the item suspends at the stage's door
 *  (`resume` = the stage it was entering) and a later wake re-checks
 *  occupancy before letting it in. */
export const SATURATION_ALERT = 'stage-saturated';

/** Journal events stamped on alert rows that are NOT fail-closed
 *  parks — durable markers a `ParkAlert` union must not absorb, so
 *  callers can rely on `PARK_ALERTS` meaning "this row parked". */
export const JOURNAL_EVENTS = {
  /** journaled when an operator resumes past a formula-drift alert —
   *  the recorded acknowledgement, not a park */
  driftAcknowledged: 'drift-acknowledged',
} as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[keyof typeof JOURNAL_EVENTS];

/** The accumulated pipeline context — payloads merge flat AND under
 *  their stage name, so `complexity` and `classify.complexity` both
 *  resolve. */
export type PipelineContext = Record<string, unknown>;

/** What an engine returns to settle a stage — the verdict tag plus
 *  the typed payload the next stage reads. */
export interface EngineResult {
  verdict: string;
  payload?: unknown;
}

/** A fail-closed park an engine asks for — the runner journals the
 *  alert row and halts; a wake re-enters the stage (the run's world
 *  may repair: a corrected verdict record, restored context). `alert`
 *  names a PARK_ALERTS tag or an engine-local one; the run never
 *  moves on an engine alert — that is the whole contract. */
export interface EngineAlert {
  alert: string;
  detail?: string;
}

/** An engine's answer — a settling verdict, 'pending' while the
 *  journaled side effect is still in flight, or a fail-closed alert.
 *  'pending' from `invoke` means the side effect FIRED but the stage
 *  cannot settle yet (the accept gate's emit awaiting the customer's
 *  out-of-band verdict): the runner parks WITHOUT a verdict row, so
 *  the intent stays the resume anchor a later wake's `recheck`
 *  settles — identical semantics to a recheck 'pending'. */
export type EngineOutcome = EngineResult | 'pending' | EngineAlert;

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
  /** the run's recorded customer identity (opts.customer) — carried on
   *  the call, never inside ctx, so a stage payload can never
   *  overwrite it: the accept gate compares a verdict's `accepted_by`
   *  against exactly this field (a worker can never self-accept). */
  customer?: string;
  ctx: PipelineContext;
  journal: PipelineJournal;
  dir?: string;
}

export type EngineFn = (call: StageCall) => MaybePromise<EngineOutcome>;

/** Resume verdict for a verdict-less intent: an EngineResult settles
 *  the record ("landed, here's the outcome"), 'pending' means the side
 *  effect is still in flight (runner parks WITHOUT a new row — the
 *  pending intent stays the resume anchor), an EngineAlert parks
 *  fail-closed with a journal alert row, and undefined attests
 *  "checked, didn't land" → the runner re-fires under its attempt
 *  budget. An engine that cannot tell must return 'pending', not
 *  undefined — undefined IS the attestation that re-fires. With NO
 *  hook bound at all the runner never re-fires a spawn-like intent
 *  blind (recheck-unavailable park). */
export type RecheckFn = (call: StageCall) => MaybePromise<EngineOutcome | undefined>;

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
 *  and the engine is skipped. The seam is NOT optional once a
 *  spawn-like intent fires: an unbound `admit` fails closed to an
 *  `admission-unavailable` park rather than spawning without a
 *  go-marker. */
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
  /** injectable journal — defaults to `openPipelineJournal(dir, runId)`.
   *  One runner owns a journal file: `fileJournal` reads once at
   *  construction and mirrors its own appends, so two live runners on
   *  the same file see disjoint histories and can double side
   *  effects — resume with a freshly-opened journal, never share. */
  journal?: PipelineJournal;
  /** explicit run id — defaults to a minted one (or the journal's own) */
  runId?: string;
  /** the formula's content-hash stamped on every journal row —
   *  REQUIRED: without it mid-run formula drift can't be detected and
   *  drift checks silently no-op. `formulaSha(tomlText)` computes it. */
  formulaSha: string;
  /** go-marker seam — consulted before spawn-like intents */
  admit?: AdmitFn;
  /** which intents count as spawn-like — default ['spawn'] */
  admitIntents?: string[];
  /** contiguous retry budget per stage entry — default 3 */
  maxAttempts?: number;
  /** stage-entry budget per wake — bounds verdict loops between
   *  stages (rate_limited re-route cycles never consume attempts) */
  maxSteps?: number;
  /** scoped-fix re-entry budget — default 3 (act.maxRounds contract) */
  fixRounds?: number;
  /** the machine budget — what the box CAN run (the caller binds a
   *  `fleet.maxConcurrent`/`agents.<kind>.maxBatchWorkers`-style cap).
   *  Composes with the formula the way `route`'s occupancy guard
   *  composes its `cap`: the effective in-flight limit is
   *  `min(formula.limits.in_flight, maxInFlight)` — the formula limit
   *  is the contract (what this flow MAY run), the machine number can
   *  only narrow it. 0 or absent = no machine cap, the formula limit
   *  stands alone (same `cap ≤ 0` = uncapped convention as
   *  `RouteLoad.cap`). */
  maxInFlight?: number;
  /** the verdict name scoped-fix mode binds to — default 'fix'
   *  (single-name shorthand for {@link RunOptions.fixVerdicts}) */
  fixVerdict?: string;
  /** the verdict names scoped-fix mode binds to — default
   *  {@link DEFAULT_FIX_VERDICTS} (`fix` + `rejected`: the internal
   *  review's fix AND the customer's rejection both re-enter work
   *  with `notes` as scope under the same fail-closed contract) */
  fixVerdicts?: string[];
  /** the run's recorded customer identity — who may sign `accept`
   *  verdicts. Recorded at run creation; carried on the StageCall,
   *  never inside ctx, so no engine payload can overwrite it. Absent
   *  means no identity can pass the accept gate — stages needing it
   *  fail loud. */
  customer?: string;
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
  /** a PARK_ALERTS tag or an engine-local fail-closed tag */
  alert: string;
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
  /** set from `opts.dir` — occupancy counts every `*.journal.jsonl`
   *  under the pipeline dir, not just the run's own file: a
   *  file-backed journal sees this run alone, and a cap counting
   *  only itself never trips. The injected journal's rows still add
   *  to the view (a store spans whatever it returns). */
  occupancyDir?: string;
  /** the sibling-run-file snapshot — read once on the first
   *  `flowTails` call of a wake, cached for the whole drive (a
   *  per-step rescan reads every sibling file O(steps × files)) */
  siblingRows?: JournalRow[];
  journal: PipelineJournal;
  engines: Map<string, EngineHandler>;
  admit?: AdmitFn;
  admitIntents: string[];
  maxAttempts: number;
  maxSteps: number;
  steps: number;
  fixRounds: number;
  fixVerdicts: string[];
  /** effective pipeline cap — min(formula limits.in_flight, machine
   *  budget); stage caps narrow it further, never widen it */
  inFlight: number;
  customer?: string;
  ctx: PipelineContext;
  seq: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStageName = (run: Run, name: string): boolean =>
  run.formula.stages.some(s => s.name === name);

const intentFor = (stage: PipelineStage): string => STAGE_INTENTS[stage.engine] ?? stage.engine;

/** This run's records only — a shared/injected journal may carry rows
 *  for other run ids AND items; seq order is per-run. */
function recordsOf(run: Run): JournalRow[] {
  return journalRecords(
    run.journal.rows().filter(r => r.run_id === run.runId && r.item === run.item)
  );
}

/** One flow's tail — where its last journaled record leaves it
 *  (spec §Concurrency: "the journaled stage occupancy IS the
 *  semaphore"). `moving` means the item is still inside the pipeline
 *  and counts toward `limits.in_flight`; `stage` is the stage it
 *  occupies — a stage occupies an item between its intent and its
 *  verdict-settled transition out, so:
 *
 *  - verdict-less intent → occupies `stage` (the crash window counts —
 *    a crashed runner resumes with the same counts). It holds the
 *    `in_flight` lane too, EXCEPT an `emit` intent: the accept gate's
 *    suspension is a customer wait, not work in flight (same as
 *    intake's settled `questions` park, which never counted);
 *  - settled `emit` verdict → the customer wait ENDED, but the run
 *    still holds no in_flight lane — it never took one. The next
 *    stage entry must pass admission like a fresh wake: reading the
 *    settled record as "already moving" would let the flow walk into
 *    its target over another flow's seat;
 *  - settled verdict → the transition decides: `retry` re-enters the
 *    SAME stage (the item never left — still occupies it); a stage
 *    target means the item is mid-transit — moving, occupying nothing
 *    until the target's intent lands; `park`/terminal/unknown targets
 *    mean the flow suspended or ended — not moving, occupying nothing;
 *  - alert row → parked out of the active set — neither.
 */
interface FlowTail {
  moving: boolean;
  stage?: string;
}

function flowTail(formula: PipelineFormula, records: JournalRow[]): FlowTail {
  const last = records.at(-1);
  if (last === undefined || last.alert !== undefined) {
    return { moving: false };
  }
  if (last.verdict === undefined) {
    // a pending intent occupies its stage — the crash window counts.
    // EXCEPT the `emit` suspension on the ADMISSION lane: accept's
    // pending intent parks for an unbounded customer wait the same
    // way intake's settled `questions` verdict does — an input wait
    // is not pipeline work, and under the serial default one parked
    // accept would hold the only slot forever. The stage seat stays
    // (an accept-level `concurrency` cap still bounds the gate).
    const customerWait = last.intent === STAGE_INTENTS.accept;
    return { moving: !customerWait, stage: last.stage };
  }
  if (last.intent === STAGE_INTENTS.accept) {
    // the verdict settled a CUSTOMER-WAIT intent — the wait is over
    // but the flow holds no in_flight lane: the pending emit never
    // took one. The next stage's door re-passes admission — settling
    // the wait is not occupying the lane.
    return { moving: false };
  }
  const target = transitionFor(formula, last.stage, last.verdict);
  if (target === 'retry') {
    return { moving: true, stage: last.stage };
  }
  if (target !== undefined && !isTerminalAction(target)) {
    return { moving: true };
  }
  return { moving: false };
}

/** Every `*.journal.jsonl` under the pipeline dir — read ONCE per
 *  wake and cached on the run: `flowTails` runs per stage entry, and
 *  a per-step rescan would read every sibling file O(steps × files)
 *  deep in a synchronous loop tick. Within one wake only THIS run
 *  appends, and its rows come live from `run.journal` anyway — the
 *  sibling view at wake time is the honest semaphore.
 *
 *  `ENOENT` alone means "no pipeline dir yet — this run is alone".
 *  Every other readdirSync failure, and an unreadable sibling file,
 *  throws like the run's own journal would: a semaphore that can't
 *  see the plane must fail CLOSED — narrowing to the run's own rows
 *  on EACCES/EMFILE/ENOTDIR would admit past cap on an empty view. */
function siblingJournalRows(dir: string): JournalRow[] {
  const d = pipelineDir({ dir });
  if (d === null) {
    return [];
  }
  let files: string[];
  try {
    files = readdirSync(d);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
  const rows: JournalRow[] = [];
  for (const f of files) {
    if (f.endsWith('.journal.jsonl')) {
      rows.push(...fileJournal(join(d, f)).rows());
    }
  }
  return rows;
}

/** The rows occupancy counts — the run's journal view UNIONED with
 *  every `*.journal.jsonl` under the pipeline dir when `opts.dir`
 *  binds one: a file-backed journal carries this run alone, and a cap
 *  counting only itself never trips (a resume re-opens the run's own
 *  file, so the dir scan is what keeps the semaphore honest across
 *  processes). An unreadable sibling throws like the run's own file
 *  would — a flow that can't be counted must not be silently ignored
 *  by a semaphore. */
function occupancyRows(run: Run): JournalRow[] {
  if (run.occupancyDir === undefined) {
    return run.journal.rows();
  }
  run.siblingRows ??= siblingJournalRows(run.occupancyDir);
  return [...run.journal.rows(), ...run.siblingRows];
}

/** Every other flow's tail, reconstructed from the journal — rows
 *  group per run_id BEFORE seq-collapse (seqs are per-run; collapsing
 *  across runs would merge unrelated intents). This run's own rows are
 *  excluded: its slot is already held, never counted against itself. */
function flowTails(run: Run): FlowTail[] {
  const byRun = new Map<string, JournalRow[]>();
  for (const r of occupancyRows(run)) {
    if (r.run_id === run.runId) {
      continue;
    }
    const g = byRun.get(r.run_id);
    if (g === undefined) {
      byRun.set(r.run_id, [r]);
    } else {
      g.push(r);
    }
  }
  return [...byRun.values()].map(rows => flowTail(run.formula, journalRecords(rows)));
}

/** Is THIS run still moving — its own tail, same rule as the others. */
const selfMoving = (run: Run): boolean => flowTail(run.formula, recordsOf(run)).moving;

/** Effective cap on a stage — `concurrency` narrows the pipeline cap,
 *  never widens it; absent → the pipeline cap applies (spec
 *  §Concurrency). */
const stageCap = (run: Run, stage: PipelineStage): number =>
  Math.min(stage.concurrency ?? run.inFlight, run.inFlight);

/** Effective pipeline cap — the formula contract vs the machine
 *  budget: `min(limits.in_flight, maxInFlight)`, where a machine cap
 *  of 0/absent is uncapped (route's occupancy-guard convention: a
 *  `cap` that can't trip is no cap). */
function inFlightFor(formula: PipelineFormula, opts: RunOptions): number {
  const machine = bounded('maxInFlight', opts.maxInFlight, 0, 0);
  return machine > 0 ? Math.min(formula.limits.in_flight, machine) : formula.limits.in_flight;
}

/** The run id: explicit opt wins, else the journal's own (an injected
 *  journal IS the resume identity — minting over it would restart the
 *  run and could re-fire spawn-like effects), else a fresh mint. */
const runIdFor = (opts: RunOptions, journal?: PipelineJournal): string =>
  opts.runId ?? journal?.runId ?? opts.journal?.runId ?? mintRunId();

/** A bound must be a positive integer — NaN/0/negative silently
 *  disables the budget (n > NaN is always false), and a bound that
 *  can't trip is the same defect class as no bound. */
function bounded(name: string, v: number | undefined, dflt: number, min = 1): number {
  const n = v ?? dflt;
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`pipeline run: ${name} must be an integer ≥ ${min}, got ${v}`);
  }
  return n;
}

/** The configured scoped-fix names — `fixVerdicts` wins, the singular
 *  `fixVerdict` pins one name, else the spec pair (fix + rejected).
 *  An explicit empty list opts OUT of scoped-fix binding entirely. */
const fixVerdictList = (opts: RunOptions): string[] =>
  opts.fixVerdicts ??
  (opts.fixVerdict !== undefined ? [opts.fixVerdict] : [...DEFAULT_FIX_VERDICTS]);

/** A usable verdict name — a non-empty string, nothing else. */
const isVerdictName = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The scoped-fix verdict names — a non-array or an entry that names
 *  nothing is invalid input: a binding that names nothing would
 *  silently turn every re-entry unscoped. */
function fixVerdictsFor(opts: RunOptions): string[] {
  const list = fixVerdictList(opts);
  if (!Array.isArray(list) || !list.every(isVerdictName)) {
    throw new Error(
      'pipeline run: fixVerdicts must be an array of non-empty strings (or fixVerdict, a single name)'
    );
  }
  return list;
}

/** The engine-alert shape — `{alert, detail?}` vs EngineResult's
 *  `{verdict, payload?}`; disjoint on the `alert` key (a settled
 *  verdict record never carries one). */
const isEngineAlert = (r: EngineOutcome): r is EngineAlert =>
  isRecord(r) && typeof r.alert === 'string' && r.verdict === undefined;

/** The journal this run writes — injected wins (it IS the resume
 *  identity), else opts.journal, else the file journal under the
 *  git-common dir. None → loud failure, never a stateless run. */
function journalFor(
  opts: RunOptions,
  journal: PipelineJournal | undefined,
  runId: string
): PipelineJournal {
  const j =
    journal ?? opts.journal ?? (opts.dir ? openPipelineJournal({ dir: opts.dir, runId }) : null);
  if (j === null) {
    throw new Error(
      'pipeline run needs a journal — pass opts.journal, or opts.dir inside a git repo'
    );
  }
  return j;
}

/** EngineMap → handler map: a bare function is an invoke-only
 *  handler, an object carries invoke + optional recheck. */
function engineMapFor(engines: EngineMap): Map<string, EngineHandler> {
  const map = new Map<string, EngineHandler>();
  for (const [name, e] of Object.entries(engines)) {
    if (e !== undefined) {
      map.set(name, typeof e === 'function' ? { invoke: e } : e);
    }
  }
  return map;
}

function initRun(
  formula: PipelineFormula,
  item: string,
  opts: RunOptions,
  journal?: PipelineJournal
): Run {
  // REQUIRED, enforced not just typed: '' would silently disable the
  // drift check (drifted() treats an empty sha as "no baseline")
  if (!opts.formulaSha) {
    throw new Error(
      'pipeline run needs opts.formulaSha — the loaded formula hash; ' +
        "'' disables drift detection"
    );
  }
  const runId = runIdFor(opts, journal);
  return {
    formula,
    item,
    runId,
    sha: opts.formulaSha,
    dir: opts.dir,
    // occupancy spans the pipeline dir whenever one is bound — an
    // injected journal's rows UNION in; they never subtract from the
    // durable plane
    occupancyDir: opts.dir,
    journal: journalFor(opts, journal, runId),
    engines: engineMapFor(opts.engines),
    admit: opts.admit,
    admitIntents: opts.admitIntents ?? [...DEFAULT_ADMIT_INTENTS],
    maxAttempts: bounded('maxAttempts', opts.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    maxSteps: bounded('maxSteps', opts.maxSteps, DEFAULT_MAX_STEPS),
    steps: 0,
    // 0 IS a valid fix budget — 'no scoped-fix rounds' parks on the
    // first fix verdict via the normal exhaustion path
    fixRounds: bounded('fixRounds', opts.fixRounds, DEFAULT_FIX_ROUNDS, 0),
    fixVerdicts: fixVerdictsFor(opts),
    inFlight: inFlightFor(formula, opts),
    customer: opts.customer,
    // null-prototype: engine payloads flat-merge onto ctx, and a
    // hostile `__proto__` key must land as inert data, never a setter
    ctx: Object.assign(Object.create(null), opts.ctx) as PipelineContext,
    seq: 0,
  };
}

function result(
  run: Run,
  outcome: RunOutcome,
  stage: string,
  extra: Partial<RunResult> = {}
): RunResult {
  return {
    runId: run.runId,
    item: run.item,
    outcome,
    stage,
    ctx: run.ctx,
    ...extra,
  };
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
  if (run.customer !== undefined) row.customer = run.customer;
  return row;
}

/** The completing record — the intent row re-appended with its verdict
 *  (and payload). Same seq: last row wins when records reconstruct. */
function verdictRow(intent: JournalRow, res: EngineResult): JournalRow {
  const row: JournalRow = {
    ...intent,
    verdict: res.verdict,
    ts: new Date().toISOString(),
  };
  if (res.payload !== undefined) {
    row.payload = res.payload;
  }
  return row;
}

/** A fail-closed park — journal the alert, then halt. The run's world
 *  may repair (context, notes, wiring); `resume` names the stage a
 *  wake re-enters. */
function alertStep(run: Run, to: NextStep, a: AlertSpec): { halt: RunResult } {
  const row = rowFor(run, to, 'alert');
  row.alert = a.alert;
  if (a.detail !== undefined) row.detail = a.detail;
  if (a.resume !== undefined) row.resume = a.resume;
  run.journal.append(row);
  return {
    halt: result(run, 'park', to.stage, { alert: a.alert, detail: a.detail }),
  };
}

/** A gate field lookup — dotted paths walk nested records
 *  (`classify.complexity`), a bare name reads the flat merge. */
function ctxField(ctx: PipelineContext, field: string): unknown {
  let cur: unknown = ctx;
  for (const key of field.split('.')) {
    if (!isRecord(cur)) {
      return undefined;
    }
    cur = Reflect.get(cur, key);
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
    customer: run.customer,
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
  res: EngineOutcome;
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
  // Reflect.set, not bracket writes — on the null-prototype ctx both
  // land as inert own properties, and the static-analysis-clean form
  // says so to the scanner too. A frozen ctx (an engine breached the
  // shared-state contract) makes Reflect.set return false — fail
  // loud rather than continue with the verdict payload missing.
  const set = (key: string, value: unknown): void => {
    if (!Reflect.set(run.ctx, key, value)) {
      throw new TypeError(`pipeline context is not writable (absorb ${stage}.${key})`);
    }
  };
  set(stage, payload);
  if (isRecord(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      set(k, v);
    }
  }
}

/** The fix scope — required non-empty, else the re-entry is scopeless
 *  and fails closed. Only THIS verdict's payload counts: a `notes`
 *  key flat-merged into the context by an earlier stage is stale
 *  scope, not the fix verdict's consent. */
function notesFor(payload: unknown): string | undefined {
  const notes = isRecord(payload) ? payload.notes : undefined;
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
  if (!run.fixVerdicts.includes(out.verdict)) {
    return { go: { stage: target, attempt: 1 } };
  }
  const notes = notesFor(out.payload);
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
 *  exhaustion falls to park (spec §terminal actions). The rest of
 *  `to` carries: a retry during scoped fix keeps its round and notes. */
function retryStep(run: Run, to: NextStep): Step {
  if (to.attempt >= run.maxAttempts) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.attemptsExhausted,
      detail: `${to.attempt}/${run.maxAttempts} attempts spent`,
      resume: to.stage,
    });
  }
  return { go: { ...to, attempt: to.attempt + 1 } };
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
  if (run.admit === undefined && run.admitIntents.includes(intent.intent)) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.admissionUnavailable,
      detail: `"${intent.intent}" is a spawn-like intent and no admit seam is bound — never spawn without a go-marker`,
      resume: to.stage,
    });
  }
  const { res, viaAdmit } = await sideEffect(run, stage, handler, to);
  if (res === 'pending') {
    // the side effect fired but the stage cannot settle (the accept
    // gate's emit awaiting an out-of-band verdict) — park WITHOUT a
    // verdict row: the verdict-less intent stays the resume anchor a
    // later wake's recheck settles, identical to a recheck 'pending'
    return {
      halt: result(run, 'park', to.stage, { detail: 'side effect still in flight' }),
    };
  }
  if (isEngineAlert(res)) {
    return alertStep(run, to, {
      alert: res.alert,
      detail: res.detail,
      resume: to.stage,
    });
  }
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

/** One loop tick: stage exists → admission → gate → occupancy →
 *  skip or invoke. The two capacity checks (spec §Concurrency —
 *  "declared, never assumed") read the journaled occupancy as the
 *  semaphore:
 *
 *  - `in_flight` bounds ADMISSION — a run that is not already moving
 *    (fresh, or waking from a park) may enter only while fewer than
 *    the cap items are moving; a moving run already holds its slot and
 *    flows on. Checked before the gate: even a would-be-skip entry is
 *    an admission.
 *  - `concurrency`/the pipeline cap bounds OCCUPANCY — checked after
 *    the gate because a gate-fail skips the stage entirely (its skip
 *    record settles in one row, so it never occupies a slot).
 *
 *  Either cap refusing parks the item at the stage's door —
 *  `stage-saturated`, `resume` = the stage it was entering — the
 *  queue-shaped path: a wake re-enters here and re-checks. */
async function stepOnce(run: Run, to: NextStep): Promise<Step> {
  const stage = run.formula.stages.find(s => s.name === to.stage);
  if (stage === undefined) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.formulaDrift,
      detail: `stage "${to.stage}" is not in this formula`,
      resume: to.stage,
    });
  }
  const tails = flowTails(run);
  const moving = tails.filter(t => t.moving).length;
  if (!selfMoving(run) && moving >= run.inFlight) {
    return alertStep(run, to, {
      alert: SATURATION_ALERT,
      detail: `in_flight ${run.inFlight} reached — ${moving} item(s) already moving`,
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
  if (gate === 'fail') {
    return skipStage(run, to);
  }
  const cap = stageCap(run, stage);
  const holding = tails.filter(t => t.stage === stage.name).length;
  if (holding >= cap) {
    return alertStep(run, to, {
      alert: SATURATION_ALERT,
      detail: `stage "${stage.name}" cap ${cap} reached — ${holding} item(s) occupying`,
      resume: to.stage,
    });
  }
  return invokeStage(run, stage, to);
}

async function drive(run: Run, start: NextStep): Promise<RunResult> {
  let to = start;
  for (;;) {
    run.steps += 1;
    if (run.steps > run.maxSteps) {
      return alertStep(run, to, {
        alert: PARK_ALERTS.cycleExhausted,
        detail: `>${run.maxSteps} stage entries in one wake — a verdict loop is cycling`,
        resume: to.stage,
      }).halt;
    }
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
    // Halt WITHOUT a row — the pending intent stays the resume anchor:
    // every wake re-checks, and a hook wired since can attest. An
    // alert row here would resume through the alert branch into
    // invokeStage and spawn again on the next wake — the blind
    // re-fire this park exists to prevent.
    return {
      halt: result(run, 'park', last.stage, {
        alert: PARK_ALERTS.recheckUnavailable,
        detail: `"${stage.engine}" has no recheck hook — a spawn-like intent is never re-fired blind`,
      }),
    };
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
  return { go: { ...to, stage: last.stage, attempt: last.attempt + 1 } };
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
  const handler = run.engines.get(stage.engine);
  if (handler?.recheck === undefined) {
    return refire(run, stage, last, to);
  }
  const r = await handler.recheck(stageCall(run, stage, to));
  if (r === 'pending') {
    return {
      halt: result(run, 'park', last.stage, {
        detail: 'side effect still in flight',
      }),
    };
  }
  if (r === undefined) {
    return refireAttempt(run, last, to);
  }
  if (isEngineAlert(r)) {
    // an alert row's resume path re-enters through invokeStage — a
    // blind re-fire of a spawn-like side effect this pending intent
    // still anchors (the same hole refire's no-hook park exists to
    // close). Halt WITHOUT a row: the intent stays the resume anchor
    // and every wake re-asks the hook.
    if (run.admitIntents.includes(intentFor(stage))) {
      return {
        halt: result(run, 'park', last.stage, { alert: r.alert, detail: r.detail }),
      };
    }
    return alertStep(run, to, {
      alert: r.alert,
      detail: r.detail,
      resume: last.stage,
    });
  }
  return settleRecheck(run, last, r, to);
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
  return {
    stage: r.stage,
    attempt: r.attempt,
    fixRound: r.fix_round,
    notes: r.notes,
  };
}

/** A mid-run formula change — the journal's sha and the loaded
 *  formula's disagree — is an operator decision, never auto-resumed. */
function drifted(run: Run, last: JournalRow): boolean {
  return run.sha !== '' && last.formula_sha !== '' && last.formula_sha !== run.sha;
}

/** The operator-acknowledgement record: resuming PAST a formula-drift
 *  alert journals `drift-acknowledged`, keyed to the waived alert's
 *  seq. An alert-type row (never pending, never absorbed) stamped with
 *  the NEW sha — the waiver is durable, and the next resume walks on
 *  without re-acking. */
function driftAck(run: Run, last: JournalRow): void {
  // fix_round/notes ride along — a stop right after this append wakes
  // at the resume stage and must still see the waived run's fix scope
  const row = rowFor(
    run,
    {
      stage: last.resume ?? last.stage,
      attempt: 1,
      fixRound: last.fix_round,
      notes: last.notes,
    },
    'alert'
  );
  row.alert = JOURNAL_EVENTS.driftAcknowledged;
  row.detail = `operator resumed past formula-drift alert seq=${last.seq}`;
  row.resume = last.resume ?? last.stage;
  run.journal.append(row);
}

/** Where a journaled run continues: drift → park (a formula change is
 *  an operator decision, never auto-resumed); alert → the row's
 *  resume stage — a formula-drift alert first journals the operator's
 *  acknowledgement; pending intent → recheck (never blind re-fire);
 *  settled → its transition (park re-enters, terminal replays as the
 *  outcome). `pending` comes from `pendingRecord` — the journal's own
 *  definition of the actionable verdict-less tail. */
async function resumeStep(
  run: Run,
  last: JournalRow,
  pending: JournalRow | undefined
): Promise<Step> {
  const to = toFromRecord(last);
  if (drifted(run, last)) {
    return alertStep(run, to, {
      alert: PARK_ALERTS.formulaDrift,
      detail: `journal sha ${last.formula_sha.slice(0, 12)}… ≠ loaded formula`,
      resume: last.stage,
    });
  }
  if (last.alert !== undefined) {
    if (last.alert === PARK_ALERTS.formulaDrift) {
      driftAck(run, last);
    }
    // fresh attempt series on wake — the fix scope the alert row
    // journaled rides along (an attempts-exhausted scoped-fix park
    // must not lose its round+notes)
    return {
      go: {
        stage: last.resume ?? last.stage,
        attempt: 1,
        fixRound: last.fix_round,
        notes: last.notes,
      },
    };
  }
  if (pending !== undefined) {
    return recheckStep(run, pending, to);
  }
  // pendingRecord already proved the tail is verdict-settled — TS
  // just can't see through the helper
  const settled = { verdict: last.verdict as string, payload: last.payload };
  return unpark(last, transitionStep(run, settled, to));
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

/** A fail-closed park at the entry door — NO row is appended: an
 *  alert stamped under a contested identity (foreign item, imposter
 *  customer) would itself be foreign state and lock both parties
 *  out of resume forever. */
const guardPark = (run: Run, alert: string, detail: string): RunResult =>
  result(run, 'park', entryStage(run.formula).name, { alert, detail });

/** run_id ↔ item is 1:1 — rows for this run id belonging to another
 *  item mean a corrupt/mixed journal namespace; refuse to resume or
 *  replay any of it. */
function foreignItemGuard(run: Run): RunResult | undefined {
  const foreign = run.journal.rows().some(r => r.run_id === run.runId && r.item !== run.item);
  return foreign
    ? guardPark(
        run,
        PARK_ALERTS.itemMismatch,
        `journal rows for run ${run.runId} belong to another item`
      )
    : undefined;
}

/** A resume carrying a DIFFERENT signer than the run's journaled
 *  customer is an imposter — one carrying none just inherits. */
const customerMismatch = (journaled: string | undefined, run: Run): boolean => {
  if (journaled === undefined || run.customer === undefined) {
    return false;
  }
  return journaled !== run.customer;
};

/** The recorded customer is run state — journaled on every row — so a
 *  resume cannot quietly swap who may sign the accept gate. A resume
 *  carrying a DIFFERENT customer fails closed like a foreign item;
 *  one carrying none inherits the journaled identity — the customer
 *  is durable. */
function bindCustomer(run: Run, records: JournalRow[]): RunResult | undefined {
  const journaled = records.find(r => typeof r.customer === 'string')?.customer;
  if (customerMismatch(journaled, run)) {
    return guardPark(
      run,
      PARK_ALERTS.customerMismatch,
      `run ${run.runId} recorded customer ${JSON.stringify(journaled)} — ` +
        `resume carried ${JSON.stringify(run.customer)}`
    );
  }
  run.customer = journaled ?? run.customer;
  return undefined;
}

/** The shared entry: reconstruct journal state, then drive — fresh at
 *  the entry stage, or from wherever the journal last settled. */
async function begin(run: Run): Promise<RunResult> {
  const guard = foreignItemGuard(run);
  if (guard !== undefined) {
    return guard;
  }
  const records = recordsOf(run);
  const customerPark = bindCustomer(run, records);
  if (customerPark !== undefined) {
    return customerPark;
  }
  run.seq = records.reduce((m, r) => Math.max(m, r.seq), 0);
  replayCtx(run, records);
  const last = records.at(-1);
  if (last === undefined) {
    return drive(run, { stage: entryStage(run.formula).name, attempt: 1 });
  }
  const step = await resumeStep(run, last, pendingRecord(records));
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
