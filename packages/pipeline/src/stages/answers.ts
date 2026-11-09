/**
 * Typed readers over a `DecideResult` — the judge-driven stages
 * (classify, route) interpret the same answer map with the same
 * contract: a question left under-confidence is UNREAD (dim intake
 * signals never gate), and each reader narrows the answer to its own
 * kind before it counts. One home keeps the stages' confidence
 * semantics identical — a drift in one stage's read would be a silent
 * policy change on the same decide.
 */
import type { DecideResult, JudgeAnswer } from '@broject/core';

/** noul ≥ this means the judge affirms the yes/no question. */
export const AFFIRM = 0.5;

/** An answer the chain left under-confidence is unread — dim intake
 *  signals never gate. */
export const confident = (res: DecideResult, qid: string): boolean =>
  Object.hasOwn(res.answers, qid) && !res.lowConfidence.includes(qid);

export const answer = (res: DecideResult, qid: string): JudgeAnswer | undefined =>
  Object.hasOwn(res.answers, qid) ? res.answers[qid] : undefined;

export const choiceOf = (res: DecideResult, qid: string): string | undefined => {
  const a = answer(res, qid);
  return a?.type === 'choice' ? a.choice : undefined;
};

export const noulOf = (res: DecideResult, qid: string): number | undefined => {
  const a = answer(res, qid);
  return a?.type === 'noul' ? a.noul : undefined;
};

export const scoreOf = (res: DecideResult, qid: string): number | undefined => {
  const a = answer(res, qid);
  return a?.type === 'score' ? a.score : undefined;
};

/** The affirmed arm — a confident noul at/above the affirm line. */
export const affirmed = (res: DecideResult, qid: string): boolean =>
  confident(res, qid) && (noulOf(res, qid) ?? 0) >= AFFIRM;
