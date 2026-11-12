/**
 * The routing formula — one md file: the frontmatter is the machine
 * contract, the body is the prose the decision model reads.
 *
 * `brouter.formula` (or `--formula`) points at it; the route table
 * stays the table of lanes. Three shapes share the one file format:
 *
 * - `features` — the judge answers the typed `questions` (one call);
 *   the answers become the task's features and the table's `match`
 *   reads them as if the task carried them.
 * - `pick` — today's `routePick`: one `choice` over the candidate
 *   routes. No `questions` — the choice IS the question.
 * - `score` — `P(success | route, features) − λ·cost − μ·latency`
 *   per surviving candidate (score.ts owns the arithmetic).
 *
 * `filters` are code-owned hard rules: `unless` removes the named
 * route when its predicate matches, and an unresolved filter input is
 * never permission to dispatch — the route is excluded, not guessed.
 *
 * Validation lists EVERY problem and throws once — the same contract
 * the route table's own validator keeps.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DecideResult, JudgeQuestion } from '@broject/core';
import type { CandidateSet, RouteTask } from './candidates.ts';
import { RouteProblems, TablePath } from './schema.ts';
import type { FeatureMatch, FeatureValue, RouteTable } from './types.ts';

/** The envelope's kind — formula files say what they are. */
export const FORMULA_KIND = 'formula';

/** The schema version this parser speaks. */
export const FORMULA_VERSION = 1;

/** The three shapes one file format speaks. */
export type FormulaShape = 'features' | 'pick' | 'score';

const SHAPES: readonly FormulaShape[] = ['features', 'pick', 'score'];

/** The outcome predicate the formula declares — .4's read model scores
 *  against it. `merged_first_round` is the default. */
export type SuccessPredicate = 'merged' | 'merged_first_round';

const SUCCESS_PREDICATES: readonly SuccessPredicate[] = ['merged', 'merged_first_round'];

/** One typed question the formula asks the decision model — the
 *  questions map's KEY is the id answers and features land under.
 *  `choice` picks among `options`, `bool` is a calibrated yes/no,
 *  `score` rates on the ordered `levels` (2–10, low to high — the
 *  judge's own bound). */
export type FormulaQuestion = {
  /** per-question rubric — absent means the shape's default text */
  instructions?: string;
} & (
  | { type: 'choice'; options: string[] }
  | { type: 'bool' }
  | { type: 'score'; levels: string[] }
);

/** A hard filter — code-owned, the model cannot override. `unless`
 *  removes the route when EVERY listed question's value sits in its
 *  list; an unanswered question excludes the route instead of waving
 *  it through. */
export interface FormulaFilter {
  /** the route the filter can remove — a table route name */
  route: string;
  /** question id → the values that fire the filter */
  unless: Record<string, FeatureValue[]>;
}

/** The score shape's weights — finite, non-negative. */
export interface FormulaScoreWeights {
  /** cost penalty per USD of mean task cost */
  lambda: number;
  /** latency penalty per second of mean task wall time */
  mu: number;
}

/** The formula — the parsed contract plus the prose body. */
export interface Formula {
  kind: typeof FORMULA_KIND;
  version: number;
  shape: FormulaShape;
  /** the declared questions — empty under `pick` (the choice is the question) */
  questions: Record<string, FormulaQuestion>;
  filters: FormulaFilter[];
  success: SuccessPredicate;
  /** the score weights — present only under `shape: score` */
  score?: FormulaScoreWeights;
  /** the md body — the prose the decision model reads */
  prose: string;
}

/** Every problem the formula carries — thrown once, listed once. */
export class FormulaError extends Error {
  /** every problem, in the order they were found */
  readonly problems: string[];

  constructor(problems: string[], source: string = 'formula') {
    super(`${source}: ${problems.length} problem(s)\n${problems.map(p => `  ${p}`).join('\n')}`);
    this.name = 'FormulaError';
    this.problems = problems;
  }
}

/** One answered question, as the explanation renders it. */
export interface FormulaAnswerTrace {
  /** the question id */
  id: string;
  /** the rendered answer — 'coding', 'true', '2.5', '(unanswered)' */
  value: string;
  /** the probability of the returned value, 0..1 — when the judge gives one */
  probability?: number;
  /** the judge's own confidence */
  confidence?: number;
  /** answered below the confidence bar — recorded, never applied */
  lowConfidence?: boolean;
}

/** A filter that fired — the route it removed and why. */
export interface FormulaFilterTrace {
  route: string;
  reason: string;
}

/** One candidate's score breakdown — the explain slice's row. */
export interface FormulaScoreTrace {
  route: string;
  /** P(success | route, features) — the posterior mean (0.5 at n=0) */
  p: number;
  /** the verified outcome rows behind p */
  n: number;
  /** mean task cost USD — absent = unknown, never zero */
  costUsd?: number;
  /** mean task wall seconds — absent = unknown, never zero */
  wallSec?: number;
  /** the formula score — absent when scoring was skipped outright */
  score?: number;
}

/** What the formula did — the explain slice's source. */
export interface FormulaTrace {
  shape: FormulaShape;
  /** the formula file the contract came from */
  file?: string;
  answers: FormulaAnswerTrace[];
  filtered: FormulaFilterTrace[];
  scores?: FormulaScoreTrace[];
  /** why the formula did not decide — shadow mode, skipped scoring, no judge */
  note?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The top-level keys a formula may carry — anything else is a problem. */
const FORMULA_KEYS = new Set([
  'kind',
  'version',
  'shape',
  'questions',
  'filters',
  'success',
  'score',
]);

/** Reads + parses a formula file — frontmatter contract, prose body. */
export function readFormula(file: string): Formula {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FormulaError([`${file}: cannot read formula — ${msg}`], file);
  }
  return parseFormulaText(text, file);
}

/** Splits the md — the `---` frontmatter block, then the prose body. */
export function parseFormulaText(text: string, source: string = 'formula'): Formula {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (block === null) {
    throw new FormulaError(
      [`${source}: a formula is an md file — a --- frontmatter block, then the prose`],
      source
    );
  }
  let doc: unknown;
  try {
    doc = parseYaml(block[1] ?? '');
  } catch (err) {
    throw new FormulaError(
      [`${source}: invalid frontmatter YAML — ${err instanceof Error ? err.message : String(err)}`],
      source
    );
  }
  return formulaDoc(doc, source, text.slice(block[0].length));
}

/** A scalar feature value — string, finite number, or boolean. */
function scalar(raw: unknown): FeatureValue | undefined {
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  return undefined;
}

/** The version — a positive integer, like the route table's own pin. */
function versionOf(raw: unknown, problems: RouteProblems): number {
  if (raw === undefined) {
    return FORMULA_VERSION;
  }
  const at = TablePath.root().child('version');
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    problems.add(at, 'must be a positive integer');
    return FORMULA_VERSION;
  }
  if (raw > FORMULA_VERSION) {
    problems.add(
      at,
      `formula schema v${raw} is newer than this router understands (latest v${FORMULA_VERSION})`
    );
  }
  return raw;
}

/** The shape — one of the three the file format speaks. */
function shapeOf(raw: unknown, problems: RouteProblems): FormulaShape {
  const at = TablePath.root().child('shape');
  if (typeof raw !== 'string' || !(SHAPES as readonly string[]).includes(raw)) {
    problems.add(at, `must be one of ${SHAPES.join('|')}`);
    return 'features';
  }
  return raw as FormulaShape;
}

/** The success predicate — the outcome label .4's read model scores. */
function successOf(raw: unknown, problems: RouteProblems): SuccessPredicate {
  if (raw === undefined) {
    return 'merged_first_round';
  }
  const at = TablePath.root().child('success');
  if (typeof raw !== 'string' || !(SUCCESS_PREDICATES as readonly string[]).includes(raw)) {
    problems.add(at, `must be one of ${SUCCESS_PREDICATES.join('|')}`);
    return 'merged_first_round';
  }
  return raw as SuccessPredicate;
}

/** A non-empty string field — the option, the level, the instruction. */
function textOf(raw: unknown, at: TablePath, problems: RouteProblems): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') {
    problems.add(at, 'must be a non-empty string');
    return undefined;
  }
  return raw;
}

/** A string list — options or levels. `min`/`max` bound the count;
 *  `unique` is the choice contract (levels may repeat meaningfully). */
function stringList(
  raw: unknown,
  at: TablePath,
  problems: RouteProblems,
  bounds: { min: number; max: number },
  unique: boolean
): string[] | undefined {
  if (!Array.isArray(raw) || raw.length < bounds.min || raw.length > bounds.max) {
    problems.add(at, `must be a list of ${bounds.min}–${bounds.max} entries`);
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const text = textOf(entry, at.index(i), problems);
    if (text === undefined) {
      continue;
    }
    if (unique && seen.has(text)) {
      problems.add(at.index(i), `duplicate option "${text}"`);
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** The keys one question type may carry — anything else is a problem. */
const QUESTION_KEYS: Record<FormulaQuestion['type'], Set<string>> = {
  choice: new Set(['type', 'options', 'instructions']),
  bool: new Set(['type', 'instructions']),
  score: new Set(['type', 'levels', 'instructions']),
};

/** One question — its type decides which fields it may carry. */
function question(
  raw: unknown,
  at: TablePath,
  problems: RouteProblems
): FormulaQuestion | undefined {
  if (!isRecord(raw)) {
    problems.add(at, 'must be a table');
    return undefined;
  }
  const type = raw.type;
  if (type !== 'choice' && type !== 'bool' && type !== 'score') {
    problems.add(at.child('type'), 'must be one of choice|bool|score');
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!QUESTION_KEYS[type].has(key)) {
      problems.add(at.child(key), `unknown key for a ${type} question`);
    }
  }
  const instructions =
    raw.instructions === undefined
      ? undefined
      : textOf(raw.instructions, at.child('instructions'), problems);
  const base = instructions === undefined ? {} : { instructions };
  if (type === 'bool') {
    return { ...base, type };
  }
  if (type === 'choice') {
    const options = stringList(
      raw.options,
      at.child('options'),
      problems,
      { min: 1, max: 64 },
      true
    );
    if (options === undefined) {
      return undefined;
    }
    return { ...base, type, options };
  }
  const levels = stringList(raw.levels, at.child('levels'), problems, { min: 2, max: 10 }, false);
  if (levels === undefined) {
    return undefined;
  }
  return { ...base, type, levels };
}

/** The questions map — question id → its typed contract. */
function questions(
  raw: unknown,
  shape: FormulaShape,
  at: TablePath,
  problems: RouteProblems
): Record<string, FormulaQuestion> {
  const atQuestions = at.child('questions');
  if (raw === undefined) {
    if (shape === 'pick') {
      return {};
    }
    problems.add(atQuestions, `shape "${shape}" must declare at least one question`);
    return {};
  }
  if (!isRecord(raw)) {
    problems.add(atQuestions, 'must be a table');
    return {};
  }
  if (shape === 'pick') {
    problems.add(atQuestions, 'shape "pick" asks one choice over the routes — no questions');
    return {};
  }
  const out: Record<string, FormulaQuestion> = {};
  for (const [id, qraw] of Object.entries(raw)) {
    if (id.trim() === '') {
      problems.add(atQuestions, 'question ids must be non-empty');
      continue;
    }
    const parsed = question(qraw, atQuestions.child(id), problems);
    if (parsed !== undefined) {
      // defineProperty — a "__proto__" question id lands as data
      Object.defineProperty(out, id, {
        value: parsed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

/** One `unless` value list — non-empty scalars. */
function unlessValues(
  raw: unknown,
  at: TablePath,
  problems: RouteProblems
): FeatureValue[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.add(at, 'must be a non-empty list of values');
    return undefined;
  }
  const out: FeatureValue[] = [];
  for (const [i, entry] of raw.entries()) {
    const value = scalar(entry);
    if (value === undefined) {
      problems.add(at.index(i), 'must be a string, number, or boolean');
      return undefined;
    }
    out.push(value);
  }
  return out;
}

/** The filters — hard rules the code evaluates, never the model. */
function filters(raw: unknown, at: TablePath, problems: RouteProblems): FormulaFilter[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.add(at.child('filters'), 'must be a list');
    return [];
  }
  const atFilters = at.child('filters');
  const out: FormulaFilter[] = [];
  for (const [i, fraw] of raw.entries()) {
    const atFilter = atFilters.index(i);
    if (!isRecord(fraw)) {
      problems.add(atFilter, 'must be a table');
      continue;
    }
    for (const key of Object.keys(fraw)) {
      if (key !== 'route' && key !== 'unless') {
        problems.add(atFilter.child(key), 'unknown key');
      }
    }
    const route = textOf(fraw.route, atFilter.child('route'), problems);
    if (route === undefined) {
      continue;
    }
    const unlessRaw = fraw.unless;
    if (!isRecord(unlessRaw) || Object.keys(unlessRaw).length === 0) {
      problems.add(atFilter.child('unless'), 'must name at least one question');
      continue;
    }
    const unless: Record<string, FeatureValue[]> = {};
    let bad = false;
    for (const [qid, values] of Object.entries(unlessRaw)) {
      const parsed = unlessValues(values, atFilter.child('unless').child(qid), problems);
      if (parsed === undefined) {
        bad = true;
        continue;
      }
      Object.defineProperty(unless, qid, {
        value: parsed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (bad) {
      continue;
    }
    out.push({ route, unless });
  }
  return out;
}

/** The score weights — only the score shape accepts them, and only
 *  finite non-negative numbers. */
function scoreWeights(
  raw: unknown,
  shape: FormulaShape,
  at: TablePath,
  problems: RouteProblems
): FormulaScoreWeights | undefined {
  const atScore = at.child('score');
  if (raw === undefined) {
    return shape === 'score' ? { lambda: 0, mu: 0 } : undefined;
  }
  if (shape !== 'score') {
    problems.add(atScore, `only shape "score" accepts score weights`);
    return undefined;
  }
  if (!isRecord(raw)) {
    problems.add(atScore, 'must be a table');
    return undefined;
  }
  const out: FormulaScoreWeights = { lambda: 0, mu: 0 };
  for (const [key, value] of Object.entries(raw)) {
    const atKey = atScore.child(key);
    if (key !== 'lambda' && key !== 'mu') {
      problems.add(atKey, 'unknown key — lambda and mu are the weights');
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.add(atKey, 'must be a finite non-negative number');
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Validates a parsed frontmatter document into a Formula — every
 *  problem collected, thrown once. `prose` is the md body the decision
 *  model reads. */
export function formulaDoc(doc: unknown, source: string = 'formula', prose = ''): Formula {
  const problems = new RouteProblems();
  const at = TablePath.root();
  if (!isRecord(doc)) {
    throw new FormulaError([`${source}: the frontmatter must be a map`], source);
  }
  for (const key of Object.keys(doc)) {
    if (!FORMULA_KEYS.has(key)) {
      problems.add(at.child(key), 'unknown key');
    }
  }
  if (doc.kind !== FORMULA_KIND) {
    problems.add(at.child('kind'), `expected "${FORMULA_KIND}", got ${JSON.stringify(doc.kind)}`);
  }
  const version = versionOf(doc.version, problems);
  const shape = shapeOf(doc.shape, problems);
  const declared = questions(doc.questions, shape, at, problems);
  const parsedFilters = filters(doc.filters, at, problems);
  const success = successOf(doc.success, problems);
  const score = scoreWeights(doc.score, shape, at, problems);

  // a filter's `unless` may only name declared questions — the formula
  // itself owns that contract, no table needed
  const atFilters = at.child('filters');
  for (const [i, filter] of parsedFilters.entries()) {
    for (const qid of Object.keys(filter.unless)) {
      if (!Object.hasOwn(declared, qid)) {
        problems.add(
          atFilters.index(i).child('unless').child(qid),
          `names no question the formula declares`
        );
      }
    }
  }
  // an empty questions map under features/score is a problem of its own
  if (shape !== 'pick' && Object.keys(declared).length === 0) {
    problems.add(at.child('questions'), `shape "${shape}" must declare at least one question`);
  }

  if (!problems.empty) {
    throw new FormulaError(problems.list, source);
  }
  return {
    kind: FORMULA_KIND,
    version,
    shape,
    questions: declared,
    filters: parsedFilters,
    success,
    ...(score === undefined ? {} : { score }),
    prose: prose.trim(),
  };
}

/** The formula's typed questions as the judge's wire shape — one
 *  decide() call answers them all. Choice criteria are the options
 *  (null rubric — the body prose carries it); bool rides the noul
 *  contract; score rides the ordered levels. */
export function formulaQuestions(formula: Formula): Record<string, JudgeQuestion> {
  const out: Record<string, JudgeQuestion> = {};
  for (const [id, q] of Object.entries(formula.questions)) {
    const instructions = q.instructions ?? defaultInstructions(q, id);
    let question: JudgeQuestion;
    if (q.type === 'choice') {
      const criteria: Record<string, null> = {};
      for (const option of q.options) {
        Object.defineProperty(criteria, option, {
          value: null,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      question = { type: 'choice', instructions, criteria };
    } else if (q.type === 'bool') {
      question = { type: 'noul', instructions };
    } else {
      question = { type: 'score', instructions, criteria: [...q.levels] };
    }
    Object.defineProperty(out, id, {
      value: question,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The instructions a question falls back to — the body prose is the
 *  real rubric; this only says what is being asked. */
function defaultInstructions(q: FormulaQuestion, id: string): string {
  if (q.type === 'choice') {
    return `Answer "${id}" for this task — pick the option that fits.`;
  }
  if (q.type === 'bool') {
    return `Answer "${id}" for this task — yes or no.`;
  }
  return `Rate "${id}" for this task — the ordered levels, low to high.`;
}

/** The judge's answer, converted to the feature value the match reads —
 *  undefined when the answer's type does not fit the question (a choice
 *  answer to a bool question is no answer at all). */
function answerToFeature(
  q: FormulaQuestion,
  answer: DecideResult['answers'][string]
): { value: FeatureValue; probability?: number } | undefined {
  if (q.type === 'choice') {
    if (answer.type !== 'choice' || !q.options.includes(answer.choice)) {
      return undefined;
    }
    // hasOwn + typeof — a "__proto__" option must read its own entry,
    // never the prototype, and only a number is a probability
    const p = Object.hasOwn(answer.probabilities, answer.choice)
      ? answer.probabilities[answer.choice]
      : undefined;
    return {
      value: answer.choice,
      ...(typeof p === 'number' ? { probability: p } : {}),
    };
  }
  if (q.type === 'bool') {
    if (answer.type !== 'noul') {
      return undefined;
    }
    const yes = answer.noul >= 0.5;
    return { value: yes, probability: yes ? answer.noul : 1 - answer.noul };
  }
  if (answer.type !== 'score' || !Number.isFinite(answer.score)) {
    return undefined;
  }
  // the wire contract bounds a score answer to the levels' index range —
  // 0 = first, N-1 = last; outside it the answer is no answer at all
  if (answer.score < 0 || answer.score > q.levels.length - 1) {
    return undefined;
  }
  return { value: answer.score };
}

/** The rendered answer — what the explain slice prints. */
function answerText(value: FeatureValue): string {
  return String(value);
}

/** The decide() result, folded into the task's features plus the trace
 *  the explanation prints. A low-confidence answer is RECORDED and
 *  never applied — the same rule the route pick keeps: dimmed answers
 *  are no verdict. */
export function formulaAnswersToFeatures(
  formula: Formula,
  res: DecideResult
): { features: Record<string, FeatureValue>; answers: FormulaAnswerTrace[] } {
  const features: Record<string, FeatureValue> = {};
  const answers: FormulaAnswerTrace[] = [];
  const low = new Set(res.lowConfidence);
  for (const [id, q] of Object.entries(formula.questions)) {
    const answer = Object.hasOwn(res.answers, id) ? res.answers[id] : undefined;
    const entry: FormulaAnswerTrace = { id, value: '(unanswered)' };
    if (answer !== undefined) {
      const converted = answerToFeature(q, answer);
      if (converted === undefined) {
        entry.value = '(unusable answer)';
      } else {
        entry.value = answerText(converted.value);
        if (converted.probability !== undefined) {
          entry.probability = converted.probability;
        }
        entry.confidence = answer.confidence;
        if (low.has(id)) {
          entry.lowConfidence = true;
        } else {
          Object.defineProperty(features, id, {
            value: converted.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
    answers.push(entry);
  }
  return { features, answers };
}

/** The caller's features merged with the formula's answers — a
 *  conflict is a validation failure, never a silent override: two
 *  sources disagreeing about the task's shape is a bug to fix, not a
 *  precedence to pick. */
export function mergeTaskFeatures(
  caller: Record<string, FeatureValue> | undefined,
  inferred: Record<string, FeatureValue>
): Record<string, FeatureValue> {
  const merged: Record<string, FeatureValue> = {};
  for (const [key, value] of Object.entries(caller ?? {})) {
    Object.defineProperty(merged, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const [key, value] of Object.entries(inferred)) {
    if (Object.hasOwn(merged, key)) {
      const held = merged[key];
      if (held !== value) {
        throw new Error(
          `feature conflict — the task carries ${key}=${answerText(held)} but the formula answered ${key}=${answerText(value)}`
        );
      }
      continue;
    }
    Object.defineProperty(merged, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}

/** The task's feature — hasOwn-guarded: a feature literally named
 *  "__proto__" reads as data, never the prototype. */
function taskFeature(task: RouteTask, key: string): FeatureValue | undefined {
  const features = task.features;
  if (features === undefined || !Object.hasOwn(features, key)) {
    return undefined;
  }
  return features[key];
}

/** The filters, evaluated by code over the surviving candidates. A
 *  filter whose `unless` names an unanswered question EXCLUDES its
 *  route — unresolved inputs are never permission to dispatch. The
 *  model cannot add candidates, and health already ran. */
export function applyFormulaFilters(
  set: CandidateSet,
  formula: Formula,
  task: RouteTask
): { set: CandidateSet; fired: FormulaFilterTrace[] } {
  if (formula.filters.length === 0) {
    return { set, fired: [] };
  }
  const fired: FormulaFilterTrace[] = [];
  const removed = new Map<string, string>();
  for (const filter of formula.filters) {
    if (removed.has(filter.route)) {
      continue;
    }
    const unresolved: string[] = [];
    let matches = true;
    let disproved = false;
    const clauses: string[] = [];
    for (const [qid, values] of Object.entries(filter.unless)) {
      const got = taskFeature(task, qid);
      if (got === undefined) {
        unresolved.push(qid);
        continue;
      }
      clauses.push(`${qid}=${answerText(got)}`);
      if (!values.includes(got)) {
        matches = false;
        disproved = true;
      }
    }
    // an unanswered key only pends the route while every RESOLVED clause
    // still matches — one disproved clause means the filter can never
    // fire, so the missing answer is moot (bro-0ykhg.2)
    if (unresolved.length > 0 && !disproved) {
      const reason = `hard filter — ${unresolved.join(', ')} unanswered, the route cannot dispatch`;
      removed.set(filter.route, reason);
      fired.push({ route: filter.route, reason });
      continue;
    }
    if (matches) {
      const reason = `hard filter — unless matched (${clauses.join(', ')})`;
      removed.set(filter.route, reason);
      fired.push({ route: filter.route, reason });
    }
  }
  if (removed.size === 0) {
    return { set, fired };
  }
  const kept = set.candidates.filter(c => !removed.has(c.route.name));
  const rejected = [...set.rejected];
  for (const candidate of set.candidates) {
    const reason = removed.get(candidate.route.name);
    if (reason !== undefined) {
      rejected.push({ route: candidate.route, reason });
    }
  }
  return { set: { candidates: kept, rejected }, fired };
}

/** What a route's hard filters still need — the cascade's T0 reads
 *  this to mark a route pending (bro-0ykhg.2). `needs` names the
 *  question ids whose answers could still change the verdict;
 *  `fired` means a filter already matches every resolved clause, so
 *  the route is out regardless of what the judge says. An unanswered
 *  key only counts as a need while every resolved clause still
 *  matches — one disproved clause makes the filter unfireable. */
export function filterPending(
  formula: Formula,
  routeName: string,
  task: RouteTask
): { needs: string[]; fired: boolean } {
  const needs = new Set<string>();
  for (const filter of formula.filters) {
    if (filter.route !== routeName) {
      continue;
    }
    const unresolved: string[] = [];
    let disproved = false;
    for (const [qid, values] of Object.entries(filter.unless)) {
      const got = taskFeature(task, qid);
      if (got === undefined) {
        unresolved.push(qid);
        continue;
      }
      if (!values.includes(got)) {
        disproved = true;
        break;
      }
    }
    if (disproved) {
      continue;
    }
    if (unresolved.length === 0) {
      return { needs: [...needs], fired: true };
    }
    for (const qid of unresolved) {
      needs.add(qid);
    }
  }
  return { needs: [...needs], fired: false };
}

/** The cross-check — every question the table's `match.features` and
 *  the formula's `filters` name must be declared, with correctly typed
 *  values. Runs where `routes validate` runs it: formula + table
 *  together. */
export function validateFormulaTable(formula: Formula, table: RouteTable, source?: string): void {
  const problems = new RouteProblems();
  const at = TablePath.root();
  const routesByName = new Map(table.routes.map(r => [r.name, r]));

  for (const route of table.routes) {
    const atMatch = at.child('routes').child(route.name).child('match').child('features');
    for (const [qid, want] of Object.entries(route.match.features ?? {})) {
      const atKey = atMatch.child(qid);
      const q = Object.hasOwn(formula.questions, qid) ? formula.questions[qid] : undefined;
      if (q === undefined) {
        problems.add(atKey, `names no question the formula declares`);
        continue;
      }
      checkMatchValues(atKey, qid, q, want, problems);
    }
  }

  const atFilters = at.child('filters');
  for (const [i, filter] of formula.filters.entries()) {
    const atFilter = atFilters.index(i);
    if (!routesByName.has(filter.route)) {
      problems.add(atFilter.child('route'), `names no route "${filter.route}" in the table`);
    }
    for (const [qid, values] of Object.entries(filter.unless)) {
      const q = Object.hasOwn(formula.questions, qid) ? formula.questions[qid] : undefined;
      if (q === undefined) {
        continue; // formulaDoc already reported the undeclared id
      }
      checkFilterValues(atFilter.child('unless').child(qid), qid, q, values, problems);
    }
  }

  if (!problems.empty) {
    throw new FormulaError(problems.list, source ?? 'formula/table');
  }
}

/** The values one match entry pins — scalar or list, normalized. */
function matchValues(want: FeatureMatch): FeatureValue[] {
  return Array.isArray(want) ? want : [want];
}

/** The question type a match value must satisfy — choice wants option
 *  strings, bool wants booleans, and a numeric score question can never
 *  drive a categorical match (no implicit conversion to levels). */
function checkMatchValues(
  at: TablePath,
  qid: string,
  q: FormulaQuestion,
  want: FeatureMatch,
  problems: RouteProblems
): void {
  if (q.type === 'score') {
    problems.add(at, `question "${qid}" is a numeric score — it cannot drive a categorical match`);
    return;
  }
  for (const [i, value] of matchValues(want).entries()) {
    const atValue = Array.isArray(want) ? at.index(i) : at;
    if (q.type === 'bool') {
      if (typeof value !== 'boolean') {
        problems.add(atValue, `question "${qid}" is a bool — the value must be true or false`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      problems.add(atValue, `question "${qid}" is a choice — the value must be an option string`);
      continue;
    }
    if (!q.options.includes(value)) {
      problems.add(
        atValue,
        `"${value}" is not one of question "${qid}"'s options (${q.options.join(', ')})`
      );
    }
  }
}

/** The values one filter's `unless` lists — same typing contract as a
 *  match, except a score question takes finite numbers inside the
 *  levels' index range (0..N-1 — the wire contract for score answers). */
function checkFilterValues(
  at: TablePath,
  qid: string,
  q: FormulaQuestion,
  values: FeatureValue[],
  problems: RouteProblems
): void {
  for (const [i, value] of values.entries()) {
    const atValue = at.index(i);
    if (q.type === 'score') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.add(atValue, `question "${qid}" is a score — the value must be a finite number`);
        continue;
      }
      // a score answer lives in the levels' index range — a filter value
      // outside it can never match, so it is dead config, not a rule
      if (value < 0 || value > q.levels.length - 1) {
        problems.add(
          atValue,
          `question "${qid}" is a score — the value must sit in 0..${q.levels.length - 1}`
        );
      }
      continue;
    }
    if (q.type === 'bool') {
      if (typeof value !== 'boolean') {
        problems.add(atValue, `question "${qid}" is a bool — the value must be true or false`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      problems.add(atValue, `question "${qid}" is a choice — the value must be an option string`);
      continue;
    }
    if (!q.options.includes(value)) {
      problems.add(
        atValue,
        `"${value}" is not one of question "${qid}"'s options (${q.options.join(', ')})`
      );
    }
  }
}
