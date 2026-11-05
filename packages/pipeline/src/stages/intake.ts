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
import type { EngineHandler, EngineResult, StageCall } from '../runner.ts';

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
  if (
    typeof out.verdict !== 'string' ||
    !(INTAKE_VERDICTS as readonly string[]).includes(out.verdict)
  ) {
    throw new Error(
      `intake: the judgment seam returned a malformed outcome — ` +
        `verdict must be one of ${INTAKE_VERDICTS.join('|')}, got ${JSON.stringify(out.verdict)}`
    );
  }
  switch (out.verdict) {
    case 'questions':
      if (
        !Array.isArray(out.questions) ||
        out.questions.length === 0 ||
        !out.questions.every(isNonBlank)
      ) {
        throw new Error(
          'intake: the judgment seam returned a malformed outcome — ' +
            'a "questions" verdict requires a non-empty question list'
        );
      }
      stray(out, 'feedback');
      break;
    case 'declined':
      if (!isNonBlank(out.feedback)) {
        throw new Error(
          'intake: the judgment seam returned a malformed outcome — ' +
            'a "declined" verdict requires non-empty feedback'
        );
      }
      stray(out, 'questions');
      break;
    case 'accepted':
      stray(out, 'questions');
      stray(out, 'feedback');
      break;
  }
}

/** The artifact write — `questions`/`declined` land ON the item
 *  through the facade's annotate path: the question list as bullets
 *  under `## Questions`, the decline reasons under `## Declined`
 *  (the feedback's own line structure). The customer's answers append
 *  on the same body, so the next intake pass reads the enriched spec. */
function annotateArtifact(deps: IntakeDeps, item: string, out: IntakeOutcome): void {
  if (out.verdict === 'questions') {
    deps.taskSpec.annotate(
      item,
      QUESTIONS_HEADING,
      out.questions.map(q => `- ${q}`)
    );
  } else if (out.verdict === 'declined') {
    deps.taskSpec.annotate(item, DECLINED_HEADING, out.feedback.split(/\r?\n/));
  }
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
    async invoke(call: StageCall): Promise<EngineResult> {
      const spec = deps.taskSpec.spec(call.item);
      if (spec === undefined) {
        throw new Error(`intake: item "${call.item}" is not in the task store`);
      }
      const out = await deps.intake(call, spec);
      checkOutcome(out);
      annotateArtifact(deps, call.item, out);
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
      return { verdict: out.verdict, payload: p };
    },
  };
}
