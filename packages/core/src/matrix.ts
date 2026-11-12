/**
 * Fleet matrix — judge-scored complexity+mode → model capability
 * lanes → deterministic pick (spec: specs/bro-v0pvd.1.md). The judge
 * answers two typed questions (a complexity score over an ordered
 * scale, a mode choice); THIS module is the hard filter that turns
 * those answers into a lane: eligibility is computed from declared
 * capabilities in code, never from anything the judge says about a
 * model — a low-ceiling row is unreachable at high complexity even
 * when the judge is wrong.
 *
 * v1 is shadow-only on the spawn path: the pick journals beside the
 * spawn, it never acts. `enforce` exists in the vocabulary for the
 * follow-up bead; the spawn seam refuses it loudly until then.
 */
import type { DecideResult } from './judge.ts';

/** Ordered complexity scale fallback — low→high, 2–10 entries (the
 *  score question's level count bound). A declared `fleet.matrix.
 *  complexity` replaces this wholesale: it IS the vocabulary the
 *  judge scores on and the names each row's `complexity` set uses. */
export const DEFAULT_MATRIX_COMPLEXITY = ['low', 'medium', 'high'] as const;

/** Declared work modes fallback — the bead's four. Same replace-not-
 *  merge rule as the complexity scale. */
export const DEFAULT_MATRIX_MODES = ['planning', 'coding', 'review', 'fix'] as const;

/** One `fleet.matrix.models.<name>` row — capability declarations
 *  (`modes`, `complexity`) kept strictly separate from spawn mechanics
 *  (`profile`, `provider`). Absent capability fields mean "every
 *  declared mode/level" — the operator narrows lanes explicitly. An
 *  explicitly EMPTY array is NOT "all": it fails validation and drops
 *  the whole row (fail closed — a capability claim must name real
 *  vocabulary); omit the field to mean unrestricted. */
export interface FleetMatrixModel {
  /** Subset of the resolved `modes` vocab this lane takes; absent = all. */
  modes?: string[];
  /** Subset of the resolved `complexity` scale names this lane serves;
   *  absent = all levels. THE hard filter — a row naming only 'low'
   *  can never be picked at 'high' no matter what the judge said. */
  complexity?: string[];
  /** `fleet.profiles.<name>` preset — the spawn binding ("candidate
   *  exists → spawn via fleet profile"). */
  profile?: string;
  /** `providers.<name>` entry — the direct spawn binding for lanes
   *  that need no preset (providers entries ARE the agents). */
  provider?: string;
}

/** `fleet.matrix` — the routing section. `provider` names the judge
 *  call surface (absent = the matrix is off); `mode` is the same
 *  shadow|enforce|off contract `fleet.router` keeps, defaulting to
 *  the only safe value. */
export interface FleetMatrix {
  provider?: string;
  mode: 'shadow' | 'enforce' | 'off';
  /** Ordered complexity scale, low→high. */
  complexity: string[];
  /** Declared work modes — the choice question's option set. */
  modes: string[];
  /** Capability lanes, keyed by opaque lane name. */
  models: Record<string, FleetMatrixModel>;
}

/** The deterministic verdict — what the journal records and (under
 *  enforce, future) what the spawn honors. `pick` carries the winning
 *  row's spawn bindings; `no-fit` is a judged task nothing can take;
 *  `unanswered` is a judge that produced no confident verdict. */
export type MatrixVerdict =
  | {
      kind: 'pick';
      model: string;
      mode: string;
      complexity: string;
      profile?: string;
      provider?: string;
    }
  | { kind: 'no-fit'; mode: string; complexity: string }
  | { kind: 'unanswered' };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Plain-object guard — the section/row shape check every config bag
 *  shares (arrays and null are not bags). */
function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object') {
    return false;
  }
  if (v === null) {
    return false;
  }
  return !Array.isArray(v);
}

/** Row names that must never become own keys — the fleetProfiles
 *  guard, checked before defineProperty so the write itself stays
 *  honest for any future key. */
const RESERVED_MODEL_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A declared vocabulary list — array of `min`–`max` (complexity) or
 *  ≥`min` (modes) unique non-empty strings. Returns undefined on any
 *  defect; the caller falls back to the default scale. */
function vocabList(raw: unknown, min: number, max: number): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  if (raw.length < min) {
    return undefined;
  }
  if (raw.length > max) {
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const s = str(v);
    if (s === undefined) {
      return undefined;
    }
    if (seen.has(s)) {
      return undefined;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** A declared vocabulary or the fallback scale — a present-but-invalid
 *  declaration warns and falls back WHOLESALE (replace, never merge:
 *  the declared scale IS the vocabulary the judge scores on). */
function matrixVocab(
  raw: unknown,
  fallback: readonly string[],
  min: number,
  max: number,
  problem: string
): string[] {
  const declared = vocabList(raw, min, max);
  if (raw !== undefined && declared === undefined) {
    console.error(`bro.config: ${problem}`);
  }
  return declared ?? [...fallback];
}

/** `fleet.matrix.mode` — the shadow|enforce|off vocabulary; absent or
 *  anything else is not a mode (the caller keeps the shadow default). */
function matrixMode(raw: unknown): FleetMatrix['mode'] | undefined {
  switch (raw) {
    case 'shadow':
    case 'enforce':
    case 'off':
      return raw;
    default:
      return undefined;
  }
}

/** The section's scalar fields — `provider` names the judge call
 *  surface (absent = the matrix is off); `mode` defaults to shadow,
 *  a bad value dropping back to it with a warning (the fleetProfiles
 *  field-level convention). */
function matrixScalars(o: Record<string, unknown>): {
  mode: FleetMatrix['mode'];
  provider?: string;
} {
  const out: { mode: FleetMatrix['mode']; provider?: string } = { mode: 'shadow' };
  const provider = str(o.provider);
  if (provider !== undefined) {
    out.provider = provider;
  }
  const mode = matrixMode(o.mode);
  if (mode !== undefined) {
    out.mode = mode;
  } else if (o.mode !== undefined) {
    console.error(
      'bro.config: fleet.matrix.mode must be one of shadow|enforce|off — field dropped'
    );
  }
  return out;
}

/** One capability field's usable entries — every item a trimmed
 *  non-empty string, unique, and named by the resolved vocab; an
 *  empty result is as unusable as a bad one (fail closed). Undefined
 *  on any defect — the caller owns the row-drop warning. */
function usableSubset(raw: unknown[], vocab: string[]): string[] | undefined {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = str(item);
    if (s === undefined) {
      return undefined;
    }
    if (seen.has(s)) {
      return undefined;
    }
    if (!vocab.includes(s)) {
      return undefined;
    }
    seen.add(s);
    picked.push(s);
  }
  if (picked.length === 0) {
    return undefined;
  }
  return picked;
}

/** One `modes`/`complexity` declaration on a model row — undefined
 *  when the field is absent (the lane serves the whole declared
 *  vocab), null when the declaration is unusable: the caller drops
 *  the WHOLE row (fail closed — an unverifiable ceiling must never
 *  widen a lane to everything). */
function capabilitySubset(
  key: string,
  field: 'modes' | 'complexity',
  raw: unknown,
  vocab: string[]
): string[] | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const what = field === 'modes' ? 'modes' : 'complexity levels';
  if (!Array.isArray(raw)) {
    console.error(`bro.config: ${key}.${field} must be an array of declared ${what} — row dropped`);
    return null;
  }
  const picked = usableSubset(raw, vocab);
  if (picked === undefined) {
    console.error(
      `bro.config: ${key}.${field} names undeclared or duplicate ${what} — row dropped`
    );
    return null;
  }
  return picked;
}

/** A row's capability pair — null when either field failed (the row
 *  drops); absent fields stay absent (unrestricted on that axis). */
function capabilityFields(
  key: string,
  o: Record<string, unknown>,
  modes: string[],
  complexity: string[]
): Pick<FleetMatrixModel, 'modes' | 'complexity'> | null {
  const out: Pick<FleetMatrixModel, 'modes' | 'complexity'> = {};
  for (const [field, vocab] of [
    ['modes', modes],
    ['complexity', complexity],
  ] as const) {
    const subset = capabilitySubset(key, field, o[field], vocab);
    if (subset === null) {
      return null;
    }
    if (subset !== undefined) {
      out[field] = subset;
    }
  }
  return out;
}

/** One scalar binding field (`profile`/`provider`) — absent stays
 *  absent; a non-string drops the FIELD (not the row), the
 *  fleetProfiles convention. */
function scalarField(key: string, field: 'profile' | 'provider', raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const s = str(raw);
  if (s === undefined) {
    console.error(`bro.config: ${key}.${field} must be a non-empty string — field dropped`);
    return undefined;
  }
  return s;
}

/** One model row's capability fields — `modes`/`complexity` must name
 *  ONLY declared vocabulary or the whole row drops (fail closed: an
 *  unverifiable ceiling must never widen a lane to everything). Scalar
 *  fields drop alone, the fleetProfiles convention. Returns null when
 *  the row itself is unusable. */
function matrixModel(
  name: string,
  v: unknown,
  modes: string[],
  complexity: string[]
): FleetMatrixModel | null {
  const key = `fleet.matrix.models.${name}`;
  if (!isRecord(v)) {
    console.error(`bro.config: ${key} must be an object — row dropped`);
    return null;
  }
  const caps = capabilityFields(key, v, modes, complexity);
  if (caps === null) {
    return null;
  }
  const row: FleetMatrixModel = { ...caps };
  for (const f of ['profile', 'provider'] as const) {
    const s = scalarField(key, f, v[f]);
    if (s !== undefined) {
      row[f] = s;
    }
  }
  return row;
}

/** `fleet.matrix.models` — proto-named rows never land; non-object
 *  rows drop; each surviving row writes via defineProperty (a lane
 *  literally named '__proto__' is already skipped above, but the same
 *  guard keeps any future key honest — the fleetProfiles convention). */
function matrixModelRows(
  raw: unknown,
  modes: string[],
  complexity: string[]
): Record<string, FleetMatrixModel> {
  const models: Record<string, FleetMatrixModel> = {};
  if (raw === undefined) {
    return models;
  }
  if (!isRecord(raw)) {
    console.error('bro.config: fleet.matrix.models must be an object — rows dropped');
    return models;
  }
  for (const [name, v] of Object.entries(raw)) {
    if (RESERVED_MODEL_KEYS.has(name)) {
      continue;
    }
    const row = matrixModel(name, v, modes, complexity);
    if (row !== null) {
      Object.defineProperty(models, name, {
        value: row,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return models;
}

/** `fleet.matrix` section parse — shape only; the provider entry and
 *  profile/provider bindings resolve at spawn time (the sections parse
 *  independently, same rule as fleet.routing's chain entries). Absent
 *  section → undefined (the matrix is off, never defaulted on). */
export function fleetMatrix(raw: unknown): FleetMatrix | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    console.error('bro.config: fleet.matrix must be an object — section dropped');
    return undefined;
  }
  const complexity = matrixVocab(
    raw.complexity,
    DEFAULT_MATRIX_COMPLEXITY,
    2,
    10,
    'fleet.matrix.complexity must be 2–10 unique non-empty level names — default scale used'
  );
  const modes = matrixVocab(
    raw.modes,
    DEFAULT_MATRIX_MODES,
    1,
    32,
    'fleet.matrix.modes must be unique non-empty mode names — default modes used'
  );
  return {
    ...matrixScalars(raw),
    complexity,
    modes,
    models: matrixModelRows(raw.models, modes, complexity),
  };
}

/** The judge's two answers, narrowed to what the pick reads — a
 *  missing/unconfident/mistyped answer is "no verdict" for that
 *  dimension, never a guess. */
function confidentAnswer(
  res: DecideResult,
  qid: string
): DecideResult['answers'][string] | undefined {
  if (!Object.hasOwn(res.answers, qid) || res.lowConfidence.includes(qid)) {
    return undefined;
  }
  return res.answers[qid];
}

/** The judged coordinates — complexity level name + mode — when BOTH
 *  answers are confident, correctly typed, finite, and in-vocab. A
 *  NaN/±∞ score is no verdict, never a clamped guess: an unbounded
 *  judge number must not index the scale (and must not fall through
 *  to a spurious no-fit). */
function judgedCoordinates(
  matrix: FleetMatrix,
  res: DecideResult
): { mode: string; level: string } | undefined {
  const cx = confidentAnswer(res, 'complexity');
  const md = confidentAnswer(res, 'mode');
  if (cx?.type !== 'score') {
    return undefined;
  }
  if (md?.type !== 'choice') {
    return undefined;
  }
  if (!Number.isFinite(cx.score)) {
    return undefined;
  }
  const levelIdx = Math.min(matrix.complexity.length - 1, Math.max(0, Math.round(cx.score)));
  const level = matrix.complexity[levelIdx];
  if (level === undefined) {
    return undefined;
  }
  if (!matrix.modes.includes(md.choice)) {
    return undefined;
  }
  return { mode: md.choice, level };
}

/** One axis's coverage — an absent declaration means "every declared
 *  mode/level" (the lane is unrestricted on that axis). */
const laneCovers = (declared: string[] | undefined, value: string): boolean =>
  declared === undefined ? true : declared.includes(value);

/** First declared row covering BOTH judged coordinates — the operator
 *  orders cheap lanes first and the hard filter does the rest: a low
 *  task lands on the cheapest sufficient lane, a high task can never
 *  reach a low-ceiling row because ineligible rows are skipped before
 *  order matters. */
function firstEligible(
  matrix: FleetMatrix,
  mode: string,
  level: string
): [string, FleetMatrixModel] | undefined {
  for (const [name, row] of Object.entries(matrix.models)) {
    if (laneCovers(row.modes, mode) && laneCovers(row.complexity, level)) {
      return [name, row];
    }
  }
  return undefined;
}

/** The pick verdict — the winning row's name plus its spawn bindings
 *  (absent bindings stay absent, never null). */
function pickVerdict(
  name: string,
  row: FleetMatrixModel,
  mode: string,
  level: string
): MatrixVerdict {
  return {
    kind: 'pick',
    model: name,
    mode,
    complexity: level,
    ...(row.profile === undefined ? {} : { profile: row.profile }),
    ...(row.provider === undefined ? {} : { provider: row.provider }),
  };
}

/** Answers → verdict, deterministically. The complexity score is the
 *  probability-weighted level (0 = first/lowest rung); Math.round's
 *  .5-up bias lands borderline calls on the HIGHER level — the safe
 *  direction for a hard filter. The mode choice must name a declared
 *  mode. Eligibility then filters rows by declared capabilities ONLY;
 *  first declared row wins, so operators order cheap lanes first and
 *  let the filter keep hard work off them. */
export function matrixVerdict(matrix: FleetMatrix, res: DecideResult): MatrixVerdict {
  const judged = judgedCoordinates(matrix, res);
  if (judged === undefined) {
    return { kind: 'unanswered' };
  }
  const hit = firstEligible(matrix, judged.mode, judged.level);
  if (hit === undefined) {
    return { kind: 'no-fit', mode: judged.mode, complexity: judged.level };
  }
  const [name, row] = hit;
  return pickVerdict(name, row, judged.mode, judged.level);
}
