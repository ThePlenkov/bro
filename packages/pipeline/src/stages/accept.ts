/**
 * The `accept` stage engine (specs/bro-7d5nb.md §stages) — the
 * customer-acceptance gate, the only stage in the chain that
 * suspends for a human/agent input it does not produce itself:
 *
 *   emit evidence bundle → suspend (pending intent) → resume when
 *   the customer's verdict lands → accepted|rejected|abandon
 *
 * The bundle `{verify rows, diff summary, draft_pr?}` is assembled
 * from the JOURNAL's settled records — same authority split as
 * capture's land context and review's fix history: the intent row is
 * the crash anchor, so what the customer sees must be what the
 * journal can prove, never a stale ctx. `emit` carries it to the
 * run's recorded customer channel (user → notify/mailbox, agent →
 * the A2A surface — transport is the seam's problem; the gate's
 * semantics are identical either way).
 *
 * Suspension: `invoke` emits then answers 'pending' — the runner
 * parks WITHOUT a verdict row, leaving the emit intent as the
 * resume anchor. A wake's `recheck` consults `verdictStore`: no
 * record → idempotent re-emit + 'pending' (an emit may have died
 * mid-flight inside the crash window — at-least-once delivery on a
 * dedup-keyed channel beats a run that waits on a bundle nobody
 * ever saw); a record → it settles or alerts.
 *
 * The identity gate: `accepted_by` must equal `call.customer` — the
 * identity recorded at run creation, carried on the call, never in
 * ctx where a payload could overwrite it. Anything else fails
 * closed: wrong signer → `customer-mismatch` park, malformed record
 * → `verdict-malformed` park, `rejected` without non-empty `notes` →
 * `fix-notes-missing` park (the customer's fix scope, same contract
 * as review's). A run with NO recorded customer fails before emit —
 * no evidence leaks to a gate nobody can pass. The run NEVER moves
 * on a bad verdict; a corrected record on a later wake can still
 * settle — the alert rows are repairable parks, not tombstones.
 *
 * Two more ledger rules keep the gate honest across re-entry:
 *
 *   - the record's `item` must name THIS run's item — a verdict
 *     written to this run's channel for another item (`--run` pins
 *     blindly, the per-run file is the only scoping) is malformed
 *     input, never a settling one;
 *   - a verdict settles ONE accept entry only. `rejected → work`
 *     re-enters accept after the fix round with the SAME channel
 *     record still latest; re-settling it would burn a fix round
 *     per wake until exhaustion. The journal is the consumption
 *     ledger — the settled accept record's payload echoes the
 *     verdict record it consumed — so a deep-equal latest record
 *     reads as 'pending': the gate waits for a FRESH customer
 *     decision on every entry.
 */
import type { MaybePromise } from '@broject/core';
import { type JournalRow, journalRecords } from '../journal.ts';
import {
  type EngineAlert,
  type EngineHandler,
  type EngineOutcome,
  PARK_ALERTS,
  STAGE_INTENTS,
  type StageCall,
} from '../runner.ts';

/** The `rejected` verdict — the one whose `notes` are the fix scope
 *  (required non-empty, same fail-closed contract as review.fix). */
export const REJECTED_VERDICT = 'rejected';

/** The verify intent word — `STAGE_INTENTS.e2e`, the journal
 *  signature of the stage whose settled rows ARE the AC evidence. */
const VERIFY_INTENT = STAGE_INTENTS.e2e;

/** What the customer signs on — the spec's `{verify rows, diff
 *  summary, draft_pr?}`, each piece provenance-stamped from the
 *  journal. */
export interface EvidenceBundle {
  /** the run this evidence belongs to */
  runId: string;
  /** the pipeline item */
  item: string;
  /** every settled verify-intent record, seq order — the stage name,
   *  verdict, ts, and full payload (the AC rows live inside) */
  verify: { stage: string; verdict: string; ts: string; payload?: unknown }[];
  /** the freshest journaled `diff` field — the review/work stage's
   *  diff provenance summary ({files, base, head, …}) */
  diff?: unknown;
  /** the freshest journaled `draft_pr` field — the review surface a
   *  work stage already opened */
  draft_pr?: unknown;
}

/** The accept payload — spec §typed stage outputs `{accepted_by,
 *  notes?}` plus the signing ts for provenance. `notes` on `rejected`
 *  is the scoped-fix scope the runner's fix-verdict binding reads. */
export interface AcceptPayload {
  accepted_by: string;
  notes?: string;
  ts?: string;
}

export interface AcceptDeps {
  /** the customer channel — receives the evidence bundle. MUST be
   *  idempotent on (runId, stage): `recheck` re-emits while the
   *  verdict is still absent (the first emit may have died inside
   *  the pending intent's crash window), and a non-deduped channel
   *  would spam the customer on every wake. Prod binds notify/
   *  mailbox or the A2A surface keyed by the run. */
  emit: (call: StageCall, bundle: EvidenceBundle) => MaybePromise<void>;
  /** reads the customer's verdict record `{verdict, accepted_by,
   *  notes?, ts?}` — undefined while the customer has not answered.
   *  Prod binds {@link fileVerdictStore}, the run's
   *  `<run>.customer.jsonl` channel the CLI writes. Returned raw:
   *  the stage validates shape + identity and fails closed on a
   *  malformed record. */
  verdictStore: (call: StageCall) => MaybePromise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A row that produced real stage output — the runner's own read:
 *  alerts carry no verdict, admit rows carry refusal detail, a
 *  pending intent produced nothing. */
const settledRow = (r: JournalRow): boolean =>
  r.alert === undefined && r.verdict !== undefined && r.admit !== true;

/** This run's settled records, seq order — the journal's own filter
 *  (run_id + item) so foreign runs' evidence never leaks in. */
function settledOf(call: StageCall): JournalRow[] {
  return journalRecords(
    call.journal.rows().filter(r => r.run_id === call.runId && r.item === call.item)
  ).filter(settledRow);
}

/** The freshest settled payload carrying `key`. Malformed values
 *  throw — reaching past a broken freshest field would hand the
 *  customer stale evidence the run already superseded; broken
 *  journal data fails closed like every other broken-context branch. */
function lastField(
  records: JournalRow[],
  key: 'diff' | 'draft_pr',
  ok: (v: unknown) => boolean,
  what: string
): unknown {
  for (let i = records.length - 1; i >= 0; i--) {
    const p = records[i].payload;
    if (!isRecord(p) || !(key in p)) {
      continue;
    }
    const v = p[key];
    if (!ok(v)) {
      throw new Error(`accept: run journaled a malformed ${key} — expected ${what}`);
    }
    return v;
  }
  return undefined;
}

const isDiffSummary = (v: unknown): boolean => isRecord(v);
const isPrRef = (v: unknown): boolean => (typeof v === 'string' && v !== '') || isRecord(v);

/** The evidence bundle — journal authority, deterministically
 *  re-assembled on every re-emit (the idempotent emit's dedup key is
 *  content-stable). */
export function evidenceBundle(call: StageCall): EvidenceBundle {
  const records = settledOf(call);
  const bundle: EvidenceBundle = {
    runId: call.runId,
    item: call.item,
    verify: records
      .filter(r => r.intent === VERIFY_INTENT)
      .map(r => ({
        stage: r.stage,
        verdict: r.verdict as string,
        ts: r.ts,
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      })),
  };
  const diff = lastField(records, 'diff', isDiffSummary, 'a diff-summary record');
  if (diff !== undefined) {
    bundle.diff = diff;
  }
  const pr = lastField(records, 'draft_pr', isPrRef, 'a pr ref — string or record');
  if (pr !== undefined) {
    bundle.draft_pr = pr;
  }
  return bundle;
}

const malformed = (detail: string): EngineAlert => ({
  alert: PARK_ALERTS.verdictMalformed,
  detail,
});

/** Has THIS record already settled an accept entry? The journal is
 *  the consumption ledger — the settled accept record's payload IS
 *  the verdict record it consumed (the engine echoes
 *  accepted_by/notes/ts verbatim). A latest channel record that
 *  deep-equals the last settled accept's (verdict, payload) has
 *  already moved this gate once and must not move it again — the
 *  customer decides each entry fresh. */
function consumedVerdict(call: StageCall, verdict: string, payload: AcceptPayload): boolean {
  const records = settledOf(call);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.stage !== call.stage.name) {
      continue;
    }
    const p = r.payload;
    return (
      r.verdict === verdict &&
      isRecord(p) &&
      p.accepted_by === payload.accepted_by &&
      (p.notes ?? null) === (payload.notes ?? null) &&
      (p.ts ?? null) === (payload.ts ?? null)
    );
  }
  return false;
}

/** One gate rule on the verdict record — the fail-closed alert it
 *  raises, or undefined when the record passes it. */
type VerdictGate = (call: StageCall, raw: Record<string, unknown>) => EngineAlert | undefined;

/** raw.verdict names one of the stage's declared verdict words. */
const verdictDeclared: VerdictGate = (call, raw) => {
  const v = raw.verdict;
  return typeof v === 'string' && call.stage.verdicts.includes(v)
    ? undefined
    : malformed(
        `verdict ${JSON.stringify(v)} is not one of the accept stage's verdicts ` +
          `(${call.stage.verdicts.join('|')})`
      );
};

/** The record names THIS run's item — attribution: the channel file
 *  keys the run, and a record naming another item (a blindly pinned
 *  --run's foreign verdict) is malformed input, never a settling one. */
const itemAttributed: VerdictGate = (call, raw) =>
  raw.item === call.item
    ? undefined
    : malformed(
        `verdict names item ${JSON.stringify(raw.item)} — ` +
          `this run's item is ${JSON.stringify(call.item)}`
      );

/** `accepted_by` is a non-empty string — the signer the gate compares. */
const signerField: VerdictGate = (_call, raw) =>
  typeof raw.accepted_by === 'string' && raw.accepted_by !== ''
    ? undefined
    : malformed('accepted_by is missing or not a non-empty string');

/** `notes` is a string when present — shape before the notes rule. */
const notesField: VerdictGate = (_call, raw) =>
  raw.notes === undefined || typeof raw.notes === 'string'
    ? undefined
    : malformed('notes must be a string when present');

/** `ts` is a string when present — shape before provenance use. */
const tsField: VerdictGate = (_call, raw) =>
  raw.ts === undefined || typeof raw.ts === 'string'
    ? undefined
    : malformed('ts must be a string when present');

/** The identity gate — only the recorded customer moves accept; a
 *  worker's signature is a park, never a transition. */
const signerMatches: VerdictGate = (call, raw) =>
  raw.accepted_by === call.customer
    ? undefined
    : {
        alert: PARK_ALERTS.customerMismatch,
        detail:
          `verdict signed by ${JSON.stringify(raw.accepted_by)} — ` +
          `run customer is ${JSON.stringify(call.customer)}`,
      };

/** A string with no non-whitespace content — no fix scope at all. */
const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

/** `rejected` carries non-empty notes — the customer's fix scope
 *  (same contract as review.fix). Runs after the shape gates, so
 *  `notes` here is a string or absent. */
const fixNotesPresent: VerdictGate = (_call, raw) =>
  raw.verdict === REJECTED_VERDICT && blank(raw.notes as string | undefined)
    ? {
        alert: PARK_ALERTS.fixNotesMissing,
        detail: "accept.rejected requires non-empty notes — the customer's fix scope",
      }
    : undefined;

/** The fail-closed record gates, in contract order — the FIRST
 *  complaint is the alert raised, so a record failing several rules
 *  still surfaces the same park the sequential chain produced
 *  (shape → attribution → fields → identity → fix scope). */
const VERDICT_GATES: readonly VerdictGate[] = [
  verdictDeclared,
  itemAttributed,
  signerField,
  notesField,
  tsField,
  signerMatches,
  fixNotesPresent,
];

/** The journaled echo of the record the gate consumes —
 *  `accepted_by` always, `notes`/`ts` only when the record carried
 *  them (the consumption ledger deep-equals on these fields). */
const verdictPayload = (raw: Record<string, unknown>): AcceptPayload => ({
  accepted_by: raw.accepted_by as string,
  ...(raw.notes !== undefined ? { notes: raw.notes as string } : {}),
  ...(raw.ts !== undefined ? { ts: raw.ts as string } : {}),
});

/** The verdict record → a settling result, 'pending', or a
 *  fail-closed alert — every gate rule in one place so invoke and
 *  recheck can never disagree on what counts. */
function outcomeFromVerdict(call: StageCall, raw: unknown): EngineOutcome {
  if (raw === undefined) {
    return 'pending';
  }
  if (!isRecord(raw)) {
    return malformed('the customer verdict record is not a record');
  }
  for (const gate of VERDICT_GATES) {
    const denied = gate(call, raw);
    if (denied !== undefined) {
      return denied;
    }
  }
  const payload = verdictPayload(raw);
  const verdict = raw.verdict as string; // a declared word — the shape gate proved it
  if (consumedVerdict(call, verdict, payload)) {
    // this exact record already settled an earlier accept entry —
    // the customer must decide each entry fresh; the pending intent
    // stays the resume anchor until a new record lands
    return 'pending';
  }
  return { verdict, payload };
}

/** No recorded customer → the gate can never pass → fail closed
 *  BEFORE the bundle emits (evidence must not leak to a channel
 *  nobody can sign through). */
const customerGate = (call: StageCall): EngineAlert | undefined =>
  call.customer === undefined || call.customer === ''
    ? {
        alert: PARK_ALERTS.customerMismatch,
        detail: 'run has no recorded customer — no identity can sign accept',
      }
    : undefined;

/**
 * The accept stage as an EngineHandler for the runner's `accept`
 * slot. `invoke` emits the evidence bundle then settles a
 * pre-landed verdict or answers 'pending'; `recheck` polls the
 * store — a landed verdict settles/alerts, absence re-emits
 * (idempotent channel) and stays pending. Neither path ever
 * fabricates a verdict: the customer's record is the only input
 * that moves this gate.
 */
export function acceptStage(deps: AcceptDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineOutcome> {
      const denied = customerGate(call);
      if (denied !== undefined) {
        return denied;
      }
      await deps.emit(call, evidenceBundle(call));
      return outcomeFromVerdict(call, await deps.verdictStore(call));
    },
    async recheck(call: StageCall): Promise<EngineOutcome | undefined> {
      const denied = customerGate(call);
      if (denied !== undefined) {
        return denied;
      }
      const raw = await deps.verdictStore(call);
      if (raw === undefined) {
        // the emit may have died inside the pending intent's crash
        // window — re-emit (the channel dedups on run+stage), then
        // stay suspended: the intent remains the resume anchor
        await deps.emit(call, evidenceBundle(call));
        return 'pending';
      }
      return outcomeFromVerdict(call, raw);
    },
  };
}
