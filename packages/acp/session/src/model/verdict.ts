/** Verdict classification — the judge-response shape table (spec
 *  bro-q2edc, Phase 3 addendum 4). Bro CONSTRUCTS judge prompts
 *  (`TYPED_PREAMBLE` in providers' acp.ts), so a turn whose prompt
 *  row carries the preamble marker is a judge turn; its agent reply
 *  is small structured JSON — a `{answers:{<qid>:<answer>}}` map or
 *  a bare `{<qid>:<answer>}` map where each entry matches a typed
 *  shape (noul/choice/score — provider-judge's wire contract).
 *  Data-driven: adding a caller is a table row, not a special case. */

import { JUDGE_PROMPT_MARK } from '../wire/index.ts';

export interface VerdictView {
  /** Short badge label — the caller's name (model when the reply
   *  carries it, else the render site supplies provider/`by`). */
  badge: string;
  /** The reply's `model` field when it names one — the generic
   *  model-call label (addendum 11: provider/model, not brands). */
  model?: string;
  /** One-line summary for the collapsed row: `route: a · noul 0.87`. */
  summary: string;
  /** The expanded fields table — `[question, rendered answer]`. */
  fields: [string, string][];
}

/** The prompt-side marker — acp.ts's TYPED_PREAMBLE first line.
 *  Lives in acp-session's wire module; providers builds the preamble
 *  from it and this side detects it — re-exported for local callers. */
export { JUDGE_PROMPT_MARK };

/** A prompt row marks its turn judge-labelled: the typed preamble
 *  in the body (journaled prompt rows — the reliable signal) or a
 *  judge/jev label in `by` (the fallback heuristic). */
export const isJudgeTurn = (text: string | undefined, by: string | undefined): boolean =>
  (text?.includes(JUDGE_PROMPT_MARK) ?? false) ||
  (by !== undefined && /\bjudge\b|\bjev\b/i.test(by));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** One shape-table entry: answer object → its one-line rendering. */
const SHAPES: Record<string, (a: Record<string, unknown>) => string | undefined> = {
  noul: a => (isNum(a.noul) ? `noul ${a.noul.toFixed(2)}` : undefined),
  choice: a => {
    if (typeof a.choice !== 'string' || a.choice === '') return undefined;
    const probs =
      typeof a.probabilities === 'object' && a.probabilities !== null
        ? ` (${Object.entries(a.probabilities as Record<string, unknown>)
            .filter(([, p]) => isNum(p))
            .map(([k, p]) => `${k}:${(p as number).toFixed(2)}`)
            .join(' ')})`
        : '';
    return `choice: ${a.choice}${probs === ' ()' ? '' : probs}`;
  },
  score: a => (isNum(a.score) ? `score: ${a.score.toFixed(2)}` : undefined),
};

const answerLine = (a: unknown): string | undefined => {
  if (!isRecord(a)) return undefined;
  // a named type binds to its shape; a type-less (or mistyped) answer still renders
  // when a single shape key is present
  const named =
    typeof a.type === 'string' ? Object.getOwnPropertyDescriptor(SHAPES, a.type)?.value : undefined;
  const candidates = named !== undefined ? [named] : Object.values(SHAPES);
  for (const fn of candidates) {
    const line = fn(a);
    if (line !== undefined) return line;
  }
  return undefined;
};

/** Cheap shape gate before JSON.parse: non-empty, bounded, object-looking. */
const isCandidateJson = (t: string): boolean =>
  t.length > 0 && t.length <= 4096 && t.startsWith('{');

const parseJsonRecord = (t: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(t);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Keys allowed beside `answers` in the typed-call wrapper. */
const WRAPPER_KEYS: ReadonlySet<string> = new Set(['answers', 'model', '_meta']);

// the typed call wraps answers: {answers:{…}} — unwrap it
const unwrapAnswers = (map: Record<string, unknown>): Record<string, unknown> =>
  isRecord(map.answers) && Object.keys(map).every(k => WRAPPER_KEYS.has(k)) ? map.answers : map;

/** Every entry must render through a shape, and at most 8 of them — more means the body
 *  is a plain JSON payload, not a verdict (the ▸ JSON row takes it). */
const fieldsOf = (map: Record<string, unknown>): [string, string][] | undefined => {
  const fields: [string, string][] = [];
  for (const [qid, a] of Object.entries(map)) {
    const line = answerLine(a);
    if (line === undefined) return undefined;
    fields.push([qid, line]);
    if (fields.length > 8) return undefined;
  }
  return fields.length === 0 ? undefined : fields;
};

/** Agent text → a verdict control, or undefined (falls back to the
 *  plain message/`▸ JSON` row). Only short structured bodies classify
 *  — a prose reply on a judge turn stays a message. */
export function verdictOf(text: string): VerdictView | undefined {
  const t = text.trim();
  if (!isCandidateJson(t)) return undefined;
  const parsed = parseJsonRecord(t);
  if (parsed === undefined) return undefined;
  // the reply may name its model — the generic call label
  const model = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined;
  const fields = fieldsOf(unwrapAnswers(parsed));
  if (fields === undefined) return undefined;
  return {
    badge: model ?? 'verdict',
    ...(model !== undefined ? { model } : {}),
    summary: fields.map(([q, f]) => `${q} ${f}`).join(' · '),
    fields,
  };
}
