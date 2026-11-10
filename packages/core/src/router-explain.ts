/**
 * The explain contract — the vocabulary the router's surfaces use to say
 * WHY a request went where it went.
 *
 * The router decides (route → chain → provider + model) and the decision
 * is silent: `brouter ask` picks a lane without saying by which rule, the
 * spawn path drops the reasons the resolver computed, and the cost of a
 * turn lives nowhere. This module is the shared shape of the answer.
 *
 * SLICES, not levels. The user asks QUESTIONS — which route, which model,
 * what did it cost — so the vocabulary names the questions. A level flag
 * (-v, -vv) says "more"; a slice says "which".
 *
 * A fact without a `because` is not an explanation: the reason is required
 * by the type, so no surface can print a bare value and call it a why.
 *
 * Pure module — no IO, no dependencies. The collectors that PRODUCE facts
 * live with the surfaces that own the data (the router's CLI); the shape
 * they speak lives here, beside the health contract.
 */
import { flagZone } from './cli-args.ts';

/** The slices — the four questions an explanation can answer. */
export const EXPLAIN_SLICES = ['route', 'model', 'health', 'cost'] as const;

/** One slice of the explanation. */
export type ExplainSlice = (typeof EXPLAIN_SLICES)[number];

/** One explained fact — an answer, and the reason it holds. */
export interface ExplainFact {
  /** the question this fact answers ("agent", "model", "context") */
  label: string;
  /** the answer */
  value: string;
  /** why the answer holds — required: a fact without a reason is not an
   *  explanation */
  because: string;
  /** where the fact came from ("the table", "the ledger", "the agent") */
  source?: string;
}

/** The explanation — the facts, grouped by slice. A slice with no facts is
 *  absent, never empty: "nothing to say" and "said nothing" are the same
 *  thing here. */
export interface Explanation {
  slices: Partial<Record<ExplainSlice, ExplainFact[]>>;
}

/** An unknown fact — the value says so, and the reason says why nobody
 *  knows. A zero would be a lie the operator bills against. */
export function unknownFact(input: {
  label: string;
  because: string;
  source?: string;
}): ExplainFact {
  return {
    label: input.label,
    value: 'unknown',
    because: input.because,
    ...(input.source === undefined ? {} : { source: input.source }),
  };
}

/** The slice names — for an error that says what IS known. */
export function sliceNames(): string {
  return EXPLAIN_SLICES.join(', ');
}

/** The slices a flag asks for. `all` is every slice; a comma list is the
 *  subset, in the order the flag spells it; an unknown slice is an error
 *  naming the known ones. */
export function parseExplainSlices(spec: string): ExplainSlice[] {
  const wanted = spec
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s !== '');
  if (wanted.length === 0) {
    return [...EXPLAIN_SLICES];
  }
  if (wanted.includes('all')) {
    return [...EXPLAIN_SLICES];
  }
  const out: ExplainSlice[] = [];
  for (const name of wanted) {
    const slice = EXPLAIN_SLICES.find(s => s === name);
    if (slice === undefined) {
      throw new Error(`unknown explain slice "${name}" — known: ${sliceNames()}`);
    }
    if (!out.includes(slice)) {
      out.push(slice);
    }
  }
  return out;
}

/** The flag's answer — whether an explanation was asked for, and which
 *  slices. `--explain` is the whole story; `--explain=route,model` is a
 *  subset. The subset rides the `=` spelling so a bare `--explain` never
 *  swallows the next positional (the task text, the question).
 *
 *  Only the FLAGS' zone is read: everything after `--` is the task's
 *  own text, and a task that happens to say `--explain` asks for
 *  nothing. */
export function explainFlag(argv: string[]): { enabled: boolean; slices: ExplainSlice[] } {
  const flags = flagZone(argv);
  const subset = flags.find(a => a.startsWith('--explain='));
  if (subset !== undefined) {
    return { enabled: true, slices: parseExplainSlices(subset.slice('--explain='.length)) };
  }
  if (flags.includes('--explain')) {
    return { enabled: true, slices: [...EXPLAIN_SLICES] };
  }
  return { enabled: false, slices: [] };
}

/** The flag's slices — or the error, printed and fatal. A mistyped slice
 *  is a usage error, not a failed run: exit 2, the same as any other bad
 *  flag. */
export function explainSlicesOrExit(argv: string[]): ExplainSlice[] | undefined {
  try {
    const asked = explainFlag(argv);
    return asked.enabled ? asked.slices : undefined;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

/** The facts of one slice — empty when the slice says nothing. The
 *  slice's own entry is found by matching the key: the key set is
 *  closed, and a read that matches never indexes with a variable. */
export function sliceFacts(explanation: Explanation, slice: ExplainSlice): ExplainFact[] {
  for (const [key, facts] of Object.entries(explanation.slices)) {
    if (key === slice) return facts ?? [];
  }
  return [];
}

/** Put a slice's facts into an explanation — the collectors build one
 *  slice at a time and hand it over. The slice's own entry is written as
 *  a literal key: the key set is closed, and a write that names its key
 *  never reaches into a shape it did not choose. */
export function withSlice(
  explanation: Explanation,
  slice: ExplainSlice,
  facts: ExplainFact[]
): Explanation {
  if (facts.length === 0) {
    return explanation;
  }
  switch (slice) {
    case 'route':
      return { slices: { ...explanation.slices, route: facts } };
    case 'model':
      return { slices: { ...explanation.slices, model: facts } };
    case 'health':
      return { slices: { ...explanation.slices, health: facts } };
    case 'cost':
      return { slices: { ...explanation.slices, cost: facts } };
  }
}

/** One fact, rendered — the value, the reason, and where it came from. */
function renderFact(fact: ExplainFact): string {
  const source = fact.source === undefined ? '' : ` (${fact.source})`;
  return `  ${fact.label}: ${fact.value} — ${fact.because}${source}`;
}

/** The explanation, rendered — a header per slice, a line per fact. */
export function renderExplanation(explanation: Explanation, slices: ExplainSlice[]): string {
  const lines: string[] = [];
  for (const slice of slices) {
    const facts = sliceFacts(explanation, slice);
    if (facts.length === 0) {
      continue;
    }
    lines.push(slice);
    for (const fact of facts) {
      lines.push(renderFact(fact));
    }
  }
  return lines.join('\n');
}
