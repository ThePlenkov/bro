/**
 * The pipeline run waker — the RESUME half of the global watcher
 * (specs/bro-v0pvd.3.md, epic bro-v0pvd). Script-first, no agent:
 * scan the pipeline journal plane for runs parked on a live resume
 * anchor and call `resumePipeline` when the awaited input MAY have
 * settled — a customer record, a lifted provider wall, a freed
 * capacity slot, a settled PR (probe seam), or plain crash-mid-drive
 * residue.
 *
 *   scan *.journal.jsonl → per (run,item) tail → resolve run spec →
 *   classify anchor → wake-condition probe → sig gate → resumePipeline
 *
 * The journal IS the state: anchors, occupancy, and customer-channel
 * freshness are all read off the plane, and `resumePipeline`'s own
 * write-ahead contract (pendingRecord + recheck, never a blind
 * re-fire) arbitrates every wake. The only extra state is
 * `<runId>.wake.json` — a dedup HINT recording the input signature
 * each decision was made against, so an unchanged world never
 * re-wakes a run (a pending emit with no verdict would otherwise
 * re-emit to the customer every tick). Losing it costs one
 * redundant wake the runner absorbs; it is never resume truth.
 *
 * Formula + engines are caller-supplied through `resolve` — run
 * creation (bro-qjji2.10) owns the prod engine map and the
 * `<runId>.formula.toml` sidecar convention the CLI resolver reads.
 * This module never admits new work: queue→runPipeline is .10's.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  holdFileLock,
  LockTimeout,
  type MaybePromise,
  type ProviderWall,
  readAgentRegistry,
} from '@broject/core';
import {
  customerChannelPath,
  latestVerdict,
  pendingAnswers,
  readCustomerFile,
} from './customer.ts';
import { type PipelineFormula, type PipelineStage, transitionFor } from './formula.ts';
import {
  fileJournal,
  type JournalRow,
  journalRecords,
  type PipelineJournal,
  pipelineDir,
  RUN_ID_RE,
} from './journal.ts';
import {
  flowTail,
  type RunOptions,
  resumePipeline,
  SATURATION_ALERT,
  STAGE_INTENTS,
} from './runner.ts';

// --- discovered runs -------------------------------------------------------

/** One (run,item) flow discovered on the journal plane — the tail
 *  record classifies its resume anchor; `records` is the seq-collapsed
 *  history the occupancy count and freshness checks read. */
export interface PipelineRunView {
  runId: string;
  item: string;
  /** absolute path of the run's `.journal.jsonl` — a resume opens a
   *  FRESH fileJournal on it (the read-once mirror contract) */
  journalPath: string;
  /** the journal instance the scan read — never handed to resume */
  journal: PipelineJournal;
  /** the tail row's formula_sha — the drift baseline */
  formulaSha: string;
  /** the run's recorded customer identity (first journaled stamp) */
  customer?: string;
  /** the last seq-collapsed record — decides the anchor */
  tail: JournalRow;
  /** this item's seq-collapsed records */
  records: JournalRow[];
}

/** Why a discovered run can resume — classified from the tail +
 *  formula. `resume` is crash-mid-drive (settled verdict whose
 *  transition is a stage/`retry`/unknown — the drive never
 *  finished); `parked` is a settled verdict whose transition is
 *  `park` (the stage re-asks on wake); `pending` a verdict-less
 *  intent; `alert` a fail-closed park row. */
export type ResumeAnchor =
  | { kind: 'resume'; stage: string }
  | { kind: 'pending'; intent: string; stage: string }
  | { kind: 'alert'; alert: string; stage: string; resume?: string }
  | { kind: 'parked'; stage: string; verdict: string };

/** What `resolve` returns for a woken run — the formula plus the
 *  RunOptions resume needs. `journal`/`runId` are stripped (the
 *  waker owns both); `customer` passes through only as the
 *  journal-silent fallback (`bindCustomer` inherits the journaled
 *  identity first — a conflicting value fails closed inside the
 *  runner, which is correct). */
export interface ResolvedRun {
  formula: PipelineFormula;
  opts: Omit<RunOptions, 'journal' | 'runId'>;
}

/** The world-state probes a wake decision may consult — injected so
 *  the package stays provider-agnostic; the CLI binds the real
 *  planes. Absent probe = that signal can't be evaluated (the
 *  anchor waits, never guesses). */
export interface WakeProbes {
  /** act-gate PR settle — true when the run's recorded PR may have
   *  settled. .2's engine + the act package own the semantics; this
   *  is the seam they land on. MUST be cheap — called per candidate
   *  per pass (bind a state cache like drive's). */
  prSettled?: (view: PipelineRunView) => MaybePromise<boolean>;
  /** provider walls — prod binds `deriveProviderWalls` over the
   *  agents registry. Read once per pass, shared across runs. */
  walls?: () => MaybePromise<readonly ProviderWall[]>;
  /** fleet load for route's `saturated` queue — the RouteLoad shape
   *  ({live, cap?}); undefined = can't evaluate. */
  fleetLoad?: () => MaybePromise<{ live: number; cap?: number } | undefined>;
}

export interface WakeDeps {
  /** repo dir — resolves the pipeline plane via git common dir */
  dir: string;
  /** run spec resolution — undefined = this pass can't serve the run
   *  (unresolvable formula/engines); retried next pass, never deduped */
  resolve: (view: PipelineRunView) => MaybePromise<ResolvedRun | undefined>;
  probes?: WakeProbes;
  /** resume seam — defaults to resumePipeline; tests inject spies */
  resume?: typeof resumePipeline;
  /** pending-emit re-emit cadence — a verdict-less accept intent
   *  older than this wakes anyway (the emit may have died in the
   *  crash window; accept's recheck re-emits idempotently). Default
   *  30 min; the age is bucketed into the sig so it fires once per
   *  interval, never per tick. */
  reemitMs?: number;
  /** wall clock — tests inject */
  now?: () => number;
  /** spawn-pending signal — a fingerprint of the world a fleet
   *  spawn's recheck reads (default: hash of the agents registry).
   *  The sig gate turns "any change" into "wake once per change". */
  spawnSignal?: () => MaybePromise<unknown>;
}

export type WakeAction = 'woken' | 'waiting' | 'unresolved' | 'skipped' | 'failed';

export interface WakeRunReport {
  runId: string;
  item: string;
  stage: string;
  action: WakeAction;
  detail?: string;
}

export interface WakeReport {
  /** the pipeline dir scanned — null outside a repo */
  dir: string | null;
  /** another waker holds wake.lock — this pass did nothing */
  locked: boolean;
  /** (run,item) views discovered */
  scanned: number;
  runs: WakeRunReport[];
  /** journal files the scan could not read — skipped, never fatal
   *  (the runner's own sibling read stays the fail-closed
   *  enforcement on resume) */
  unreadable?: string[];
}

// --- the scan ----------------------------------------------------------------

/** `*.journal.jsonl` file names in the pipeline dir — [] when the
 *  dir doesn't exist (no pipeline plane = nothing ever ran). Every
 *  other listing failure throws like the runner's siblingJournalRows:
 *  a scan that can't see the plane must fail loud, not report zero
 *  runs and leave parked anchors unwoken. */
function journalFileNames(d: string): string[] {
  try {
    return readdirSync(d).filter(f => f.endsWith('.journal.jsonl'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}

/** Every (run,item) flow on the plane. Rows group by item within the
 *  file's own run_id (run_id↔item is 1:1 by contract; a mixed file
 *  still yields honest per-item views — the runner's
 *  foreignItemGuard is what parks the corrupt case). One unreadable
 *  journal file is reported through `onUnreadable` and skipped — it
 *  must not starve the pass; the runner's own siblingJournalRows
 *  re-reads the same file on resume and stays the fail-closed
 *  enforcement. */
export function scanPipelineRuns(
  dir: string,
  onUnreadable?: (file: string, err: unknown) => void
): PipelineRunView[] {
  const d = pipelineDir({ dir });
  if (d === null) {
    return [];
  }
  const out: PipelineRunView[] = [];
  for (const f of journalFileNames(d)) {
    const journalPath = join(d, f);
    let journal: PipelineJournal;
    try {
      journal = fileJournal(journalPath);
    } catch (e) {
      onUnreadable?.(f, e);
      continue;
    }
    if (journal.runId === undefined) {
      continue;
    }
    const byItem = new Map<string, JournalRow[]>();
    for (const r of journal.rows()) {
      if (r.run_id !== journal.runId) {
        continue;
      }
      const g = byItem.get(r.item);
      if (g === undefined) {
        byItem.set(r.item, [r]);
      } else {
        g.push(r);
      }
    }
    for (const [item, rows] of byItem) {
      const records = journalRecords(rows);
      const tail = records.at(-1);
      if (tail === undefined) {
        continue;
      }
      out.push({
        runId: journal.runId,
        item,
        journalPath,
        journal,
        formulaSha: tail.formula_sha,
        customer: records.find(r => typeof r.customer === 'string')?.customer,
        tail,
        records,
      });
    }
  }
  return out;
}

// --- anchor classification ----------------------------------------------------

const stageOf = (formula: PipelineFormula, name: string): PipelineStage | undefined =>
  formula.stages.find(s => s.name === name);

/** Tail → anchor, or undefined for a finished run. A settled tail's
 *  transition decides: `park` re-asks the stage on wake, a stage
 *  name/`retry`/unknown target is crash-mid-drive residue (always
 *  wake-eligible — the runner's own bounds apply), and the three
 *  done-outcomes are never candidates. */
function classifyAnchor(view: PipelineRunView, formula: PipelineFormula): ResumeAnchor | undefined {
  const last = view.tail;
  if (last.alert !== undefined) {
    return { kind: 'alert', alert: last.alert, stage: last.stage, resume: last.resume };
  }
  if (last.verdict === undefined) {
    return { kind: 'pending', intent: last.intent, stage: last.stage };
  }
  const target = transitionFor(formula, last.stage, last.verdict);
  if (target === 'park') {
    return { kind: 'parked', stage: last.stage, verdict: last.verdict };
  }
  if (target === 'end' || target === 'close' || target === 'abandon') {
    return undefined;
  }
  return { kind: 'resume', stage: last.stage };
}

// --- customer channel reads ----------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The run's customer channel rows scoped to THIS item — a channel
 *  is per-run but records carry `item`; a sibling item's verdict
 *  must not wake this item's accept wait (the gate would park it
 *  item-mismatched). Item-less rows stay in — the gate validates
 *  them either way, and over-inclusion only costs a wake the runner
 *  absorbs. [] when absent/unreadable-dir; a PRESENT but unreadable
 *  file throws like the stage seams do. */
function channelRows(dir: string, runId: string, item: string): unknown[] {
  const file = customerChannelPath({ dir, runId });
  if (file === null) {
    return [];
  }
  return readCustomerFile(file).filter(
    r => !isRecord(r) || typeof r.item !== 'string' || r.item === item
  );
}

/** sha over the channel rows — the sig's change detector. Parsed-JSON
 *  stringify keeps key order, so identical content hashes identical. */
const rowsHash = (rows: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(rows)).digest('hex');

/** A record's `ts` as epoch ms — unparseable/missing reads as
 *  +Infinity: a record that can't prove it predates the alert is
 *  treated as new input (the gate validates it either way). */
const recordTsMs = (r: unknown): number => {
  const ts = isRecord(r) && typeof r.ts === 'string' ? Date.parse(r.ts) : Number.NaN;
  return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
};

/** Any channel row newer than `sinceMs` — the customer-repair signal
 *  for fail-closed alerts (a corrected verdict/answer lands after
 *  the alert that rejected its predecessor). */
const channelFreshSince = (rows: unknown[], sinceMs: number): boolean =>
  rows.some(r => recordTsMs(r) > sinceMs);

/** An intake answer candidate — intake's own admission rule
 *  (`kind:"answer"`, or a kind-less row still carrying `answers`). */
const isAnswerCandidate = (r: unknown): boolean =>
  isRecord(r) && (r.kind === 'answer' || (r.kind === undefined && 'answers' in r));

/** Pending (unconsumed) answer candidates — the intake-questions
 *  wake signal. `pendingAnswers` applies the consumed-marker bound;
 *  verdict/consumed rows aren't intake input and don't count. */
const hasPendingAnswers = (rows: unknown[]): boolean =>
  pendingAnswers(rows).some(isAnswerCandidate);

// --- wake conditions ------------------------------------------------------------

/** Alerts a corrected customer record can repair — the stage must be
 *  a customer gate (accept/intake engine) AND the tag one of the
 *  channel-fed parks. Everything else is operator/config domain. */
const CUSTOMER_ALERTS = new Set([
  'verdict-malformed',
  'verdict-forged',
  'customer-mismatch',
  'fix-notes-missing',
  'answer-malformed',
]);

const QUEUE_WALL_REASONS = new Set(['onwall', 'chain-spent']);

interface Decision {
  /** resume this run now */
  wake: boolean;
  /** the world-state this decision consumed — hashed into the sig */
  inputs: Record<string, unknown>;
  /** false = the decision couldn't be fully evaluated (probe absent,
   *  non-wakeable anchor) — the sig is NOT stored, so binding the
   *  probe later takes effect without a state reset */
  evaluated: boolean;
  why?: string;
}

const skip = (why: string): Decision => ({ wake: false, inputs: {}, evaluated: false, why });
const wait = (why: string, inputs: Record<string, unknown> = {}): Decision => ({
  wake: false,
  inputs,
  evaluated: true,
  why,
});
const fire = (inputs: Record<string, unknown>): Decision => ({
  wake: true,
  inputs,
  evaluated: true,
});

/** Per-pass shared probe values — walls/registry/occupancy are read
 *  once and reused across every candidate (a pass over N parked runs
 *  costs one registry read, not N). */
interface Shared {
  walls?: readonly ProviderWall[];
  wallsRead: boolean;
  spawnFp?: string;
  /** occupancy per formula_sha — flowTail interprets settled tails
   *  through THAT formula's transitions, so runs on different
   *  formulas never share a count */
  occupancy: Map<string, { movers: number; holders: Map<string, number> }>;
}

const sharedFor = (): Shared => ({ wallsRead: false, occupancy: new Map() });

async function sharedWalls(
  deps: WakeDeps,
  shared: Shared
): Promise<readonly ProviderWall[] | undefined> {
  if (!shared.wallsRead) {
    shared.walls = deps.probes?.walls === undefined ? undefined : await deps.probes.walls();
    shared.wallsRead = true;
  }
  return shared.walls;
}

async function sharedSpawnFp(deps: WakeDeps, shared: Shared): Promise<string> {
  if (shared.spawnFp === undefined) {
    const raw =
      deps.spawnSignal !== undefined ? await deps.spawnSignal() : readAgentRegistry(deps.dir);
    // ?? 'null' — JSON.stringify(undefined) is undefined, and
    // Hash.update(undefined) throws: a probe answering "can't
    // evaluate" must fingerprint, never crash the pass
    shared.spawnFp = createHash('sha256')
      .update(JSON.stringify(raw) ?? 'null')
      .digest('hex');
  }
  return shared.spawnFp;
}

/** Journaled occupancy under the CANDIDATE's formula — the same
 *  flowTail rule the runner enforces, counted across every scanned
 *  view. The candidate's own alert tail counts nothing (it holds no
 *  seat), matching what resume will compute. */
function occupancyOf(
  formula: PipelineFormula,
  views: PipelineRunView[]
): { movers: number; holders: Map<string, number> } {
  const holders = new Map<string, number>();
  let movers = 0;
  for (const v of views) {
    const t = flowTail(formula, v.records);
    if (t.moving) {
      movers += 1;
    }
    if (t.stage !== undefined) {
      holders.set(t.stage, (holders.get(t.stage) ?? 0) + 1);
    }
  }
  return { movers, holders };
}

/** Effective caps — the runner's own arithmetic: machine budget
 *  narrows the formula cap, stage concurrency narrows further. */
function capsFor(
  formula: PipelineFormula,
  opts: Omit<RunOptions, 'journal' | 'runId'>,
  stage: PipelineStage | undefined
): { inFlight: number; stageCap: number } {
  const machine = opts.maxInFlight ?? 0;
  const inFlight =
    machine > 0 ? Math.min(formula.limits.in_flight, machine) : formula.limits.in_flight;
  const stageCap = Math.min(stage?.concurrency ?? inFlight, inFlight);
  return { inFlight, stageCap };
}

/** The pending-intent decision — per intent word. `emit` waits on
 *  the customer channel (verdict candidate OR the re-emit cadence);
 *  `gate` on the PR probe; `spawn` on registry churn (the sig gate
 *  turns "any change" into one wake per change — the inputs carry
 *  the fingerprint, the decision itself always fires); everything
 *  else is crash residue and always wake-eligible. `attempt` rides
 *  the inputs so a bounded refire chain re-wakes per attempt while
 *  a stable pending tail stays deduped. */
async function decidePending(
  deps: WakeDeps,
  view: PipelineRunView,
  anchor: Extract<ResumeAnchor, { kind: 'pending' }>,
  shared: Shared,
  rows: unknown[]
): Promise<Decision> {
  const tag = `pending:${anchor.intent}@${anchor.stage}`;
  const at = { a: tag, at: view.tail.attempt };
  if (anchor.intent === STAGE_INTENTS.accept) {
    const verdict = latestVerdict(rows) !== undefined;
    const ageMs = (deps.now?.() ?? Date.now()) - Date.parse(view.tail.ts);
    const reemit = deps.reemitMs ?? 30 * 60_000;
    const bucket = Number.isFinite(ageMs) ? Math.floor(Math.max(0, ageMs) / reemit) : 1;
    const inputs = { ...at, ch: rowsHash(rows), rb: bucket };
    return verdict || bucket > 0 ? fire(inputs) : wait('no customer verdict yet', inputs);
  }
  if (anchor.intent === STAGE_INTENTS['act-gate']) {
    if (deps.probes?.prSettled === undefined) {
      return skip('no PR settle probe bound');
    }
    const settled = await deps.probes.prSettled(view);
    if (!settled) {
      return wait('PR still settling', { ...at, pr: false });
    }
    // a positive probe whose recheck re-parks 'pending' writes NO
    // journal row — a constant {pr:true} sig would dedupe the anchor
    // forever. The age bucket re-asks once per reemitMs while the
    // tail stands still (accept's cadence contract).
    const ageMs = (deps.now?.() ?? Date.now()) - Date.parse(view.tail.ts);
    const reemit = deps.reemitMs ?? 30 * 60_000;
    const bucket = Number.isFinite(ageMs) ? Math.floor(Math.max(0, ageMs) / reemit) : 1;
    return fire({ ...at, pr: true, rb: bucket });
  }
  if (anchor.intent === STAGE_INTENTS.fleet) {
    const fp = await sharedSpawnFp(deps, shared);
    return fire({ ...at, reg: fp });
  }
  // crash residue — always wake-eligible. The sig still needs a
  // changing input: a recheck that re-parks 'pending' writes NO row,
  // so an identical tail would dedup the anchor forever even after
  // the side effect settles. The age bucket re-asks once per
  // reemitMs while the tail stands still (accept's cadence contract).
  const ageMs = (deps.now?.() ?? Date.now()) - Date.parse(view.tail.ts);
  const reemit = deps.reemitMs ?? 30 * 60_000;
  const bucket = Number.isFinite(ageMs) ? Math.floor(Math.max(0, ageMs) / reemit) : 1;
  return fire({ ...at, rb: bucket });
}

/** The alert decision — customer-repairable parks wake on channel
 *  freshness; stage-saturated on journaled occupancy; everything
 *  else is operator domain and never auto-wakes. */
async function decideAlert(
  view: PipelineRunView,
  anchor: Extract<ResumeAnchor, { kind: 'alert' }>,
  resolved: ResolvedRun,
  shared: Shared,
  views: PipelineRunView[],
  rows: unknown[]
): Promise<Decision> {
  const tag = `alert:${anchor.alert}@${anchor.stage}`;
  const engine = stageOf(resolved.formula, anchor.stage)?.engine;
  if (CUSTOMER_ALERTS.has(anchor.alert) && (engine === 'accept' || engine === 'intake')) {
    const sinceMs = Date.parse(view.tail.ts);
    const inputs = { a: tag, ch: rowsHash(rows) };
    return channelFreshSince(rows, sinceMs)
      ? fire(inputs)
      : wait('no newer customer record', inputs);
  }
  if (anchor.alert === SATURATION_ALERT) {
    const resumeStage = anchor.resume ?? anchor.stage;
    const stage = stageOf(resolved.formula, resumeStage);
    if (stage === undefined) {
      return skip(`resume stage "${resumeStage}" not in formula`);
    }
    let occ = shared.occupancy.get(resolved.opts.formulaSha ?? '');
    if (occ === undefined) {
      occ = occupancyOf(resolved.formula, views);
      shared.occupancy.set(resolved.opts.formulaSha ?? '', occ);
    }
    const { inFlight, stageCap } = capsFor(resolved.formula, resolved.opts, stage);
    const movers = occ.movers;
    const holders = occ.holders.get(resumeStage) ?? 0;
    // `sq` binds the sig to THIS tail — a refused resume appends a new
    // stage-saturated alert row, and without a tail identity the stale
    // mark could match a later identical-capacity world and skip a run
    // whose anchor already moved on.
    const inputs = {
      a: tag,
      occ: { m: movers, h: holders, i: inFlight, c: stageCap },
      sq: view.tail.seq,
    };
    return movers < inFlight && holders < stageCap
      ? fire(inputs)
      : wait(
          `capacity full — ${movers}/${inFlight} moving, ${holders}/${stageCap} at ${resumeStage}`,
          inputs
        );
  }
  return skip(`alert "${anchor.alert}" is operator domain`);
}

/** The parked (settled→`park`) decision — intake waits on pending
 *  answers; route's queue waits on its reason's signal (walls,
 *  fleet load); every other park verdict is an operator decision. */
async function decideParked(
  deps: WakeDeps,
  view: PipelineRunView,
  anchor: Extract<ResumeAnchor, { kind: 'parked' }>,
  resolved: ResolvedRun,
  shared: Shared,
  rows: unknown[]
): Promise<Decision> {
  const stage = stageOf(resolved.formula, anchor.stage);
  const tag = `parked:${anchor.verdict}@${anchor.stage}`;
  if (stage?.engine === 'intake') {
    const inputs = { a: tag, ch: rowsHash(rows) };
    return hasPendingAnswers(rows) ? fire(inputs) : wait('no pending answers', inputs);
  }
  const payload = isRecord(view.tail.payload) ? view.tail.payload : undefined;
  const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
  if (anchor.verdict === 'queue' && reason !== undefined) {
    if (QUEUE_WALL_REASONS.has(reason)) {
      const walls = await sharedWalls(deps, shared);
      if (walls === undefined) {
        return skip('no walls probe bound');
      }
      const wall = isRecord(payload?.wall) ? payload.wall : undefined;
      const walled = new Set(walls.map(w => w.provider));
      const wallSig = walls
        .map(w => `${w.provider}:${w.cause}:${w.until ?? ''}`)
        .sort()
        .join(',');
      // `onwall` parked waiting on ONE wall — wake when that provider
      // is no longer walled (the payload's wall.provider is the one
      // that parked it; the kept provider/model is where it WOULD run).
      // `chain-spent` exhausted the chain — the wake re-walks it, so
      // ANY improvement counts: no walls left, or the recorded
      // would-be slot un-walled. (A wall lifting on a chain member the
      // payload doesn't name stays invisible to v1 — the sig still
      // re-evaluates on every wall-set change.)
      const wallProvider = typeof wall?.provider === 'string' ? wall.provider : undefined;
      const slotProvider = typeof payload?.provider === 'string' ? payload.provider : undefined;
      const inputs = { a: tag, w: wallSig, wp: wallProvider ?? '', sp: slotProvider ?? '' };
      if (reason === 'onwall') {
        const provider = wallProvider ?? slotProvider;
        if (provider === undefined) {
          return wait('queue payload names no provider', inputs);
        }
        return walled.has(provider) ? wait(`${provider} still walled`, inputs) : fire(inputs);
      }
      // chain-spent
      if (walls.length === 0) {
        return fire(inputs);
      }
      if (slotProvider !== undefined && !walled.has(slotProvider)) {
        return fire(inputs);
      }
      if (slotProvider === undefined) {
        // route's chain-spent queue names no slot — "which chain
        // member freed" is invisible here, so any surviving wall set
        // must not hold the run: re-ask route to re-walk the chain.
        // The reduced inputs ({a,w} only — no wp/sp, which drift
        // across re-parks) keep the sig stable per wall-set state, so
        // the mark dedupes a still-spent re-park instead of churning
        // every tick; a wall-set change re-fires immediately.
        return fire({ a: tag, w: wallSig });
      }
      return wait('chain still spent', inputs);
    }
    if (reason === 'saturated') {
      if (deps.probes?.fleetLoad === undefined) {
        return skip('no fleet load probe bound');
      }
      const load = await deps.probes.fleetLoad();
      if (load === undefined) {
        return skip('fleet load unreadable');
      }
      const inputs = { a: tag, fl: { l: load.live, c: load.cap ?? 0 } };
      const cap = load.cap ?? 0;
      if (cap > 0 && load.live >= cap) {
        return wait(`fleet saturated — ${load.live}/${cap}`, inputs);
      }
      return fire(inputs);
    }
    return skip(`queue reason "${reason}" has no wake signal`);
  }
  return skip(`parked verdict "${anchor.verdict}" has no wake signal`);
}

// --- the sig gate -----------------------------------------------------------------

/** `<runId>.wake.json` — per-item dedup marks. tmp+rename like every
 *  want-marker; the wake.lock serializes writers so read-modify-write
 *  can't race. */
interface WakeMark {
  sig: string;
  at: string;
  failed?: true;
}
type WakeMarks = Record<string, WakeMark>;

const WAKE_SIG_VERSION = 1;

/** Canonical stringify — sorted object keys so two equal input bags
 *  hash equal regardless of construction order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(stable).join(',')}]`;
  }
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  // ?? 'null' — JSON.stringify(undefined) returns undefined (not a
  // string); interpolating it would bake the literal text "undefined"
  // into records/arrays inconsistently, and a bare undefined reaching
  // Hash.update would throw. Every JS value serializes deterministically.
  return JSON.stringify(v) ?? 'null';
}

const sigOf = (inputs: Record<string, unknown>): string =>
  createHash('sha256')
    .update(stable({ v: WAKE_SIG_VERSION, ...inputs }))
    .digest('hex');

function wakeMarkPath(d: string, runId: string): string {
  // run ids name files — the same path-safe contract
  // pipelineJournalPath/customerChannelPath enforce. Today the id
  // arrives filename-derived (a dir entry can't carry a separator),
  // but the mark writer must not trust that forever: an unsafe id
  // throws rather than writing outside the pipeline dir.
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`pipeline wake: unsafe run id ${JSON.stringify(runId)}`);
  }
  return join(d, `${runId}.wake.json`);
}

function readWakeMarks(d: string, runId: string): WakeMarks {
  try {
    const v = JSON.parse(readFileSync(wakeMarkPath(d, runId), 'utf8')) as unknown;
    return isRecord(v) ? (v as WakeMarks) : {};
  } catch {
    return {};
  }
}

function writeWakeMark(d: string, runId: string, item: string, mark: WakeMark): void {
  const file = wakeMarkPath(d, runId);
  const marks = readWakeMarks(d, runId);
  marks[item] = mark;
  mkdirSync(d, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marks, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Best-effort mark write — the mark is a dedup HINT (the file
 *  header's contract: losing it costs one redundant wake the runner
 *  absorbs, it is never resume truth), so a write failure degrades to
 *  re-evaluation next pass instead of failing the whole pass. */
function tryWriteWakeMark(d: string, runId: string, item: string, mark: WakeMark): void {
  try {
    writeWakeMark(d, runId, item, mark);
  } catch {
    // hint only — see above
  }
}

// --- the pass -----------------------------------------------------------------------

const report = (
  dir: string | null,
  locked: boolean,
  scanned: number,
  runs: WakeRunReport[]
): WakeReport => ({ dir, locked, scanned, runs });

const base = (view: PipelineRunView) => ({
  runId: view.runId,
  item: view.item,
  stage: view.tail.stage,
});

/** Does this anchor's decision consume the customer channel rows?
 *  Only three do: a pending `accept` intent (verdict presence + the
 *  rows hash), customer-repairable alerts (channel freshness), and
 *  `intake` parks (pending answers). Every other anchor — crash-
 *  mid-drive resume, act-gate/fleet pending, wall/fleet-load parks —
 *  ignores them, so reading the channel for those runs only imports
 *  an unreadable-file failure they never needed. */
function channelNeeded(anchor: ResumeAnchor, formula: PipelineFormula): boolean {
  if (anchor.kind === 'pending') {
    return anchor.intent === STAGE_INTENTS.accept;
  }
  if (anchor.kind === 'alert') {
    return CUSTOMER_ALERTS.has(anchor.alert);
  }
  if (anchor.kind === 'parked') {
    return stageOf(formula, anchor.stage)?.engine === 'intake';
  }
  return false;
}

/** One view end-to-end: resolve → drift gate → classify → decide →
 *  sig gate → resume. Every failure is a report row, never a thrown
 *  pass — one broken run can't stall the rest (driveOnce's per-PR
 *  rule). */
async function wakeOne(
  deps: WakeDeps,
  d: string,
  view: PipelineRunView,
  views: PipelineRunView[],
  shared: Shared,
  resume: typeof resumePipeline
): Promise<WakeRunReport> {
  const b = base(view);
  let resolved: ResolvedRun | undefined;
  try {
    resolved = await deps.resolve(view);
  } catch (e) {
    return { ...b, action: 'failed', detail: `resolve: ${e instanceof Error ? e.message : e}` };
  }
  if (resolved === undefined) {
    return { ...b, action: 'unresolved' };
  }
  // formula drift is an operator decision — the waker never wakes it
  // (a wake would journal a formula-drift alert per pass)
  if (!resolved.opts.formulaSha || resolved.opts.formulaSha !== view.formulaSha) {
    return { ...b, action: 'skipped', detail: 'formula drift — operator resume' };
  }
  const anchor = classifyAnchor(view, resolved.formula);
  if (anchor === undefined) {
    return { ...b, action: 'skipped', detail: 'run is terminal' };
  }
  // channel reads and every probe sit inside the same isolation as
  // resolve — a throwing seam reports THIS run failed and the serial
  // loop carries on to the next anchor (driveOnce's per-PR rule)
  let decision: Decision;
  let sig: string;
  try {
    // the channel read is gated to the anchors that consume it —
    // channelRows throws on an unreadable customer file, and a run
    // whose decision never looks at the channel must not fail on it
    const rows = channelNeeded(anchor, resolved.formula)
      ? channelRows(deps.dir, view.runId, view.item)
      : [];
    decision =
      anchor.kind === 'pending'
        ? await decidePending(deps, view, anchor, shared, rows)
        : anchor.kind === 'alert'
          ? await decideAlert(view, anchor, resolved, shared, views, rows)
          : anchor.kind === 'parked'
            ? await decideParked(deps, view, anchor, resolved, shared, rows)
            : fire({ a: `resume@${anchor.stage}` }); // crash-mid-drive — always eligible
    sig = sigOf(decision.inputs);
  } catch (e) {
    return {
      ...b,
      action: 'failed',
      detail: `decide: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!decision.evaluated) {
    return { ...b, action: 'waiting', detail: decision.why };
  }
  const mark = readWakeMarks(d, view.runId)[view.item];
  if (mark?.sig === sig && mark.failed !== true) {
    return {
      ...b,
      action: 'waiting',
      detail: decision.wake ? 'already woken for this world' : decision.why,
    };
  }
  if (!decision.wake) {
    tryWriteWakeMark(d, view.runId, view.item, { sig, at: new Date().toISOString() });
    return { ...b, action: 'waiting', detail: decision.why };
  }
  try {
    // resolved.opts already excludes journal/runId by type — the
    // waker owns both (fresh fileJournal on the path, runId from the
    // filename); everything else passes through verbatim
    const journal = fileJournal(view.journalPath);
    await resume(resolved.formula, view.item, journal, resolved.opts);
    tryWriteWakeMark(d, view.runId, view.item, { sig, at: new Date().toISOString() });
    return { ...b, action: 'woken' };
  } catch (e) {
    // failed mark bypasses the sig gate next pass — a transient fault
    // retries, a persistent one retries per tick like drive's errors
    tryWriteWakeMark(d, view.runId, view.item, {
      sig,
      at: new Date().toISOString(),
      failed: true,
    });
    return { ...b, action: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Pipeline dirs with a pass in flight IN THIS PROCESS —
 *  holdFileLock is re-entrant per process (its heldLocks map lets a
 *  second same-process acquire succeed), so the file lock alone
 *  cannot stop two concurrent passes racing the sig marks and
 *  double-resuming one journal. This set is the same-process half of
 *  the exclusion the file lock provides cross-process. */
const inflightWakes = new Set<string>();

/** One wake pass over the pipeline plane. `wake.lock` (try-lock +
 *  heartbeat) serializes wakers per repo — a second pass reports
 *  `locked` and does nothing; the runner's recheck contract is the
 *  second layer if one ever slipped through. */
export async function wakePipeline(deps: WakeDeps): Promise<WakeReport> {
  const d = pipelineDir({ dir: deps.dir });
  if (d === null) {
    return report(null, false, 0, []);
  }
  if (inflightWakes.has(d)) {
    return report(d, true, 0, []);
  }
  inflightWakes.add(d);
  try {
    let release: () => void;
    try {
      release = holdFileLock(join(d, 'wake.lock'), {
        waitMs: 0,
        label: 'pipeline wake lock',
      });
    } catch (e) {
      if (e instanceof LockTimeout) {
        return report(d, true, 0, []);
      }
      throw e;
    }
    try {
      const unreadable: string[] = [];
      const views = scanPipelineRuns(deps.dir, f => unreadable.push(f));
      const shared = sharedFor();
      const resume = deps.resume ?? resumePipeline;
      const runs: WakeRunReport[] = [];
      for (const view of views) {
        runs.push(await wakeOne(deps, d, view, views, shared, resume));
      }
      const rep = report(d, false, views.length, runs);
      if (unreadable.length > 0) {
        rep.unreadable = unreadable;
      }
      return rep;
    } finally {
      release();
    }
  } finally {
    inflightWakes.delete(d);
  }
}
