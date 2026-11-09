/**
 * The `review` stage engine (specs/bro-7d5nb.md §stages, epic child
 * bro-7d5nb.5) — G3 internal pre-push review. One item, one decide():
 * the judge reads the work's diff against the item's scope and the
 * core interprets typed answers into the stage's verdict enum:
 *
 *   abandon — wrong-headed, unsalvageable        → terminal failure
 *   fix     — blocking findings a round can mend → work (scoped-fix)
 *   push    — nothing a reviewer would block     → merge
 *
 * The stage is risk-gated upstream: `gate_on = "complexity ==
 * complex"` lets the runner synthesize `skip` for cheap items — the
 * engine runs only for gated-in work, and this file never sees the
 * gate itself.
 *
 * The payload the runner absorbs into the pipeline context (spec
 * §typed stage outputs — `{verdict, notes}` plus the review's
 * provenance):
 * `{verdict, notes?, findings?, reviewer?, judge?, diff?, lowConfidence?}`.
 * `notes` is REQUIRED non-empty on `fix` — it becomes the scoped-fix
 * re-entry's scope, and the runner fails closed (park + journal
 * alert) when it is absent. The judge contract speaks
 * choice/score/noul only, so notes are COMPOSED from the affirmed
 * finding categories' rubric text — an enum rendered as scope, never
 * prose the judge wrote. The reviewer slot nests under `reviewer` —
 * flat `provider`/`model` keys would overwrite route's own in the
 * merged context and flip their meaning mid-pipeline.
 *
 * Injected seams keep the stage provider- and store-agnostic: `judge`
 * is the JudgeFacade decide path; `backlog` fronts the task store for
 * the item read; `routing` + `providers` resolve `routing.review` —
 * the review-capable providers list — whose chain entries are held to
 * the `call` surface (reviewing is judging, not spawning: an `api`
 * provider with no spawn surface still reviews); `diff` is the
 * worktree-diff seam — the stage never invokes git, the seam reads
 * the recorded work/diff context the journal and pipeline context
 * carry; `walls` fronts derived provider walls so a walled reviewer
 * falls through to the next chain entry.
 */
import {
  type ChainEntry,
  type DecideResult,
  type JudgeFacade,
  type JudgeQuestion,
  type MaybePromise,
  type ProviderEntry,
  ProviderSurfaceError,
  type ProviderWall,
  type RoutingTable,
  requireProviderSurface,
  type TaskRow,
  UnknownProviderError,
} from '@broject/core';
import { journalRecords } from '../journal.ts';
import type { EngineHandler, EngineResult, StageCall } from '../runner.ts';
import { affirmed, confident } from './answers.ts';

/** `routing.<name>` the review chain lives under — a routing class
 *  literally named `review` in the same table the route lanes use. */
export const REVIEW_CLASS = 'review';

/** The diff text the decide state carries at most — a bounded window
 *  keeps one review's prompt inside the judge's context; the state
 *  marks the cut so the judge knows it saw a prefix. */
export const DEFAULT_MAX_DIFF_CHARS = 24_000;
/** File names shown per review — the rest reads as a count. */
export const DEFAULT_MAX_DIFF_FILES = 40;

/** The review verdicts — the formula's declared enum. */
export const REVIEW_VERDICTS = ['push', 'fix', 'abandon'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Blocking-finding categories — the enum `notes` composes from.
 *  Each kind's rubric IS the scope text a fix round addresses: a
 *  typed-answer judge can't emit free text, so the affirmed kind's
 *  rubric carries the actionable description into notes. */
export const FINDING_KINDS = {
  correctness: 'the diff is wrong or can land broken — logic, edge cases, regressions',
  scope: 'the diff misses parts of the item scope or carries unrelated change',
  tests: 'behavior changed without the coverage this repo expects',
  safety: 'a security or reliability hazard — secrets, injection, data loss, unsafe defaults',
  quality: 'a maintainability issue a reviewer would block on — dead code, unclear structure',
} as const;
export type FindingKind = keyof typeof FINDING_KINDS;

/** Notes a `fix` emits when the judge withheld push but categorized
 *  no finding — non-empty by construction so the scoped-fix re-entry
 *  always carries a scope (the runner parks a scopeless `fix`). */
export const UNCATEGORIZED_FIX_NOTES =
  'review withheld push without a categorized finding — re-check the diff ' +
  "against the item's scope and land whatever a clean re-review requires";

/** The worktree-diff seam's return — the diff the judge reads plus
 *  the provenance a review payload records. `diff` may be the empty
 *  string (a `done` work stage that changed nothing is a reviewable
 *  fact, not a missing one); `undefined` means the seam could not
 *  produce a reviewable artifact and the stage fails loud. */
export interface ReviewDiff {
  /** unified diff text */
  diff: string;
  /** files the diff touches — path names only */
  files?: string[];
  /** provenance of the reviewed artifact */
  worktree?: string;
  base?: string;
  head?: string;
}

/** The stage's typed payload — merged into the pipeline context flat
 *  AND under `review` (spec §typed stage outputs). */
export interface ReviewPayload {
  /** the emitted verdict, restated in the payload per the spec's
   *  `{verdict, notes}` shape */
  verdict: ReviewVerdict;
  /** the scoped-fix scope — REQUIRED non-empty on `fix` (composed
   *  from the affirmed findings' rubric text) */
  notes?: string;
  /** finding kinds the judge affirmed — also the abandon postmortem */
  findings?: FindingKind[];
  /** the resolved review-chain slot the verdict is attributed to —
   *  nested so the flat merge can't clobber route's own
   *  `provider`/`model` keys; the pair is a PAIR: a model pin
   *  belongs to its own provider only */
  reviewer?: { provider: string; model?: string };
  /** the decide's OWN attribution — the facade's resolved model and,
   *  when every answer names one connector, that connector. The
   *  backend that actually answered, distinct from the designated
   *  `reviewer` slot: the chain declares who MAY review, the decide
   *  records who DID. */
  judge?: { model: string; decidedBy?: string };
  /** the reviewed artifact's provenance */
  diff?: {
    worktree?: string;
    base?: string;
    head?: string;
    files: number;
    truncated: boolean;
  };
  /** question ids left under-confidence — telemetry, dimmed answers
   *  were not honored */
  lowConfidence?: string[];
}

/** The task-store seam — review reads the item the diff answers to.
 *  Structurally satisfied by classify's ClassifyBacklog, so prod can
 *  bind the same `taskBacklog(taskStore(dir))`. */
export interface ReviewBacklog {
  item(id: string): TaskRow | undefined;
}

export interface ReviewDeps {
  judge: JudgeFacade;
  backlog: ReviewBacklog;
  /** `fleet.routing` — `routing.review.chain` names the
   *  review-capable providers. Required: a review stage with no
   *  declared reviewer list cannot attribute a verdict. */
  routing: RoutingTable;
  /** the map chain entries validate their `call` surface against —
   *  a review chain naming an unconfigured or spawn-only provider is
   *  a config error naming the entry, same rule as the route lanes */
  providers: Record<string, ProviderEntry>;
  /** the worktree-diff seam — hands the stage the diff/context data
   *  the journaled work stage recorded; prod wires git behind it.
   *  Returns undefined when no reviewable artifact exists. */
  diff: (call: StageCall) => MaybePromise<ReviewDiff | undefined>;
  /** derived provider walls — a walled reviewer falls through to the
   *  next chain entry. Absent → nothing reads as walled. */
  walls?: () => ProviderWall[];
  /** decide-state cap on the diff text — default
   *  {@link DEFAULT_MAX_DIFF_CHARS} */
  maxDiffChars?: number;
}

/** Invocation context — one bag keeps the helpers under the arg
 *  ceiling (same Checks-pattern as classify/route). */
interface Cx {
  res: DecideResult;
  reviewer: ChainEntry;
  diff: ReviewDiff;
  /** the diff text exceeded the decide-state cap — payload records it */
  truncated: boolean;
  /** the cap the window was cut at — the truncation note names it */
  max: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const findingQid = (kind: FindingKind): string => `finding_${kind}`;

/** The judge-visible item — bead fields only (same read shape as
 *  classify/route: the reviewer judges the diff against the item's
 *  declared scope). */
const rowView = (r: TaskRow): Record<string, unknown> => ({
  id: r.id,
  title: r.title,
  description: r.description,
  labels: r.labels,
  priority: r.priority,
  parent: r.parent,
  status: r.status,
});

// --- the review chain --------------------------------------------------------------

/** One chain entry's surface check — `call` because reviewing is
 *  judging (an `api` entry that could never spawn still reviews); a
 *  miss is a config error naming the entry, same convention as
 *  `resolveStepClass`. */
function checkEntry(deps: ReviewDeps, i: number, e: ChainEntry): void {
  try {
    requireProviderSurface(deps.providers, e.provider, 'call');
  } catch (err) {
    if (err instanceof UnknownProviderError || err instanceof ProviderSurfaceError) {
      throw new Error(`review: routing.${REVIEW_CLASS}.chain[${i}] — ${err.message}`);
    }
    throw err;
  }
}

/** `routing.review` resolved + validated — the review-capable
 *  providers list. Missing or empty is a config error: a review
 *  stage with no declared reviewer list cannot attribute a verdict. */
function reviewChain(deps: ReviewDeps): ChainEntry[] {
  const row = Object.hasOwn(deps.routing, REVIEW_CLASS) ? deps.routing[REVIEW_CLASS] : undefined;
  if (row === undefined || row.chain.length === 0) {
    throw new Error(
      `review: routing.${REVIEW_CLASS} is missing — declare fleet.routing.${REVIEW_CLASS}.chain ` +
        '(the review-capable providers list)'
    );
  }
  for (const [i, e] of row.chain.entries()) {
    checkEntry(deps, i, e);
  }
  return row.chain;
}

/** The reviewer slot — the first chain entry whose provider is not
 *  walled. Every entry walled means no declared reviewer can answer:
 *  the stage throws (the pending intent is the crash marker; the
 *  bounded re-fire waits the wall out), same fail-loud shape as a
 *  judge unavailability. */
function reviewerOf(chain: ChainEntry[], deps: ReviewDeps): ChainEntry {
  const walled = new Set((deps.walls?.() ?? []).map(w => w.provider));
  const slot = chain.find(e => !walled.has(e.provider));
  if (slot === undefined) {
    throw new Error(
      `review: every routing.${REVIEW_CLASS}.chain entry is walled — ` +
        'no declared reviewer can answer'
    );
  }
  return slot;
}

// --- the decide --------------------------------------------------------------------

const abandonQuestion = (): JudgeQuestion => ({
  type: 'noul',
  instructions:
    'Probability that this work should be abandoned — the diff is wrong-headed, ' +
    'cannot be salvaged by a fix round on the same worktree, or the item should ' +
    'never have been worked.',
});

const pushQuestion = (): JudgeQuestion => ({
  type: 'noul',
  instructions:
    'Probability that this diff is good to push to merge as-is — complete against ' +
    "the item's scope, correct, and carrying nothing a reviewer would block on.",
});

const findingQuestion = (kind: FindingKind): JudgeQuestion => ({
  type: 'noul',
  instructions: `Probability that the diff carries a blocking ${kind} finding — ${FINDING_KINDS[kind]}.`,
});

/** One decide's worth of questions — the abandon noul, one noul per
 *  finding category, and the push affirmation, batched so the
 *  backends evaluate them in parallel. Domain vocabulary only: work
 *  items and diffs, never pipeline mechanics. */
function reviewQuestions(): Record<string, JudgeQuestion> {
  const q: Record<string, JudgeQuestion> = {
    abandon: abandonQuestion(),
    push: pushQuestion(),
  };
  for (const kind of Object.keys(FINDING_KINDS) as FindingKind[]) {
    q[findingQid(kind)] = findingQuestion(kind);
  }
  return q;
}

/** The scoped-fix history the journal shows this run — the highest
 *  fix_round journaled plus the notes it ran under, so a re-review
 *  sees what the last round was asked to mend. Undefined on a first
 *  review. */
function fixHistory(call: StageCall): { round: number; notes?: string } | undefined {
  let round = 0;
  let notes: string | undefined;
  for (const r of journalRecords(
    call.journal.rows().filter(r => r.run_id === call.runId && r.item === call.item)
  )) {
    if (r.fix_round !== undefined && r.fix_round > round) {
      round = r.fix_round;
      notes = typeof r.notes === 'string' ? r.notes : undefined;
    }
  }
  return round === 0 ? undefined : { round, notes };
}

/** The decide-state assembly's inputs — the Checks-pattern bag that
 *  keeps `stateFor` under the arg ceiling. */
interface StateInput {
  item: TaskRow;
  d: ReviewDiff;
  call: StageCall;
  /** the (possibly truncated) diff text the state carries */
  text: string;
  truncated: boolean;
}

/** The judge-visible state — item + the work stage's recorded
 *  context + the (bounded) diff + the scoped-fix history, trimmed to
 *  what a reviewer judges on. */
function stateFor(s: StateInput): Record<string, unknown> {
  const files = (s.d.files ?? []).slice(0, DEFAULT_MAX_DIFF_FILES);
  const history = fixHistory(s.call);
  const d = s.d;
  return {
    item: rowView(s.item),
    ...(isRecord(s.call.ctx.work) ? { work: s.call.ctx.work } : {}),
    diff: {
      text: s.text,
      truncated: s.truncated,
      ...(files.length > 0 ? { files } : {}),
      ...(d.files !== undefined ? { fileCount: d.files.length } : {}),
      ...(d.worktree !== undefined ? { worktree: d.worktree } : {}),
      ...(d.base !== undefined ? { base: d.base } : {}),
      ...(d.head !== undefined ? { head: d.head } : {}),
    },
    ...(history !== undefined ? { fix: history } : {}),
  };
}

// --- the verdict -------------------------------------------------------------------

/** Finding kinds the judge affirmed — confident `finding_*` nouls at
 *  the affirm line, in declared order so notes compose
 *  deterministically. */
function findingsOf(cx: Cx): FindingKind[] {
  return (Object.keys(FINDING_KINDS) as FindingKind[]).filter(k => affirmed(cx.res, findingQid(k)));
}

/** `fix` scope text — the affirmed findings' rubric lines joined into
 *  the instruction a scoped-fix work entry reads. Non-empty whenever
 *  findings exist; the uncategorized path carries its own constant. */
function notesFor(findings: FindingKind[]): string {
  return `address the review findings — ${findings.map(k => `${k}: ${FINDING_KINDS[k]}`).join('; ')}`;
}

/** The connector the answers were decided by — recorded only when
 *  every answer names the same one (a mixed decide has no single
 *  decider to stamp). */
function decidedByOf(res: DecideResult): string | undefined {
  const by = new Set(
    Object.values(res.answers)
      .map(a => a.decidedBy)
      .filter((s): s is string => typeof s === 'string' && s !== '')
  );
  return by.size === 1 ? [...by][0] : undefined;
}

/** The reviewed artifact's provenance — what the seam reported and
 *  whether the judge saw all of it. */
function diffProvenance(d: ReviewDiff, truncated: boolean): NonNullable<ReviewPayload['diff']> {
  return {
    files: d.files?.length ?? 0,
    truncated,
    ...(d.worktree !== undefined ? { worktree: d.worktree } : {}),
    ...(d.base !== undefined ? { base: d.base } : {}),
    ...(d.head !== undefined ? { head: d.head } : {}),
  };
}

/** The payload's constant spine — findings, lowConfidence, the
 *  reviewer slot, and the diff provenance; `verdictOf` adds the
 *  verdict (+ notes) per arm. */
function basePayload(cx: Cx): ReviewPayload {
  const p: ReviewPayload = { verdict: 'push' };
  const findings = findingsOf(cx);
  if (findings.length > 0) {
    p.findings = findings;
  }
  if (cx.res.lowConfidence.length > 0) {
    p.lowConfidence = [...cx.res.lowConfidence];
  }
  p.reviewer =
    cx.reviewer.model === undefined
      ? { provider: cx.reviewer.provider }
      : { provider: cx.reviewer.provider, model: cx.reviewer.model };
  const decidedBy = decidedByOf(cx.res);
  p.judge = decidedBy === undefined ? { model: cx.res.model } : { model: cx.res.model, decidedBy };
  p.diff = diffProvenance(cx.diff, cx.truncated);
  return p;
}

/** Answers → verdict. Precedence is decisive-first: abandon (a
 *  terminal failure) outranks findings (a fix round) outranks an
 *  affirmed push. Push is never the default — a judge that withholds
 *  the push affirmation while categorizing nothing takes one bounded
 *  fix round, because unaffirmed-to-push work must not sail to merge
 *  on a dimmed or denied read. The same posture demotes an affirmed
 *  push on a TRUNCATED window: the tail was never judged, so the push
 *  degrades to fix with the truncation note — unreviewed content
 *  does not merge on a prefix read. */
function verdictOf(cx: Cx): EngineResult {
  const p = basePayload(cx);
  const done = (verdict: ReviewVerdict, notes?: string): EngineResult => {
    p.verdict = verdict;
    if (notes !== undefined) {
      p.notes = notes;
    }
    return { verdict, payload: p };
  };
  const findings = p.findings ?? [];
  if (affirmed(cx.res, 'abandon')) {
    return done('abandon');
  }
  if (findings.length > 0) {
    return done('fix', notesFor(findings));
  }
  if (affirmed(cx.res, 'push')) {
    return cx.truncated
      ? done(
          'fix',
          `the reviewed diff exceeded the ${cx.max} char window — the tail was never judged; ` +
            'narrow the change below the window (split or shrink the diff) so the whole diff is judged'
        )
      : done('push');
  }
  return done('fix', UNCATEGORIZED_FIX_NOTES);
}

/** Gating question ids — the zero-signal check counts confident
 *  answers over exactly these. */
const GATING_QIDS = [
  'abandon',
  'push',
  ...(Object.keys(FINDING_KINDS) as FindingKind[]).map(findingQid),
];

/** The reviewable artifact or a throw — `undefined` from the seam
 *  means the journaled work produced nothing to judge. */
async function artifact(deps: ReviewDeps, call: StageCall): Promise<ReviewDiff> {
  const d = await deps.diff(call);
  if (d === undefined) {
    throw new Error(
      `review: item "${call.item}" has no reviewable artifact — ` +
        'the diff seam produced nothing for the journaled work'
    );
  }
  return d;
}

/** The validated decide-state window — a bound that can't trip is the
 *  same defect class as no bound: NaN disables truncation (n > NaN is
 *  always false) and a negative slice mangles the window, so invalid
 *  input fails loud instead of passing an unbounded diff to the judge. */
function diffWindow(
  diff: string,
  maxDiffChars: number | undefined
): { text: string; truncated: boolean; max: number } {
  const max = maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`review: maxDiffChars must be a non-negative integer, got ${max}`);
  }
  const truncated = diff.length > max;
  return { text: truncated ? diff.slice(0, max) : diff, truncated, max };
}

/** A decide with zero confident gating answers throws — the diff was
 *  never read, and manufacturing a verdict from nothing is worse than
 *  a crash marker + bounded re-fire. */
function requireSignal(cx: Cx): void {
  if (!GATING_QIDS.some(qid => confident(cx.res, qid))) {
    throw new Error('review: judge returned no confident gating answer — the diff was never read');
  }
}

/**
 * The review stage as an EngineHandler for the runner's `judge` slot —
 * one decide over item+work+diff, typed answers interpreted into
 * push/fix/abandon. Missing item, missing `routing.review`, a diff
 * seam returning undefined, an all-walled chain, and a decide that
 * returns zero confident gating answers all THROW: the pending intent
 * is the crash marker, a judge-side intent re-fires inside the
 * attempt budget, and review emits no side effect worth re-checking.
 */
export function reviewStage(deps: ReviewDeps): EngineHandler {
  return {
    async invoke(call: StageCall): Promise<EngineResult> {
      const item = deps.backlog.item(call.item);
      if (item === undefined) {
        throw new Error(`review: item "${call.item}" is not in the backlog`);
      }
      const reviewer = reviewerOf(reviewChain(deps), deps);
      const d = await artifact(deps, call);
      const w = diffWindow(d.diff, deps.maxDiffChars);
      const res = await deps.judge.decide(
        stateFor({ item, d, call, text: w.text, truncated: w.truncated }),
        reviewQuestions()
      );
      const cx: Cx = { res, reviewer, diff: d, truncated: w.truncated, max: w.max };
      requireSignal(cx);
      return verdictOf(cx);
    },
  };
}
