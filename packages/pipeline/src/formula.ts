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
 *   gate_on = "complexity == complex"   # skips unless payload matches
 *   verdicts = ["push", "fix", "abandon"]
 *
 *   [transitions]                  # root table — verdict → next stage
 *   classify = { solo = "route", duplicate = "close", defer = "park" }
 *   review   = { push = "merge", fix = "work", abandon = "close" }
 *
 * Every declared verdict of a transitioned stage needs a target; a
 * target is another stage name or a terminal action.
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
 *  failed. */
export const TERMINAL_ACTIONS = ['end', 'park', 'retry', 'close', 'abandon'] as const;
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number];

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
  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    errors.push(`${where}.name: required non-empty string`);
    return undefined;
  }
  const engine = raw.engine;
  if (typeof engine !== 'string' || !(STAGE_ENGINES as readonly string[]).includes(engine)) {
    errors.push(
      `${where} ("${name}").engine: expected one of ${STAGE_ENGINES.join('|')}, got ${JSON.stringify(engine)}`
    );
    return undefined;
  }
  const verdicts = raw.verdicts;
  if (
    !Array.isArray(verdicts) ||
    verdicts.length === 0 ||
    verdicts.some(v => typeof v !== 'string' || v.length === 0)
  ) {
    errors.push(`${where} ("${name}").verdicts: required non-empty string array`);
    return undefined;
  }
  if ((verdicts as string[]).includes('skip')) {
    errors.push(
      `${where} ("${name}").verdicts: "skip" is reserved — the runner synthesizes it on gate_on failure`
    );
    return undefined;
  }
  const mode = raw.mode;
  if (mode !== undefined && typeof mode !== 'string') {
    errors.push(`${where} ("${name}").mode: must be a string`);
    return undefined;
  }
  return {
    name,
    engine: engine as StageEngine,
    verdicts: verdicts as string[],
    gate_on: parseGateOn(raw.gate_on, `${where} ("${name}")`, errors),
    mode: mode as string | undefined,
  };
}

/** Validate an already-parsed formula document — the plugin planSchema.
 *  Throws one error listing every problem. */
export function parsePipelineFormula(doc: unknown, source = 'formula'): PipelineFormula {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    throw new Error(`${source}: expected a TOML table`);
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) {
      errors.push(`unknown top-level key "${key}"`);
    }
  }
  if (doc.kind !== undefined && doc.kind !== PIPELINE_KIND) {
    errors.push(`kind: expected "${PIPELINE_KIND}", got ${JSON.stringify(doc.kind)}`);
  }
  checkPlanVersion(doc.version, PIPELINE_KIND, PIPELINE_VERSION, errors);

  const stages: PipelineStage[] = [];
  if (!Array.isArray(doc.stages) || doc.stages.length === 0) {
    errors.push('stages: at least one [[stages]] entry is required');
  } else {
    doc.stages.forEach((raw, i) => {
      const s = parseStage(raw, i, errors);
      if (s) stages.push(s);
    });
  }
  const names = new Set(stages.map(s => s.name));
  stages.forEach((s, i) => {
    if (stages.findIndex(o => o.name === s.name) !== i) {
      errors.push(`stages[${i}]: duplicate stage name "${s.name}"`);
    }
  });

  const transitions: Record<string, Record<string, string>> = {};
  if (doc.transitions !== undefined && !isRecord(doc.transitions)) {
    errors.push('transitions: must be a TOML table');
  } else if (isRecord(doc.transitions)) {
    for (const [stage, vmap] of Object.entries(doc.transitions)) {
      if (!names.has(stage)) {
        errors.push(`transitions.${stage}: no such stage`);
        continue;
      }
      if (!isRecord(vmap)) {
        errors.push(`transitions.${stage}: must be a verdict→target table`);
        continue;
      }
      const decl = stages.find(s => s.name === stage)!;
      // `skip` is the runner-synthesized verdict of a failed gate_on —
      // an implicit member of a gated stage's enum, required in its map
      const allowed = decl.gate_on ? [...decl.verdicts, 'skip'] : decl.verdicts;
      const map: Record<string, string> = {};
      for (const [verdict, target] of Object.entries(vmap)) {
        if (!allowed.includes(verdict)) {
          errors.push(`transitions.${stage}.${verdict}: not a declared verdict of "${stage}"`);
          continue;
        }
        if (
          typeof target !== 'string' ||
          (!names.has(target) && !(TERMINAL_ACTIONS as readonly string[]).includes(target))
        ) {
          errors.push(
            `transitions.${stage}.${verdict}: target ${JSON.stringify(target)} is not a stage or terminal action (${TERMINAL_ACTIONS.join('|')})`
          );
          continue;
        }
        map[verdict] = target;
      }
      for (const v of allowed) {
        if (!(v in map)) {
          errors.push(`transitions.${stage}: verdict "${v}" has no transition`);
        }
      }
      transitions[stage] = map;
    }
  }
  // a stage emitting verdicts with no transitions table entry dead-ends
  for (const s of stages) {
    if (!(s.name in transitions)) {
      errors.push(`transitions: stage "${s.name}" has no entry — every verdict needs a target`);
    }
  }

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

/** The formula's identity — sha256 over the raw file bytes, no
 *  canonicalization: byte-different files are different versions. */
export function formulaSha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Read + TOML-parse + validate a formula file. Returns the formula and
 *  its content sha — the pair a run stamps into the journal/registry. */
export function loadPipelineFormula(file: string): {
  formula: PipelineFormula;
  sha: string;
} {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: cannot read formula — ${msg}`);
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid TOML — ${err instanceof Error ? err.message : String(err)}`);
  }
  return { formula: parsePipelineFormula(doc, file), sha: formulaSha(text) };
}

/** Where a verdict takes the run — a stage name or a terminal action.
 *  Undefined when the stage/verdict pair has no transition (a valid
 *  formula can't produce this, but the runner tolerates it). */
export function transitionFor(
  formula: PipelineFormula,
  stage: string,
  verdict: string
): string | undefined {
  return formula.transitions[stage]?.[verdict];
}

export function isTerminalAction(t: string): t is TerminalAction {
  return (TERMINAL_ACTIONS as readonly string[]).includes(t);
}

/** Entry point — declaration order, stages[0]. */
export function entryStage(formula: PipelineFormula): PipelineStage {
  return formula.stages[0];
}
