/** Verdict classification — the judge-response shape table (spec
 *  bro-q2edc, Phase 3 addendum 4). Bro CONSTRUCTS judge prompts
 *  (`TYPED_PREAMBLE` in providers' acp.ts), so a turn whose prompt
 *  row carries the preamble marker is a judge turn; its agent reply
 *  is small structured JSON — a `{answers:{<qid>:<answer>}}` map or
 *  a bare `{<qid>:<answer>}` map where each entry matches a typed
 *  shape (noul/choice/score — provider-judge's wire contract).
 *  Data-driven: adding a caller is a table row, not a special case. */

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

/** The prompt-side marker — acp.ts's TYPED_PREAMBLE first line. */
export const JUDGE_PROMPT_MARK = 'System One decision endpoint';

/** A prompt row marks its turn judge-labelled: the typed preamble
 *  in the body (journaled prompt rows — the reliable signal) or a
 *  judge/jev label in `by` (the fallback heuristic). */
export const isJudgeTurn = (text: string | undefined, by: string | undefined): boolean =>
  (text?.includes(JUDGE_PROMPT_MARK) ?? false) ||
  (by !== undefined && /\bjudge\b|\bjev\b/i.test(by));

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
  if (typeof a !== 'object' || a === null) return undefined;
  const r = a as Record<string, unknown>;
  const fn = typeof r.type === 'string' ? SHAPES[r.type] : undefined;
  if (fn !== undefined) return fn(r);
  // type-less answers still render when a single shape key is present
  for (const key of Object.keys(SHAPES)) {
    const line = SHAPES[key]?.(r);
    if (line !== undefined) return line;
  }
  return undefined;
};

/** Agent text → a verdict control, or undefined (falls back to the
 *  plain message/`▸ JSON` row). Only short structured bodies classify
 *  — a prose reply on a judge turn stays a message. */
export function verdictOf(text: string): VerdictView | undefined {
  const t = text.trim();
  if (t.length === 0 || t.length > 4096 || !t.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  let map = parsed as Record<string, unknown>;
  // the reply may name its model — the generic call label
  const model = typeof map.model === 'string' && map.model !== '' ? map.model : undefined;
  // the typed call wraps answers: {answers:{…}} — unwrap it
  if (
    typeof map.answers === 'object' &&
    map.answers !== null &&
    Object.keys(map).every(k => k === 'answers' || k === 'model' || k === '_meta')
  ) {
    map = map.answers as Record<string, unknown>;
  }
  const fields: [string, string][] = [];
  for (const [qid, a] of Object.entries(map)) {
    const line = answerLine(a);
    if (line === undefined) return undefined;
    fields.push([qid, line]);
    if (fields.length > 8) return undefined; // too big — the ▸ JSON row
  }
  if (fields.length === 0) return undefined;
  return {
    badge: model ?? 'verdict',
    ...(model !== undefined ? { model } : {}),
    summary: fields.map(([q, f]) => `${q} ${f}`).join(' · '),
    fields,
  };
}
