/**
 * The `intake` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-qjji2.3) — task acceptance. The worker validates the TASK (its
 * definition-of-ready) before committing; one item, one judgment:
 *
 *   accepted  — the spec is workable; commit          → work
 *   questions — gaps only the customer can answer     → park
 *   declined  — the spec fails requirements           → close
 *
 * `declined` is CLOSE, not abandon: the work was never refused for
 * cause, the spec was — the item returns to the customer for
 * redrafting (spec §transitions).
 *
 * The stage reads the item's spec through `taskSpec` — the semantic
 * facade (AC/DoR/DoD/scenarios), never the store's row API — and hands
 * that same object to the judgment seam, so the spec the fingerprint
 * records is exactly the spec the worker judged. `accepted` journals
 * the acceptance point: who took the task (the routed
 * provider/model/kind/orch slot read out of the pipeline context —
 * nested under `worker` so the flat merge can't clobber route's own
 * keys, same rule as review's `reviewer`) on which spec revision (a
 * sha over the judged fields plus a presence vector — an `accepted`
 * on a spec with zero AC is journaled as `acceptance: 0`, never
 * silent; whether bare AC means not-ready is the WORKER's DoR call,
 * verify's `unverifiable` stays the deterministic backstop the spec
 * assigns it). `questions`/`declined` land their artifact ON the item
 * through `annotate` — the same facade's write path — so the
 * customer's answers enrich the spec the next intake pass reads
 * (`questions → park`, wake on `bro pipeline answer`).
 *
 * The answer half of that contract is real, not aspirational: every
 * invoke first drains the run's customer channel through the
 * `answers` feed — pending `answer` records land on the item under
 * `## Answers` (the unmanaged domain heading, never pipeline
 * vocabulary), the feed's `consume` stamps the drain point so no
 * record is re-fed on a later wake, and the judgment then reads the
 * ENRICHED spec. Malformed records (missing/foreign item, empty or
 * unshaped payload, artifact text that would open markdown
 * structure) park the run `answer-malformed` — the drain marker
 * covers them too, so the same bad row can't re-alert every wake;
 * the customer's corrected append is what repairs it. An unbound
 * feed simply judges the spec as it stands.
 *
 * Why a direct seam and not a typed-question decide: the stage's
 * contract emits `{questions: [string], feedback: string}` — free
 * text the judge contract (choice/score/noul) cannot carry, so the
 * G-stages' decide shape has no representation for this payload.
 * `deps.intake` is therefore the capture-style seam: it returns the
 * typed outcome wholesale and the engine validates it the way
 * checkOutcome does — a `questions` verdict requires a non-empty
 * question list, `declined` requires non-empty feedback, and a stray
 * field on the wrong arm is malformed too (an `accepted` carrying
 * questions is a contradiction, not an acceptance). A malformed
 * outcome THROWS: invalid input fails loud, the pending intent is the
 * crash marker, and the bounded re-fire gives a transient bad
 * judgment another read before attempts exhaust to park — the same
 * fail-closed destination as review's missing-notes contract, reached
 * through the crash path: here the payload is not a re-entry input
 * the runner consumes (that is what review's `notes` check guards),
 * it is the artifact the customer reads, so the seam boundary is
 * where it is checked.
 *
 * No recheck hook: `spec` is not a spawn-like intent, so a
 * verdict-less record re-fires inside the attempt budget like the
 * judge stages'. Re-fire re-reads the (possibly annotated) spec and
 * re-judges; `annotate` is an append, so a crash inside the
 * annotate→verdict window can leave a duplicated `## Questions`
 * section — semantic idempotence (the unanswered questions are still
 * unanswered), not literal.
 */
import { createHash } from 'node:crypto';
import type { MaybePromise, TaskSpec, TaskSpecFacade } from '@broject/core';
import type { AnswerFeed } from '../customer.ts';
import {
  type EngineAlert,
  type EngineHandler,
  type EngineOutcome,
  PARK_ALERTS,
  type StageCall,
} from '../runner.ts';

/** The intake verdicts — the formula's declared enum. */
export const INTAKE_VERDICTS = ['accepted', 'questions', 'declined'] as const;
export type IntakeVerdict = (typeof INTAKE_VERDICTS)[number];

/** Item-body headings the intake artifacts land under — domain words
 *  (a question list, a decline note), never pipeline vocabulary
 *  (spec §invariants: no stage/gate words in agent-facing artifacts).
 *  Unmanaged names, so a re-intake after answers can append its own
 *  section — the earlier rounds stay visible as spec history. */
export const QUESTIONS_HEADING = 'Questions';
export const DECLINED_HEADING = 'Declined';
/** The customer's replies to `## Questions` — landed per answer
 *  record; unmanaged so repeated answer rounds each keep their own
 *  section (the earlier rounds stay visible as spec history). */
export const ANSWERS_HEADING = 'Answers';

/** The judgment seam's return — the worker's typed intake answer. A
 *  discriminated union: each arm carries exactly the fields its
 *  verdict contracts (the seam can't type a `questions` verdict
 *  without its list; runtime input is still validated — JS seams can
 *  lie). */
export type IntakeOutcome =
  | { verdict: 'accepted' }
  | { verdict: 'questions'; questions: string[] }
  | { verdict: 'declined'; feedback: string };

/** The spec fingerprint — which revision of the item's spec the
 *  judgment read (`accepted` journals "who took the task, on which
 *  spec sha"). The presence vector keeps the spec's shape honest in
 *  the journal: counts for list fields, flags for text sections. */
export interface SpecFingerprint {
  /** sha256 over the canonical spec projection — the judged fields in
   *  contract order, same bytes the seam read */
  sha: string;
  /** AC row count — 0 is verify's `unverifiable` input; journaled
   *  here so an `accepted` on a spec with no AC is never silent */
  acceptance: number;
  /** test-scenario count */
  scenarios: number;
  /** `## DoD` present */
  dod: boolean;
  /** `## DoR` present */
  dor: boolean;
  /** the item carries context prose beyond the managed sections */
  body: boolean;
}

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under `intake` (spec §typed stage outputs):
 *  `{verdict, questions?, feedback?}` plus provenance. */
export interface IntakePayload {
  /** the emitted verdict, restated in the payload per the spec shape */
  verdict: IntakeVerdict;
  /** which spec revision was judged */
  spec: SpecFingerprint;
  /** `questions` verdict: the non-empty list — also annotated on the
   *  item so the customer can answer it there */
  questions?: string[];
  /** `declined` verdict: why the spec fails requirements — also
   *  annotated on the item */
  feedback?: string;
  /** who took the task — the routed worker slot harvested from the
   *  pipeline context (route's flat-merged fields); nested so later
   *  stages' own provider/model keys can't rewrite it */
  worker?: { provider?: string; model?: string; kind?: string; orch?: string };
}

export interface IntakeDeps {
  /** the task-spec facade — `spec` reads the item's spec, `annotate`
   *  lands intake artifacts on it (spec §task spec facade: the same
   *  seam is the read AND the write path). Prod binds
   *  `taskSpecFacade(taskStore(dir))`. */
  taskSpec: TaskSpecFacade;
  /** the worker's DoR judgment — reads the spec, answers the typed
   *  intake outcome. Prod wires whatever agent-ask channel the run's
   *  routed worker speaks; the seam owns the verdict, the engine owns
   *  its contract. */
  intake: (call: StageCall, spec: TaskSpec) => MaybePromise<IntakeOutcome>;
  /** the customer-channel answer feed — drained BEFORE the judgment:
   *  pending `answer` records annotate onto the item under
   *  `## Answers`, `consume` stamps the drain point (exactly-once
   *  per record — a wake never re-feeds it), and the seam judges the
   *  enriched spec. Prod binds `fileAnswerFeed(dir)`; unbound, the
   *  stage judges the spec as it stands (the answer CLI's record
   *  then stays harmlessly unconsumed). */
  answers?: (call: StageCall) => MaybePromise<AnswerFeed>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A present non-blank string — a blank question is no question, a
 *  blank feedback is no reason. */
const isNonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The spec sha — sha256 over the canonical projection of the judged
 *  fields. `JSON.stringify` on a fixed-shape literal is the canonical
 *  form (key order is the contract order, undefined drops), so equal
 *  specs hash equal and any spec edit — including the annotated
 *  artifacts a re-intake reads — is a new sha worth tracing. */
function specSha(spec: TaskSpec): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: spec.title,
        body: spec.body,
        acceptance: spec.acceptance,
        dod: spec.dod,
        dor: spec.dor,
        scenarios: spec.scenarios,
      })
    )
    .digest('hex');
}

/** The judged revision — the sha plus the presence vector. */
function fingerprint(spec: TaskSpec): SpecFingerprint {
  return {
    sha: specSha(spec),
    acceptance: spec.acceptance?.length ?? 0,
    scenarios: spec.scenarios?.length ?? 0,
    dod: spec.dod !== undefined,
    dor: spec.dor !== undefined,
    body: spec.body !== undefined,
  };
}

/** Who took the task — the routed slot read off the pipeline
 *  context's flat merge (route's `provider`/`model`/`kind`/`orch`),
 *  so the pin resolves whatever the formula names its routing stage.
 *  Only well-typed fields ride along; nothing routed → no worker. */
function workerOf(call: StageCall): IntakePayload['worker'] {
  const worker: NonNullable<IntakePayload['worker']> = {};
  for (const k of ['provider', 'model', 'kind', 'orch'] as const) {
    const v = call.ctx[k];
    if (isNonBlank(v)) {
      worker[k] = v;
    }
  }
  return Object.keys(worker).length === 0 ? undefined : worker;
}

/** A stray field on the wrong arm — an `accepted` carrying questions
 *  is a contradiction (the worker can't both commit and park for
 *  answers), a `questions` carrying feedback has no place to land it. */
function stray(out: IntakeOutcome, k: 'questions' | 'feedback'): void {
  if ((out as Record<string, unknown>)[k] !== undefined) {
    throw new Error(
      `intake: the judgment seam returned a malformed outcome — ` +
        `a "${out.verdict}" verdict carries no ${k}`
    );
  }
}

/** The questions arm's contract — a non-empty list of non-blank
 *  strings, one named guard so the arm check stays single-branch. */
const isQuestionList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every(isNonBlank);

/** Per-verdict outcome contracts — the requirements each arm must
 *  satisfy before its outcome can become the stage's payload. The
 *  lookup in {@link checkOutcome} is own-key gated: a prototype member
 *  (`toString`, `constructor`) is a function too, and an ungated index
 *  would invoke it instead of failing closed. */
const ARM_CHECKS: Record<IntakeVerdict, (out: IntakeOutcome) => void> = {
  questions: out => {
    if (!isQuestionList((out as Record<string, unknown>).questions)) {
      throw new Error(
        'intake: the judgment seam returned a malformed outcome — ' +
          'a "questions" verdict requires a non-empty question list'
      );
    }
    stray(out, 'feedback');
  },
  declined: out => {
    if (!isNonBlank((out as Record<string, unknown>).feedback)) {
      throw new Error(
        'intake: the judgment seam returned a malformed outcome — ' +
          'a "declined" verdict requires non-empty feedback'
      );
    }
    stray(out, 'questions');
  },
  accepted: out => {
    stray(out, 'questions');
    stray(out, 'feedback');
  },
};

/** The seam's outcome, validated before it becomes the payload —
 *  `questions` requires a non-empty list of non-blank strings,
 *  `declined` requires non-blank feedback, `accepted` carries neither.
 *  A malformed outcome is never echoed into the pipeline context nor
 *  annotated onto the item: the judgment DID run, but an unreadable
 *  answer can't be trusted as the stage's typed output — fail loud,
 *  the bounded re-fire re-asks (spec §typed stage outputs: "a
 *  malformed payload fails closed"). */
function checkOutcome(out: IntakeOutcome): void {
  if (!isRecord(out)) {
    throw new Error('intake: the judgment seam returned a malformed outcome — expected a record');
  }
  const checks: Partial<Record<string, (o: IntakeOutcome) => void>> = ARM_CHECKS;
  const check =
    typeof out.verdict === 'string' && Object.hasOwn(ARM_CHECKS, out.verdict)
      ? checks[out.verdict]
      : undefined;
  if (check === undefined) {
    throw new Error(
      `intake: the judgment seam returned a malformed outcome — ` +
        `verdict must be one of ${INTAKE_VERDICTS.join('|')}, got ${JSON.stringify(out.verdict)}`
    );
  }
  check(out);
}

/** Artifact text → emitted lines — the sanitize the write path
 *  needs: every line leaves as a `- ` bullet, so a heading or fence
 *  marker inside the artifact's text is bullet text, never structure
 *  — annotate's own guard would throw on it, and a `## Acceptance`
 *  slipped into a question would otherwise inject managed fields on
 *  the next parse. The text survives verbatim after the marker;
 *  multi-line input keeps its line shape, one bullet per line. */
const artifactLines = (text: string): string[] => text.split(/\r?\n/).map(l => `- ${l}`);

/** The artifact write — `questions`/`declined` land ON the item
 *  through the facade's annotate path: the question list as bullets
 *  under `## Questions`, the decline reasons under `## Declined`,
 *  every line {@link artifactLines}-sanitized so artifact text can
 *  never open structure. The customer's answers append on the same
 *  body, so the next intake pass reads the enriched spec. */
function annotateArtifact(deps: IntakeDeps, item: string, out: IntakeOutcome): void {
  if (out.verdict === 'questions') {
    deps.taskSpec.annotate(item, QUESTIONS_HEADING, out.questions.flatMap(artifactLines));
  } else if (out.verdict === 'declined') {
    deps.taskSpec.annotate(item, DECLINED_HEADING, artifactLines(out.feedback));
  }
}

/** The kind-less answer shape — a hand-written row carrying `answers`
 *  without the CLI's kind tag; still fully validated downstream. */
const isKindlessAnswer = (v: Record<string, unknown>): boolean =>
  v.kind === undefined && 'answers' in v;

/** A candidate answer row — the CLI's `kind:"answer"` record, or a
 *  kind-less row still carrying `answers` (the same admission rule as
 *  the accept gate's verdict candidates: a hand-written row the stage
 *  should see — and fully validate). Other kinds ride the same
 *  channel file and are not intake input. */
const isAnswerCandidate = (v: unknown): boolean =>
  isRecord(v) && (v.kind === 'answer' || isKindlessAnswer(v));

/** A bare-string answer — lands verbatim; whitespace-only is no
 *  answer. */
const stringAnswer = (v: string): string[] | undefined => (v.trim() === '' ? undefined : [v]);

/** An array answer — element-per-line (non-strings JSON-stamped);
 *  all-blank is no answer. */
const listAnswers = (v: unknown[]): string[] | undefined => {
  const lines = v.map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
  return lines.every(l => l.trim() === '') ? undefined : lines;
};

/** A qid→answer map — one `qid: answer` line per entry; an empty map
 *  is no answer. */
const mapAnswers = (v: Record<string, unknown>): string[] | undefined => {
  const lines = Object.entries(v).map(
    ([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`
  );
  return lines.length === 0 ? undefined : lines;
};

/** A scalar answer — number/boolean lands as its literal. */
const scalarAnswer = (v: unknown): string[] | undefined =>
  typeof v === 'number' || typeof v === 'boolean' ? [String(v)] : undefined;

/** The `answers` payload → artifact lines: a bare string lands
 *  verbatim, a qid→answer map lands one `qid: answer` line per entry,
 *  an array lands element-per-line (non-strings JSON-stamped), a
 *  scalar lands as its literal. Empty or unshaped payloads are no
 *  answer — malformed, never annotated. */
function answerLines(answers: unknown): string[] | undefined {
  if (typeof answers === 'string') {
    return stringAnswer(answers);
  }
  if (Array.isArray(answers)) {
    return listAnswers(answers);
  }
  if (isRecord(answers)) {
    return mapAnswers(answers);
  }
  return scalarAnswer(answers);
}

/** The record's `item` field → why it can't be attributed, or
 *  undefined when it names this run's item — a record that can't be
 *  attributed is never landed (same attribution check the accept
 *  gate's verdict records pass). */
function attributionErr(o: Record<string, unknown>, item: string): string | undefined {
  if (typeof o.item !== 'string' || o.item === '') {
    return 'item is missing or not a non-empty string';
  }
  return o.item === item
    ? undefined
    : `names item ${JSON.stringify(o.item)}, not this run's ${JSON.stringify(item)}`;
}

/** An optional string field's contract — absent is fine, a non-string
 *  is malformed input. */
const optStringErr = (o: Record<string, unknown>, k: 'ts' | 'by'): string | undefined =>
  o[k] !== undefined && typeof o[k] !== 'string' ? `${k} must be a string when present` : undefined;

/** One drained record → its artifact lines, or why it is malformed.
 *  `item` must name this run's item — a record that can't be
 *  attributed is never landed (same attribution check the accept
 *  gate's verdict records pass). */
function answerRow(v: unknown, item: string): { lines: string[] } | { err: string } {
  const o = v as Record<string, unknown>;
  const err = attributionErr(o, item) ?? optStringErr(o, 'ts') ?? optStringErr(o, 'by');
  if (err !== undefined) {
    return { err };
  }
  const lines = answerLines(o.answers);
  return lines === undefined ? { err: 'the answers payload is empty or unshaped' } : { lines };
}

/** The facade's artifact guard refusing a poisoned line — malformed
 *  INPUT, not a crash (a missing row or store write error still
 *  throws through the normal crash path). */
const isGuardRefusal = (e: unknown): e is Error =>
  e instanceof Error && e.message.includes('opens structure');

/** One record through the drain — skipped (not intake input), landed
 *  (annotated under `## Answers`), or bad (malformed input, collected
 *  for the alert). */
type DrainRow = 'skipped' | 'landed' | { err: string };

function landRecord(deps: IntakeDeps, call: StageCall, r: unknown): DrainRow {
  if (!isAnswerCandidate(r)) {
    return 'skipped'; // a verdict row on the same file — not intake input
  }
  const out = answerRow(r, call.item);
  if ('err' in out) {
    return out;
  }
  try {
    deps.taskSpec.annotate(call.item, ANSWERS_HEADING, out.lines);
    return 'landed';
  } catch (e) {
    if (isGuardRefusal(e)) {
      return { err: 'an answer line opens markdown structure — artifact text must stay prose' };
    }
    throw e;
  }
}

/** The fail-closed park — every malformed record named in the alert
 *  detail so the customer's corrected append knows what to fix. */
const malformedAlert = (bad: string[]): EngineAlert => ({
  alert: PARK_ALERTS.answerMalformed,
  detail: `${bad.length} malformed answer record(s): ${bad.join('; ')}`,
});

/** The drain's outcome — an alert when any record was malformed, else
 *  the spec the judgment reads: the ENRICHED one when an annotate
 *  landed, the one it came in with otherwise. */
function drainOutcome(
  deps: IntakeDeps,
  call: StageCall,
  spec: TaskSpec,
  annotated: boolean,
  bad: string[]
): { spec: TaskSpec } | { alert: EngineAlert } {
  if (bad.length > 0) {
    return { alert: malformedAlert(bad) };
  }
  return { spec: annotated ? (deps.taskSpec.spec(call.item) ?? spec) : spec };
}

/** The drained answer feed → the spec the judgment reads — or a
 *  fail-closed `answer-malformed` alert. Well-formed `answer`
 *  records land on the item under `## Answers` before `consume`
 *  stamps the drain point: a crash between the two re-feeds the rows
 *  on the next wake — the annotate is append-shaped, so a re-drain
 *  adds a fresh section, never a clobber (the marker's whole job is
 *  making the NORMAL wake exactly-once). Malformed records are
 *  consumed too — consumed does not mean landed; it means "was
 *  offered once" — so the same bad row can't re-alert every wake. */
async function landAnswers(
  deps: IntakeDeps,
  call: StageCall,
  feed: AnswerFeed,
  spec: TaskSpec
): Promise<{ spec: TaskSpec } | { alert: EngineAlert }> {
  const bad: string[] = [];
  let annotated = false;
  for (const r of feed.records) {
    const d = landRecord(deps, call, r);
    if (isRecord(d)) {
      bad.push(d.err);
    } else {
      annotated ||= d === 'landed';
    }
  }
  await feed.consume();
  return drainOutcome(deps, call, spec, annotated, bad);
}

/** The answers half of invoke — fetch the run's feed and land pending
 *  answer records on the item, handing back the spec the judgment
 *  reads (the enriched one when anything landed) or the fail-closed
 *  `answer-malformed` alert. An unbound or empty feed simply passes
 *  the spec through. */
async function drainAnswers(
  deps: IntakeDeps,
  call: StageCall,
  spec: TaskSpec
): Promise<{ spec: TaskSpec } | { alert: EngineAlert }> {
  const feed = deps.answers === undefined ? undefined : await deps.answers(call);
  return feed === undefined || feed.records.length === 0
    ? { spec }
    : landAnswers(deps, call, feed, spec);
}

/** The judged outcome → the journaled payload — the verdict restated,
 *  the fingerprint of the spec that was judged, the arm's own fields
 *  (a `questions` list, a `declined` feedback string), and the routed
 *  worker slot when one rode the context. */
function intakePayload(call: StageCall, out: IntakeOutcome, spec: TaskSpec): IntakePayload {
  const p: IntakePayload = { verdict: out.verdict, spec: fingerprint(spec) };
  if (out.verdict === 'questions') {
    p.questions = [...out.questions];
  } else if (out.verdict === 'declined') {
    p.feedback = out.feedback;
  }
  const worker = workerOf(call);
  if (worker !== undefined) {
    p.worker = worker;
  }
  return p;
}

/**
 * The intake stage as an EngineHandler for the runner's `intake` slot —
 * read the spec, take the worker's judgment, validate the outcome,
 * annotate the artifact, emit the typed payload. A missing item, a
 * malformed outcome, and a seam or annotate throw all propagate: the
 * pending intent is the crash marker and the bounded re-fire waits
 * for the world to make sense (a store write that failed may land on
 * the retry; a persistently malformed judgment parks on
 * attempts-exhausted). Bind what the formula uses:
 *
 *   engines: { intake: intakeStage(deps) }
 */
export function intakeStage(deps: IntakeDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineOutcome> {
      const spec = deps.taskSpec.spec(call.item);
      if (spec === undefined) {
        throw new Error(`intake: item "${call.item}" is not in the task store`);
      }
      const landed = await drainAnswers(deps, call, spec);
      if ('alert' in landed) {
        return landed.alert;
      }
      const out = await deps.intake(call, landed.spec);
      checkOutcome(out);
      annotateArtifact(deps, call.item, out);
      return { verdict: out.verdict, payload: intakePayload(call, out, landed.spec) };
    },
  };
}
