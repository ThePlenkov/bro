/**
 * The `verify` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-qjji2.4) — DoD self-validation: the work output is checked
 * against the item's DECLARED acceptance criteria, one evidence row
 * per criterion, the stage's verdict derived from the rows — never
 * asked:
 *
 *   verified     — every AC's evidence passes        → review
 *   failed       — any AC's evidence fails           → work (the
 *                  failing rows compose the fix scope)
 *   unverifiable — the item carries no usable AC     → park: a task
 *                  that cannot be verified cannot be accepted, so it
 *                  goes back for spec enrichment, never silently
 *                  through
 *
 * The stage never runs a check itself: the injected `e2e` seam IS the
 * agentic e2e pipeline (prod binds the real runner later). Each
 * declared AC is handed over once, in declared order; the seam
 * answers an evidence row `{ac, verdict, proof}` — a test run, a
 * rendered probe, a file fact — never the worker's bare claim. `proof`
 * is a typed {@link ProofRef} (`{kind, ref, ts?}` — bro-qjji2.14) so
 * the journaled evidence the accept bundle and retros read is
 * machine-checkable; the seam may still answer the pre-.14 bare
 * string, which the stage normalizes to `{kind: 'probe', ref}`.
 * A malformed row — missing ac/verdict/proof, a verdict outside
 * pass|fail, a proof that is neither a usable ref nor a legacy
 * string, an `ac` that is not the asked criterion — THROWS: the
 * same fail-loud posture as capture's outcome validation, because an
 * unreadable row is evidence that cannot be trusted, and echoing it
 * into the pipeline context would launder it into the verdict's
 * proof.
 *
 * The AC list comes from the `taskSpec` seam — the spec projection of
 * the item's body (TaskSpecFacade, §task spec facade), never the
 * store's native row API. `acceptance` absent or empty is not "no
 * checks": it is the `unverifiable` input by contract.
 *
 * Injected seams keep the stage provider- and store-agnostic:
 * `taskSpec` fronts the task store (bd is the first adapter of that
 * facade); `e2e` fronts whatever runner produces per-AC evidence.
 */
import type { MaybePromise, TaskSpec } from '@broject/core';
import type { EngineHandler, EngineResult, StageCall } from '../runner.ts';

/** The stage's declared verdicts — the formula's enum. */
export const VERIFY_VERDICTS = ['verified', 'failed', 'unverifiable'] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/** An evidence row's verdict enum — the seam speaks pass|fail only. */
export const ROW_VERDICTS = ['pass', 'fail'] as const;
export type RowVerdict = (typeof ROW_VERDICTS)[number];

/** The evidence kinds — the spec's taxonomy verbatim (a test run, a
 *  rendered probe, a file fact). `probe` doubles as the generic kind:
 *  a ref whose producer declared nothing more specific. */
export const PROOF_KINDS = ['test-run', 'probe', 'file-fact'] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

/** A typed proof ref — where the evidence lives, never the claim.
 *  `kind` says WHAT produced it, `ref` is the opaque locator (a run
 *  id, an artifact ref, a file-fact reference), `ts` the optional
 *  ISO-8601 production stamp — provenance the stage never fabricates. */
export interface ProofRef {
  kind: ProofKind;
  ref: string;
  ts?: string;
}

/** One criterion's evidence — the e2e seam's answer for the asked AC.
 *  `ac` echoes the criterion verbatim so the row is attributable;
 *  `proof` is the typed ref the accept bundle and retros consume —
 *  a ref, never the claim itself. */
export interface EvidenceRow {
  ac: string;
  verdict: RowVerdict;
  proof: ProofRef;
}

/** The seam's answer row — `proof` admits the typed {@link ProofRef}
 *  OR the pre-.14 bare string (normalized to `{kind: 'probe', ref}`
 *  before journaling, so the payload shape is always canonical). A
 *  typed `EvidenceRow` satisfies this — the union only widens what
 *  the port accepts, never what the stage emits. */
export interface SeamEvidenceRow {
  ac: string;
  verdict: RowVerdict;
  proof: ProofRef | string;
}

/** The task-spec seam — verify reads the item's declared AC through
 *  the spec facade, never the store's row API. Narrower than
 *  TaskSpecFacade (annotate is intake's write path, verify only
 *  reads): the facade satisfies it structurally, so prod binds
 *  `taskSpecFacade(taskStore(dir))` directly. */
export interface VerifySpec {
  spec(id: string): TaskSpec | undefined;
}

export interface VerifyDeps {
  /** the spec facade — the item's declared AC list. */
  taskSpec: VerifySpec;
  /** the per-AC evidence seam — called once per declared criterion,
   *  in declared order; answers the row attesting that AC. Prod binds
   *  the agentic e2e runner; the stage itself invokes no test
   *  runner. `proof` may be the typed {@link ProofRef} or a legacy
   *  bare string (normalized — see {@link SeamEvidenceRow}). */
  e2e: (call: StageCall, ac: string) => MaybePromise<SeamEvidenceRow>;
}

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under `verify` (spec §typed stage outputs: `{rows, summary?}`;
 *  `notes` joins on `failed` — the composed fix scope). */
export interface VerifyPayload {
  /** one row per declared AC, declared order — the evidence bundle
   *  `accept` later signs */
  rows: EvidenceRow[];
  /** the derived headline — a deterministic line off the rows */
  summary?: string;
  /** the fix scope — REQUIRED non-empty on `failed` (composed from
   *  the failing rows; review's notes contract) */
  notes?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRowVerdict = (v: unknown): v is RowVerdict =>
  (ROW_VERDICTS as readonly string[]).includes(v as string);

/** One AC row — a non-empty criterion string (a `''` criterion could
 *  never produce an attributable evidence row). */
const isAcRow = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The AC list's contract — every member a usable criterion. The
 *  facade's parser never emits empty rows, but the seam is a port: a
 *  taskSpec implementation returning runtime garbage is malformed
 *  data, fail loud like every other broken input. */
const isAcList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isAcRow);

/** The declared AC list — absent is the unverifiable input; present
 *  must satisfy {@link isAcList}. */
function acListOf(spec: TaskSpec): string[] {
  const ac = spec.acceptance;
  if (ac === undefined) {
    return [];
  }
  if (!isAcList(ac)) {
    throw new Error(
      'verify: the taskSpec seam returned a malformed acceptance list — expected non-empty strings'
    );
  }
  return ac;
}

const isProofKind = (v: unknown): v is ProofKind =>
  (PROOF_KINDS as readonly string[]).includes(v as string);

/** The typed proof record — `kind` in the enum, `ref` a non-empty
 *  locator, `ts` a non-empty string when present. Extra producer
 *  fields are tolerated at the seam (the canonicalization drops
 *  them) — the journaled shape is exactly the schema. */
const isProofRefRecord = (v: unknown): v is ProofRef =>
  isRecord(v) &&
  isProofKind(v.kind) &&
  typeof v.ref === 'string' &&
  v.ref !== '' &&
  (v.ts === undefined || (typeof v.ts === 'string' && v.ts !== ''));

/** A usable proof ref — where the evidence lives, never the claim:
 *  either the typed {@link ProofRef} record or the pre-.14 bare
 *  string (normalized downstream, so both are seam-usable). */
const isProofInput = (v: unknown): v is ProofRef | string =>
  typeof v === 'string' ? v !== '' : isProofRefRecord(v);

/** The seam's own answer fields well-formed — verdict in the
 *  pass|fail enum, proof a usable ref (the `ac` echo is the
 *  attribution check, kept apart). */
const isSeamAnswer = (v: Record<string, unknown>): boolean =>
  isRowVerdict(v.verdict) && isProofInput(v.proof);

/** The asked criterion echoed back — an `ac` naming anything else is
 *  evidence of the wrong check. */
const echoesAc = (v: Record<string, unknown>, ac: string): boolean => v.ac === ac;

/** The evidence-row contract — a record echoing the asked criterion
 *  whose verdict and proof are well-formed. */
const isEvidenceRow = (v: unknown, ac: string): v is SeamEvidenceRow =>
  isRecord(v) && echoesAc(v, ac) && isSeamAnswer(v);

/** The canonical proof — typed refs pass through rebuilt (extra
 *  producer fields stay out of the journal), legacy bare strings
 *  normalize to the generic `probe` kind with the ref verbatim. */
function canonicalProof(proof: ProofRef | string): ProofRef {
  if (typeof proof === 'string') {
    return { kind: 'probe', ref: proof };
  }
  return {
    kind: proof.kind,
    ref: proof.ref,
    ...(proof.ts !== undefined ? { ts: proof.ts } : {}),
  };
}

/** One seam answer, validated before it becomes payload — and
 *  canonicalized, so the journaled row's `proof` is always the typed
 *  {@link ProofRef} shape regardless of which input form the seam
 *  answered. A malformed row throws like capture's malformed outcome:
 *  the check DID run, but an unreadable answer can't be journaled as
 *  the AC's proof. */
function checkRow(row: SeamEvidenceRow, ac: string): EvidenceRow {
  if (!isEvidenceRow(row, ac)) {
    throw new Error(
      `verify: the e2e seam returned a malformed evidence row — expected ` +
        `{ac: <the asked criterion>, verdict: pass|fail, ` +
        `proof: {kind: ${PROOF_KINDS.join('|')}, ref, ts?} | <bare ref string>}, ` +
        `got ${JSON.stringify(row)}`
    );
  }
  return { ac: row.ac, verdict: row.verdict, proof: canonicalProof(row.proof) };
}

/** The per-AC evidence sweep — one seam call per declared criterion,
 *  validated rows back in declared order. */
async function evidenceRows(
  deps: VerifyDeps,
  call: StageCall,
  acs: string[]
): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (const ac of acs) {
    rows.push(checkRow(await deps.e2e(call, ac), ac));
  }
  return rows;
}

/** The canonical text form of a proof ref — `${kind}:${ref}` — the
 *  one rendering every text consumer shares (the `failed` fix scope
 *  here; retros and any future evidence surface render through it
 *  rather than re-deriving the format). `ts` stays out: provenance
 *  is journaled on the row, notes stay compact. */
export function formatProof(proof: ProofRef): string {
  return `${proof.kind}:${proof.ref}`;
}

/** The `failed` fix scope — the failing rows rendered as the
 *  instruction a fix round addresses. Non-empty by construction:
 *  `failed` requires ≥1 failing row, and a validated row always
 *  carries a non-empty ac + proof — the same non-empty-notes
 *  guarantee the runner's scoped-fix contract leans on. */
function fixScope(fails: EvidenceRow[]): string {
  return (
    'address the failed acceptance criteria — ' +
    fails.map(r => `${r.ac} (evidence: ${formatProof(r.proof)})`).join('; ')
  );
}

/** The unverifiable arm's payload — the stage ran and found nothing
 *  to verify against. */
const unverifiablePayload = (): VerifyPayload => ({
  rows: [],
  summary: 'no declared acceptance criteria — the item cannot be verified',
});

/** Rows → verdict + payload — derived, never asked: every row
 *  passing is `verified`; any fail is `failed` with the failing rows
 *  composed into the fix-scope notes. */
function verdictOf(rows: EvidenceRow[]): EngineResult {
  const fails = rows.filter(r => r.verdict === 'fail');
  if (fails.length === 0) {
    const p: VerifyPayload = {
      rows,
      summary: `all ${rows.length} acceptance criteria verified`,
    };
    return { verdict: 'verified', payload: p };
  }
  const p: VerifyPayload = {
    rows,
    summary: `${fails.length} of ${rows.length} acceptance criteria failed`,
    notes: fixScope(fails),
  };
  return { verdict: 'failed', payload: p };
}

/**
 * The verify stage as an EngineHandler for the runner's `e2e` slot —
 * read the item's declared AC through the spec facade, run the e2e
 * seam once per criterion, derive the verdict from the rows. A
 * missing item, a malformed acceptance list, a malformed seam row,
 * and a seam throw all propagate: the pending intent is the crash
 * marker, and the seam's checks are read-only evidence probes, so a
 * verdict-less verify intent re-fires inside the attempt budget like
 * the judge and learn stages' — no `recheck` hook.
 */
export function verifyStage(deps: VerifyDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineResult> {
      const spec = deps.taskSpec.spec(call.item);
      if (spec === undefined) {
        throw new Error(`verify: item "${call.item}" is not in the task spec store`);
      }
      const acs = acListOf(spec);
      if (acs.length === 0) {
        return { verdict: 'unverifiable', payload: unverifiablePayload() };
      }
      return verdictOf(await evidenceRows(deps, call, acs));
    },
  };
}
