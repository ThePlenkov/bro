/**
 * The `capture` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-7d5nb.6) — G4 self-learn on land. Terminal-ish: the last stage
 * in classify → route → work → review → merge → capture, it distills
 * the item's finished artifacts (drill/retro/act/mol records) into
 * trigger-gated lessons and emits the run's only verdict:
 *
 *   captured — the learn sweep ran on the landed run → end
 *
 * The stage is CHEAP and per-item by construction: the learn seam's
 * dedup makes a re-sweep merge-only (already-captured artifacts union
 * evidence, never write twice), so running it on every land costs one
 * sweep. The heavyweight session retro is NOT per-item — the spec
 * runs it batched off-path, so the stage never executes it: it hands
 * the item's retro intent to the `retro` queue seam and the batch
 * runner picks it up whenever the batch fires. The payload records
 * the queuing (`retro: {queued, batch?}`) — journaled with the
 * verdict, durable proof the hook fired.
 *
 * Land context comes from the JOURNAL, not ctx — the same authority
 * split as route's wall evidence and review's fix history. The stage
 * scans this run's settled records: a settled `landed` verdict (the
 * merge stage's spec enum — a formula may name the stage differently,
 * the verdict word is fixed) MUST exist, because capture runs on
 * land; a capture reached without one is a malformed invocation and
 * fails loud, never captures un-landed work into lessons. `mol` is
 * the last settled payload's string `mol` field — the work stage
 * journals it when the run poured a molecule (convoy's
 * `{mol: <id>}` convention) — and scopes the harvest's mol source.
 *
 * Injected seams keep the stage provider- and store-agnostic:
 * `capture` is the learn-capture path (prod binds `captureLessons`),
 * `retro` is the batched-retro intent queue (prod wires whatever
 * batch mechanism carries the retro — a marker is the whole contract,
 * the run never waits on it). Both take the StageCall plus the
 * journal-derived land context.
 */
import type { MaybePromise } from '@broject/core';
import { type JournalRow, journalRecords } from '../journal.ts';
import type { EngineHandler, EngineResult, StageCall } from '../runner.ts';

/** The stage's declared mode tokens — `mode = "always-capture"` in the
 *  spec formula: the per-item cheap sweep every land gets. An absent
 *  mode reads as the default; an UNRECOGNIZED mode is a config error —
 *  a stage that can't tell its capture scope can't know what it runs. */
export const CAPTURE_MODES = ['always-capture'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'always-capture';

/** The stage's one verdict — `capture.captured → end`. */
export const CAPTURED_VERDICT = 'captured';

/** The merge stage's settle verdict — the enum word the journal scan
 *  keys on (spec §transitions: `merge.landed → capture`). */
export const LANDED_VERDICT = 'landed';

/** The land context the stage derives from the journal — what both
 *  seams learn about the run whose item just landed. */
export interface LandContext {
  /** the pipeline item — the bead the run belongs to */
  item: string;
  /** the run this capture belongs to — evidence provenance */
  runId: string;
  /** molecule the run produced — the last settled payload's `mol`
   *  field; scopes the harvest's mol source when present */
  mol?: string;
  /** the land record — which stage settled `landed` and when; its
   *  payload rides along (a `pr:` ref is lesson evidence material) */
  landed: { stage: string; ts: string; payload?: unknown };
}

/** What the learn sweep reports back — the spec's
 *  `{lessons: int, followups: [beadId]}` plus the per-artifact skips
 *  the harvest logged. */
export interface CaptureOutcome {
  /** lessons written or merged this sweep — re-sweeps count merge-only */
  lessons: number;
  /** follow-up bead ids the capture surfaced — the "plan next tasks"
   *  half of the stage's formula comment */
  followups?: string[];
  /** artifacts the harvest rejected, each with its reason — surfaced,
   *  never silently dropped */
  skipped?: { origin: string; reason: string }[];
}

/** The retro batch's receipt — an opaque batch id is all the payload
 *  records; the heavyweight session retro itself runs off-path. */
export interface RetroReceipt {
  batch?: string;
}

export interface CaptureDeps {
  /** the learn-capture seam — runs the per-item sweep over the run's
   *  finished artifacts into trigger-gated lessons. Prod binds
   *  `captureLessons` behind it. */
  capture: (call: StageCall, ctx: LandContext) => MaybePromise<CaptureOutcome>;
  /** the batched-retro intent queue — records that this item's run
   *  joins the next off-path retro batch. It QUEUES, never executes:
   *  a retro that ran inside the stage would be the per-item
   *  heavyweight session the spec forbids. Required — an unwired hook
   *  is a wiring error, not a skipped retro. */
  retro: (call: StageCall, ctx: LandContext) => MaybePromise<RetroReceipt | undefined>;
}

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under `capture` (spec §typed stage outputs). `lessons` and
 *  `followups` are the spec's pair; the rest is provenance. */
export interface CapturePayload {
  lessons: number;
  followups: string[];
  /** harvest rejects — the sweep's own skip report */
  skipped?: { origin: string; reason: string }[];
  /** the harvested molecule, when the run journaled one */
  mol?: string;
  /** the land record this capture runs on */
  landed: { stage: string; ts: string };
  /** the batched-retro hook's durable mark — queued, never executed */
  retro: { queued: true; batch?: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A row that produced real stage output — same read the runner's
 *  replay makes: alert rows carry no verdict, admit rows carry refusal
 *  detail, a pending intent produced nothing. */
const settledRow = (r: JournalRow): boolean =>
  r.alert === undefined && r.verdict !== undefined && r.admit !== true;

/** This run's settled records, seq order — the journal's own filter
 *  (run_id + item) so foreign runs' lands never leak into the context. */
function settledOf(call: StageCall): JournalRow[] {
  return journalRecords(
    call.journal.rows().filter(r => r.run_id === call.runId && r.item === call.item)
  ).filter(settledRow);
}

/** The land record — the LAST settled `landed` verdict, whatever stage
 *  emitted it (a formula may name its merge stage differently; the
 *  verdict word is the spec enum). Undefined when the run reaching
 *  capture never landed — the malformed-invocation case. */
function landRecord(records: JournalRow[]): JournalRow | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].verdict === LANDED_VERDICT) {
      return records[i];
    }
  }
  return undefined;
}

/** A payload's `mol` field — only a non-empty string counts; a
 *  non-string `mol` is malformed payload data, never harvested. */
const molField = (p: unknown): string | undefined => {
  if (!isRecord(p)) {
    return undefined;
  }
  const m = p.mol;
  if (typeof m !== 'string') {
    return undefined;
  }
  return m === '' ? undefined : m;
};

/** The run's molecule — the LAST settled payload carrying a usable
 *  `mol`. Re-entries (a scoped-fix work round can re-pour) may update
 *  it; the freshest wins. */
function molOf(records: JournalRow[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const m = molField(records[i].payload);
    if (m !== undefined) {
      return m;
    }
  }
  return undefined;
}

/** The journal-derived land context — throws when no settled `landed`
 *  record exists for this run: capture runs on land, and a capture
 *  reached without one is a malformed invocation (the pending intent
 *  is the crash marker; the bounded re-fire waits for the world to
 *  make sense or the attempt budget to park the item). */
function landContext(call: StageCall): LandContext {
  const records = settledOf(call);
  const landed = landRecord(records);
  if (landed === undefined) {
    throw new Error(
      `capture: run ${call.runId} has no settled "${LANDED_VERDICT}" record — ` +
        'capture runs on land'
    );
  }
  const ctx: LandContext = {
    item: call.item,
    runId: call.runId,
    landed: { stage: landed.stage, ts: landed.ts, payload: landed.payload },
  };
  const mol = molOf(records);
  if (mol !== undefined) {
    ctx.mol = mol;
  }
  return ctx;
}

/** `always-capture` is the only scope the stage knows — an unknown
 *  mode token can't name what the sweep runs, so it fails loud like
 *  every other malformed formula input. */
function checkMode(call: StageCall): void {
  const mode = call.stage.mode;
  if (mode !== undefined && !(CAPTURE_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `capture: unknown mode ${JSON.stringify(mode)} — expected ${CAPTURE_MODES.join('|')}`
    );
  }
}

/** A counted value — a non-negative integer, nothing else. */
const isCount = (v: unknown): boolean => {
  if (typeof v !== 'number') {
    return false;
  }
  if (!Number.isInteger(v)) {
    return false;
  }
  return v >= 0;
};

/** A bead-id list — non-empty strings only. */
const isBeadId = (v: unknown): v is string => {
  if (typeof v !== 'string') {
    return false;
  }
  return v !== '';
};

const isBeadList = (v: unknown): v is string[] => {
  if (!Array.isArray(v)) {
    return false;
  }
  return v.every(isBeadId);
};

/** One skip-report row — an {origin, reason} record. */
const isSkipRow = (v: unknown): v is { origin: string; reason: string } => {
  if (!isRecord(v)) {
    return false;
  }
  if (typeof v.origin !== 'string') {
    return false;
  }
  return typeof v.reason === 'string';
};

const isSkipList = (v: unknown): v is { origin: string; reason: string }[] => {
  if (!Array.isArray(v)) {
    return false;
  }
  return v.every(isSkipRow);
};

/** An optional list field — absent is fine, present must validate. */
function checkList<T>(v: T[] | undefined, ok: (v: unknown) => v is T[], what: string): void {
  if (v === undefined) {
    return;
  }
  if (!ok(v)) {
    throw new Error(`capture: the learn seam returned malformed ${what}`);
  }
}

/** The seam's outcome, validated before it becomes the payload —
 *  `lessons` must be a countable int, `followups` a bead-id list,
 *  `skipped` origin+reason records. A malformed outcome is never
 *  echoed into the pipeline context: the learn sweep DID run (its
 *  dedup makes re-fire merge-only), but an unreadable report can't be
 *  trusted as the stage's typed output. */
function checkOutcome(out: CaptureOutcome): void {
  if (!isRecord(out)) {
    throw new Error('capture: the learn seam returned a malformed outcome — expected a record');
  }
  if (!isCount(out.lessons)) {
    throw new Error(
      'capture: the learn seam returned a malformed outcome — ' +
        'lessons must be a non-negative integer'
    );
  }
  checkList(out.followups, isBeadList, 'followups — expected an array of bead ids');
  checkList(out.skipped, isSkipList, 'skipped — expected {origin, reason} records');
}

/** The retro queue's receipt — an opaque batch id or nothing. A seam
 *  returning runtime shapes its type forbids (null, a bare string) is
 *  malformed data, same rule as every other seam output. */
function checkReceipt(r: RetroReceipt | undefined): RetroReceipt {
  if (r === undefined) {
    return {};
  }
  if (!isRecord(r)) {
    throw new Error('capture: the retro seam returned a malformed receipt — expected {batch?}');
  }
  const batch = r.batch;
  if (batch === undefined) {
    return {};
  }
  if (typeof batch !== 'string') {
    throw new Error('capture: the retro seam returned a malformed receipt — expected {batch?}');
  }
  return { batch };
}

/**
 * The capture stage as an EngineHandler for the runner's `learn` slot —
 * derive land context from the journal, run the per-item learn sweep,
 * queue the batched-retro intent, emit `captured` with the typed
 * payload. A missing land record, an unknown mode, a malformed seam
 * outcome, and a seam throw all propagate: the pending intent is the
 * crash marker, and both seams' side effects are idempotent under
 * re-fire — the learn dedup folds a re-sweep into a merge, and a batch
 * queue dedups on the item/run key it must already take. No `recheck`
 * hook: `learn` is not a spawn-like intent, so a verdict-less record
 * re-fires inside the attempt budget like the judge stages'.
 */
export function captureStage(deps: CaptureDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineResult> {
      checkMode(call);
      const ctx = landContext(call);
      const out = await deps.capture(call, ctx);
      checkOutcome(out);
      // the batched retro hook — AFTER the sweep: the intent it queues
      // describes a completed capture. Queued, never executed inline.
      const receipt = checkReceipt(await deps.retro(call, ctx));
      const p: CapturePayload = {
        lessons: out.lessons,
        followups: out.followups ?? [],
        landed: { stage: ctx.landed.stage, ts: ctx.landed.ts },
        retro: { queued: true, ...(receipt.batch !== undefined ? { batch: receipt.batch } : {}) },
      };
      if (out.skipped !== undefined && out.skipped.length > 0) {
        p.skipped = out.skipped;
      }
      if (ctx.mol !== undefined) {
        p.mol = ctx.mol;
      }
      return { verdict: CAPTURED_VERDICT, payload: p };
    },
  };
}
