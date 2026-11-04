/**
 * Pipeline formulas — stage DAGs describing how each work item flows
 * through bro's gates (classify → route → work → review? → merge →
 * capture). Data, never agent-facing: the formula is read by the core
 * stage-runner, never poured into prompts.
 *
 *   kind = "pipeline"
 *   version = 1                    # optional — schema pin
 *
 *   [[stages]]
 *   name = "classify"
 *   engine = "judge"
 *   verdicts = ["solo", "clump", "duplicate", "defer"]
 *
 *   [[stages]]
 *   name = "review"
 *   engine = "judge"
 *   gate_on = "complexity == complex"
 *   verdicts = ["push", "fix", "abandon"]
 *
 *   [transitions]                  # root table — verdict → next stage
 *   classify = { solo = "route", clump = "route", duplicate = "close",
 *                defer = "park" }
 *   review   = { skip = "merge", push = "merge", fix = "work",
 *                abandon = "close" }
 *
 * Every declared verdict needs a target; a target is another stage
 * name or a terminal action. A stage with `gate_on` also gets the
 * implicit `skip` verdict — synthesized when the gate fails, required
 * in its transition map, forbidden elsewhere.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { checkPlanVersion } from '@broject/core';

export const PIPELINE_KIND = 'pipeline';

/** The schema version this parser speaks — `version = N` pins it; a pin
 *  above this is rejected, not misparsed. */
export const PIPELINE_VERSION = 1;

/** Engines a stage may name — the core facilities the runner invokes.
 *  `judge` emits typed verdicts; `fleet` spawns/moves agents; `act-gate`
 *  is the PR review gate; `learn` is the capture/self-learn engine. */
export const STAGE_ENGINES = ['judge', 'fleet', 'act-gate', 'learn'] as const;
export type StageEngine = (typeof STAGE_ENGINES)[number];

/** Transition targets that are runner actions, not stages. `end` is
 *  terminal-success; `park` suspends the item until capacity/operator;
 *  `retry` re-runs the same stage (bounded by the runner's attempt
 *  budget); `close` drops the item as settled; `abandon` drops it as
 *  failed. These names are reserved — a stage cannot take one. */
export const TERMINAL_ACTIONS = ['end', 'park', 'retry', 'close', 'abandon'] as const;
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number];

/** The verdict the runner synthesizes when a stage's `gate_on`
 *  predicate fails — the engine is not invoked. Implicit member of a
 *  gated stage's enum; reserved in `verdicts`, required in
 *  `transitions` for gated stages, forbidden elsewhere. */
export const SKIP_VERDICT = 'skip';

/** A stage gate predicate — `gate_on = "complexity == complex"` gates
 *  the stage on a field of the current pipeline context (produced by
 *  earlier stage payloads). Only `==`/`!=` against a bare token. */
export interface GateOn {
  field: string;
  op: '==' | '!=';
  value: string;
}

export interface PipelineStage {
  name: string;
  engine: StageEngine;
  /** declared verdict enum — transitions must cover every member */
  verdicts: string[];
  /** optional gate predicate on the pipeline context */
  gate_on?: GateOn;
  /** engine-specific mode token (e.g. learn's "always-capture") */
  mode?: string;
}

export interface PipelineFormula {
  kind: typeof PIPELINE_KIND;
  version: number;
  /** declaration order — stages[0] is the entry point */
  stages: PipelineStage[];
  /** stage name → verdict → stage name | terminal action */
  transitions: Record<string, Record<string, string>>;
}

const TOP_KEYS = new Set(['kind', 'version', 'stages', 'transitions']);

const STAGE_KEYS = new Set(['name', 'engine', 'verdicts', 'gate_on', 'mode']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseGateOn(raw: unknown, where: string, errors: string[]): GateOn | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`${where}.gate_on: must be a string like "field == value"`);
    return undefined;
  }
  const m = /^([A-Za-z_][\w.]*)\s*(==|!=)\s*([\w.-]+)$/.exec(raw.trim());
  if (!m) {
    errors.push(
      `${where}.gate_on: cannot parse ${JSON.stringify(raw)} — expected "field == value" or "field != value"`
    );
    return undefined;
  }
  return { field: m[1], op: m[2] as '==' | '!=', value: m[3] };
}

function stageName(raw: unknown, where: string, errors: string[]): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push(`${where}.name: required non-empty string`);
    return undefined;
  }
  if ((TERMINAL_ACTIONS as readonly string[]).includes(raw)) {
    errors.push(`${where}.name: "${raw}" is a reserved terminal action, not a stage name`);
    return undefined;
  }
  return raw;
}

function stageEngine(raw: unknown, where: string, errors: string[]): StageEngine | undefined {
  if (typeof raw !== 'string' || !(STAGE_ENGINES as readonly string[]).includes(raw)) {
    errors.push(
      `${where}.engine: expected one of ${STAGE_ENGINES.join('|')}, got ${JSON.stringify(raw)}`
    );
    return undefined;
  }
  return raw as StageEngine;
}

function stageVerdicts(raw: unknown, where: string, errors: string[]): string[] | undefined {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some(v => typeof v !== 'string' || v.length === 0)
  ) {
    errors.push(`${where}.verdicts: required non-empty string array`);
    return undefined;
  }
  if ((raw as string[]).includes(SKIP_VERDICT)) {
    errors.push(
      `${where}.verdicts: "${SKIP_VERDICT}" is reserved — the runner synthesizes it on gate_on failure`
    );
    return undefined;
  }
  return raw as string[];
}

function parseStage(raw: unknown, i: number, errors: string[]): PipelineStage | undefined {
  const where = `stages[${i}]`;
  if (!isRecord(raw)) {
    errors.push(`${where}: expected a TOML table`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!STAGE_KEYS.has(key)) {
      errors.push(`${where}: unknown key "${key}"`);
    }
  }
  const name = stageName(raw.name, where, errors);
  if (name === undefined) return undefined;
  const at = `${where} ("${name}")`;
  const engine = stageEngine(raw.engine, at, errors);
  const verdicts = stageVerdicts(raw.verdicts, at, errors);
  if (engine === undefined || verdicts === undefined) return undefined;
  const mode = raw.mode;
  if (mode !== undefined && typeof mode !== 'string') {
    errors.push(`${at}.mode: must be a string`);
    return undefined;
  }
  return {
    name,
    engine,
    verdicts,
    gate_on: parseGateOn(raw.gate_on, at, errors),
    mode: mode as string | undefined,
  };
}

/** The verdict set a stage's transition map must cover — declared
 *  verdicts plus `skip` when the stage is gated. */
function allowedVerdicts(stage: PipelineStage): string[] {
  return stage.gate_on ? [...stage.verdicts, SKIP_VERDICT] : stage.verdicts;
}

function validateTransitionEntry(
  stage: PipelineStage,
  vmap: Record<string, unknown>,
  names: Set<string>,
  errors: string[]
): Record<string, string> {
  // null prototype — a verdict literally named "__proto__" must land as
  // data, not hit the prototype setter
  const map: Record<string, string> = Object.create(null);
  const allowed = allowedVerdicts(stage);
  for (const [verdict, target] of Object.entries(vmap)) {
    if (!allowed.includes(verdict)) {
      errors.push(
        `transitions.${stage.name}.${verdict}: not a declared verdict of "${stage.name}"`
      );
      continue;
    }
    if (
      typeof target !== 'string' ||
      (!names.has(target) && !(TERMINAL_ACTIONS as readonly string[]).includes(target))
    ) {
      errors.push(
        `transitions.${stage.name}.${verdict}: target ${JSON.stringify(target)} is not a stage or terminal action (${TERMINAL_ACTIONS.join('|')})`
      );
      continue;
    }
    map[verdict] = target;
  }
  for (const v of allowed) {
    if (!Object.hasOwn(map, v)) {
      errors.push(`transitions.${stage.name}: verdict "${v}" has no transition`);
    }
  }
  return map;
}

function validateTransitions(
  raw: unknown,
  stages: PipelineStage[],
  errors: string[]
): Record<string, Record<string, string>> {
  const transitions: Record<string, Record<string, string>> = Object.create(null);
  const names = new Set(stages.map(s => s.name));
  const byName = new Map(stages.map(s => [s.name, s]));
  if (raw !== undefined && !isRecord(raw)) {
    errors.push('transitions: must be a TOML table');
    return transitions;
  }
  for (const [stage, vmap] of Object.entries(raw ?? {})) {
    const decl = byName.get(stage);
    if (!decl) {
      errors.push(`transitions.${stage}: no such stage`);
      continue;
    }
    if (!isRecord(vmap)) {
      errors.push(`transitions.${stage}: must be a verdict→target table`);
      continue;
    }
    transitions[stage] = validateTransitionEntry(decl, vmap, names, errors);
  }
  // a stage emitting verdicts with no transitions table entry dead-ends —
  // hasOwn, not `in`: prototype keys like `toString` are not entries
  for (const s of stages) {
    if (!Object.hasOwn(transitions, s.name)) {
      errors.push(`transitions: stage "${s.name}" has no entry — every verdict needs a target`);
    }
  }
  return transitions;
}

function validateEnvelope(doc: Record<string, unknown>, errors: string[]): void {
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) {
      errors.push(`unknown top-level key "${key}"`);
    }
  }
  if (doc.kind !== undefined && doc.kind !== PIPELINE_KIND) {
    errors.push(`kind: expected "${PIPELINE_KIND}", got ${JSON.stringify(doc.kind)}`);
  }
  checkPlanVersion(doc.version, PIPELINE_KIND, PIPELINE_VERSION, errors);
}

function parseStages(raw: unknown, errors: string[]): PipelineStage[] {
  const stages: PipelineStage[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('stages: at least one [[stages]] entry is required');
    return stages;
  }
  raw.forEach((r, i) => {
    const s = parseStage(r, i, errors);
    if (s) stages.push(s);
  });
  stages.forEach((s, i) => {
    if (stages.findIndex(o => o.name === s.name) !== i) {
      errors.push(`stages[${i}]: duplicate stage name "${s.name}"`);
    }
  });
  return stages;
}

/** Validate an already-parsed formula document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parsePipelineFormula(doc: unknown, source = 'formula'): PipelineFormula {
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`);
  }
  const errors: string[] = [];
  validateEnvelope(doc, errors);
  const stages = parseStages(doc.stages, errors);
  const transitions = validateTransitions(doc.transitions, stages, errors);

  if (errors.length > 0) {
    throw new Error(`${source}: invalid pipeline formula\n  ${errors.join('\n  ')}`);
  }
  return {
    kind: PIPELINE_KIND,
    version: typeof doc.version === 'number' ? doc.version : PIPELINE_VERSION,
    stages,
    transitions,
  };
}

/** The formula's identity — sha256 over the raw bytes, no
 *  canonicalization: byte-different files are different versions. */
export function formulaSha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read + TOML-parse + validate a formula file. The sha stamps the RAW
 *  bytes — invalid UTF-8 sequences stay distinct identities instead of
 *  collapsing to U+FFFD; the text is decoded separately for parsing. */
export function loadPipelineFormula(file: string): {
  formula: PipelineFormula;
  sha: string;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: cannot read formula — ${msg}`);
  }
  let doc: unknown;
  try {
    doc = parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${file}: invalid TOML — ${err instanceof Error ? err.message : String(err)}`);
  }
  return { formula: parsePipelineFormula(doc, file), sha: formulaSha(bytes) };
}

/** Where a verdict takes the run — a stage name or a terminal action.
 *  Undefined when the stage/verdict pair has no transition (a valid
 *  formula can't produce this, but the runner tolerates it). */
export function transitionFor(
  formula: PipelineFormula,
  stage: string,
  verdict: string
): string | undefined {
  const map = Object.hasOwn(formula.transitions, stage) ? formula.transitions[stage] : undefined;
  return map && Object.hasOwn(map, verdict) ? map[verdict] : undefined;
}

export function isTerminalAction(t: string): t is TerminalAction {
  return (TERMINAL_ACTIONS as readonly string[]).includes(t);
}

/** Entry point — declaration order, stages[0]. */
export function entryStage(formula: PipelineFormula): PipelineStage {
  return formula.stages[0];
}
