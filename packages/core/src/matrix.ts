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
 *  declared mode/level" — the operator narrows lanes explicitly. */
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

/** A declared vocabulary list — array of 2–10 (complexity) or ≥1
 *  (modes) unique non-empty strings. Returns undefined on any defect;
 *  the caller falls back to the default scale. */
function vocabList(raw: unknown, min: number, max: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const s = str(v);
    if (s === undefined || seen.has(s)) {
      return undefined;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
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
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    console.error(`bro.config: ${key} must be an object — row dropped`);
    return null;
  }
  const o = v as Record<string, unknown>;
  const row: FleetMatrixModel = {};
  for (const [field, vocab] of [
    ['modes', modes],
    ['complexity', complexity],
  ] as const) {
    const raw = o[field];
    if (raw === undefined) {
      continue;
    }
    if (!Array.isArray(raw)) {
      console.error(
        `bro.config: ${key}.${field} must be an array of declared ${field === 'modes' ? 'modes' : 'complexity levels'} — row dropped`
      );
      return null;
    }
    const picked: string[] = [];
    const seen = new Set<string>();
    let bad = false;
    for (const item of raw) {
      const s = str(item);
      if (s === undefined || seen.has(s) || !vocab.includes(s)) {
        bad = true;
        break;
      }
      seen.add(s);
      picked.push(s);
    }
    if (bad || picked.length === 0) {
      console.error(
        `bro.config: ${key}.${field} names undeclared or duplicate ${field === 'modes' ? 'modes' : 'complexity levels'} — row dropped`
      );
      return null;
    }
    row[field] = picked;
  }
  for (const f of ['profile', 'provider'] as const) {
    const raw = o[f];
    if (raw === undefined) {
      continue;
    }
    const s = str(raw);
    if (s === undefined) {
      console.error(`bro.config: ${key}.${f} must be a non-empty string — field dropped`);
      continue;
    }
    row[f] = s;
  }
  return row;
}

/** `fleet.matrix` section parse — shape only; the provider entry and
 *  profile/provider bindings resolve at spawn time (the sections parse
 *  independently, same rule as fleet.routing's chain entries). Absent
 *  section → undefined (the matrix is off, never defaulted on). */
export function fleetMatrix(raw: unknown): FleetMatrix | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('bro.config: fleet.matrix must be an object — section dropped');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const declaredComplexity = vocabList(o.complexity, 2, 10);
  if (o.complexity !== undefined && declaredComplexity === undefined) {
    console.error(
      'bro.config: fleet.matrix.complexity must be 2–10 unique non-empty level names — default scale used'
    );
  }
  const declaredModes = vocabList(o.modes, 1, 32);
  if (o.modes !== undefined && declaredModes === undefined) {
    console.error(
      'bro.config: fleet.matrix.modes must be unique non-empty mode names — default modes used'
    );
  }
  const complexity = declaredComplexity ?? [...DEFAULT_MATRIX_COMPLEXITY];
  const modes = declaredModes ?? [...DEFAULT_MATRIX_MODES];
  const matrix: FleetMatrix = {
    mode: 'shadow',
    complexity,
    modes,
    models: {},
  };
  const provider = str(o.provider);
  if (provider !== undefined) {
    matrix.provider = provider;
  }
  if (o.mode !== undefined) {
    if (o.mode === 'shadow' || o.mode === 'enforce' || o.mode === 'off') {
      matrix.mode = o.mode;
    } else {
      console.error(
        'bro.config: fleet.matrix.mode must be one of shadow|enforce|off — field dropped'
      );
    }
  }
  if (o.models !== undefined) {
    if (typeof o.models !== 'object' || o.models === null || Array.isArray(o.models)) {
      console.error('bro.config: fleet.matrix.models must be an object — rows dropped');
    } else {
      for (const [name, v] of Object.entries(o.models)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
          continue;
        }
        const row = matrixModel(name, v, modes, complexity);
        if (row !== null) {
          // defineProperty, not assignment — a lane literally named
          // '__proto__' is already skipped above, but the same guard
          // keeps any future key honest (fleetProfiles' convention)
          Object.defineProperty(matrix.models, name, {
            value: row,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
  }
  return matrix;
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

/** Answers → verdict, deterministically. The complexity score is the
 *  probability-weighted level (0 = first/lowest rung); Math.round's
 *  .5-up bias lands borderline calls on the HIGHER level — the safe
 *  direction for a hard filter. The mode choice must name a declared
 *  mode. Eligibility then filters rows by declared capabilities ONLY;
 *  first declared row wins, so operators order cheap lanes first and
 *  let the filter keep hard work off them. */
export function matrixVerdict(matrix: FleetMatrix, res: DecideResult): MatrixVerdict {
  const cx = confidentAnswer(res, 'complexity');
  const md = confidentAnswer(res, 'mode');
  if (cx?.type !== 'score' || md?.type !== 'choice') {
    return { kind: 'unanswered' };
  }
  const levelIdx = Math.min(matrix.complexity.length - 1, Math.max(0, Math.round(cx.score)));
  const level = matrix.complexity[levelIdx]!;
  const mode = md.choice;
  if (!matrix.modes.includes(mode)) {
    return { kind: 'unanswered' };
  }
  for (const [name, row] of Object.entries(matrix.models)) {
    const modesOk = row.modes === undefined || row.modes.includes(mode);
    const complexityOk = row.complexity === undefined || row.complexity.includes(level);
    if (modesOk && complexityOk) {
      return {
        kind: 'pick',
        model: name,
        mode,
        complexity: level,
        ...(row.profile === undefined ? {} : { profile: row.profile }),
        ...(row.provider === undefined ? {} : { provider: row.provider }),
      };
    }
  }
  return { kind: 'no-fit', mode, complexity: level };
}
