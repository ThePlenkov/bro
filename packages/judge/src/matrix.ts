/**
 * The fleet matrix router (spec: specs/bro-v0pvd.1.md) — ONE
 * `judge.decide()` carrying TWO typed questions over the task's
 * state: `complexity` (a score over the matrix's ordered scale →
 * probability per level) and `mode` (a choice over the declared work
 * modes). The answers feed `matrixVerdict` — deterministic code in
 * @broject/core that owns eligibility: the matrix's declared
 * capabilities are the hard filter, so a low-ceiling model lane is
 * unreachable at high complexity even when the judge is wrong. The
 * judge answers questions; the router is code.
 *
 * Same contract as routeClass/routePick: `shadow` journals the
 * verdict and picks nothing, `enforce` returns the pick for the
 * caller to honor, `off` never calls the judge, and
 * JudgeUnavailable propagates — "no verdict" is the caller's warn-
 * and-stand, never a gate input. The verdict always journals so stats
 * can score the router's picks against what actually spawned.
 */
import type { FleetMatrix, JudgeFacade, JudgeQuestion, Verdict } from '@broject/core';
import { matrixVerdict } from '@broject/core';
import { appendRow } from './journal.ts';

/** Journal kind — discriminates matrix verdicts from 'route-class'/
 *  'route-pick' rows. */
export const MATRIX_KIND = 'route-matrix';

const COMPLEXITY_QID = 'complexity';
const MODE_QID = 'mode';

/** Seed rubric blurbs for the default vocabulary — an operator-declared
 *  scale name falls back to itself as the criterion text (the name IS
 *  the description for custom vocab). Per-level rubric text in config
 *  is a follow-up; these only enrich the shipped defaults. */
const COMPLEXITY_BLURB: Record<string, string> = {
  low: 'trivial or mechanical — a correct change is near-obvious',
  medium: 'moderate — some judgment calls, bounded blast radius',
  high: 'hard — cross-cutting, subtle, or real risk of landing wrong',
};

const MODE_BLURB: Record<string, string> = {
  planning: 'design or planning work — decisions and specs, no code changes',
  coding: 'write or change code — implementation work',
  review: 'read and assess — findings and verdicts, no edits',
  fix: 'repair a defect, failure, or review finding',
};

/** Blurb lookup that can't be fooled by inherited keys — a mode or
 *  level literally named '__proto__'/'constructor' must fall back to
 *  its own name, never resolve Object.prototype as its criterion. */
const blurb = (table: Record<string, string>, name: string): string => {
  const v = Object.hasOwn(table, name) ? table[name] : undefined;
  return v ?? name;
};

/** The router's two questions in ONE decide() — `complexity` scores
 *  on the matrix's ordered scale (criteria carry the level order),
 *  `mode` picks among the declared work modes. defineProperty per
 *  key — a '__proto__' mode/level lands as an own key, same guard as
 *  the fleet router's build. */
export function matrixQuestions(matrix: FleetMatrix): Record<string, JudgeQuestion> {
  const modeCriteria: Record<string, string> = {};
  for (const mode of matrix.modes) {
    Object.defineProperty(modeCriteria, mode, {
      value: blurb(MODE_BLURB, mode),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return {
    [COMPLEXITY_QID]: {
      type: 'score',
      instructions:
        'Rate the complexity of landing this task correctly. ' +
        `Level 0 ("${matrix.complexity[0]}") is the easiest work, level ` +
        `${matrix.complexity.length - 1} ("${matrix.complexity[matrix.complexity.length - 1]}") ` +
        'the hardest — pick the level the task truly needs, not the level you wish it had.',
      criteria: matrix.complexity.map(level => blurb(COMPLEXITY_BLURB, level)),
    },
    [MODE_QID]: {
      type: 'choice',
      instructions: 'Which mode of work does this task primarily need? Pick the single best fit.',
      criteria: modeCriteria,
    },
  };
}

/** The journal outcome string — the picked lane's name on a pick,
 *  the verdict kind otherwise ('no-fit' | 'unanswered'). The judged
 *  coordinates live in the answers; the outcome names what the
 *  router WOULD have spawned (shadow) or did (enforce). */
function outcomeOf(verdict: ReturnType<typeof matrixVerdict>): string {
  return verdict.kind === 'pick' ? verdict.model : verdict.kind;
}

/** One routing decision — decide over the task's state, reduce the
 *  answers through the deterministic matrix, journal the verdict.
 *  Returns the pick only under `enforce` (the caller resolves its
 *  profile/provider binding into a spawn lane — the follow-up bead);
 *  `shadow` returns undefined, `off` returns undefined WITHOUT a judge
 *  call. JudgeUnavailable propagates to the caller. */
export async function routeMatrix(opts: {
  /** Working dir — the journal anchors to its git common dir. */
  dir: string;
  /** The chained judge over `fleet.matrix.provider` — the caller binds
   *  it (provider surface + grade checks live there). */
  judge: JudgeFacade;
  /** The task's judge-visible state — molStep + title/description. */
  state: unknown;
  /** Subject identity — the journal's dedup key (the molStep). */
  subject: string;
  /** The parsed capability matrix — scales, modes, model rows. */
  matrix: FleetMatrix;
  mode: 'shadow' | 'enforce' | 'off';
}): Promise<ReturnType<typeof matrixVerdict> | undefined> {
  if (opts.mode === 'off') {
    return undefined;
  }
  const questions = matrixQuestions(opts.matrix);
  const res = await opts.judge.decide(opts.state, questions);
  const verdict = matrixVerdict(opts.matrix, res);
  const cost = res.usage?.costUsd;
  const row: Verdict = {
    ts: new Date().toISOString(),
    kind: MATRIX_KIND,
    subject: { threadId: opts.subject },
    questions,
    answers: res.answers,
    model: res.model,
    latencyMs: res.latencyMs,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(res.lowConfidence.length > 0 ? { lowConfidence: res.lowConfidence } : {}),
    outcome: outcomeOf(verdict),
  };
  appendRow(opts.dir, row);
  if (opts.mode === 'enforce') {
    return verdict.kind === 'pick' ? verdict : undefined;
  }
  return undefined;
}
