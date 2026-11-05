/**
 * Test kit for the pipeline suites — the fakes the judge-driven stage
 * tests (classify, route, …) drive instead of stores and judges:
 *
 *   row/choice/noul/score — the builders the decide scripts are
 *     written in (a bare TaskRow, a typed JudgeAnswer with a
 *     tunable confidence)
 *   judge — a scripted JudgeFacade that records every decide (state +
 *     asked questions) for assertions and plays the scripted answers
 *     back verbatim, flagging `lowConfidence` ids
 *   backlog — an in-memory RouteBacklog/ClassifyBacklog: label writes
 *     land on spy lists AND mutate the row, so the seam's re-read sees
 *     current labels like a real store would
 *
 * One kit keeps every stage suite asserting against the same spy
 * shape — same role as core's testkit for the wider repo.
 */
import type {
  DecideResult,
  JudgeAnswer,
  JudgeFacade,
  JudgeQuestion,
  TaskRow,
  TaskSpecFacade,
} from '@broject/core';
import { parseTaskSpecBody } from '@broject/core';
import type { EngineOutcome, EngineResult } from './runner.ts';
import type { ClassifyBacklog } from './stages/classify.ts';

/** Narrow an engine outcome to a settling result — the stages these
 *  suites drive (judge/learn engines) never suspend or alert, so a
 *  'pending' or engine-alert here is a fixture bug, not a branch to
 *  assert through. */
export const settled = (r: EngineOutcome): EngineResult => {
  if (r === 'pending' || (typeof r === 'object' && r !== null && 'alert' in r)) {
    throw new Error(`test stage did not settle — got ${JSON.stringify(r)}`);
  }
  return r;
};

/** A bare task row — id + title + open, extras spread over it. */
export const row = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: `task ${id}`,
  status: 'open',
  ...extra,
});

export const choice = (c: string, confidence = 0.9): JudgeAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: {},
  confidence,
  decidedBy: 'fake',
});

export const noul = (n: number, confidence = 0.9): JudgeAnswer => ({
  type: 'noul',
  noul: n,
  confidence,
  decidedBy: 'fake',
});

export const score = (s: number, confidence = 0.9): JudgeAnswer => ({
  type: 'score',
  score: s,
  probabilities: {},
  confidence,
  decidedBy: 'fake',
});

export interface JudgeSpy {
  calls: { state: unknown; questions: Record<string, JudgeQuestion> }[];
  facade: JudgeFacade;
}

/** A scripted JudgeFacade — answers come from `answers`, every asked
 *  question id + the seen state are recorded for assertions. */
export const judge = (
  answers: Record<string, JudgeAnswer>,
  lowConfidence: string[] = []
): JudgeSpy => {
  const calls: JudgeSpy['calls'] = [];
  return {
    calls,
    facade: {
      decide: async (state, questions) => {
        calls.push({ state, questions });
        const res: DecideResult = {
          answers,
          model: 'fake-judge',
          latencyMs: 1,
          lowConfidence,
        };
        return res;
      },
    },
  };
};

export interface BacklogSpy extends ClassifyBacklog {
  added: [string, string][];
  removed: [string, string][];
  /** one ordered op log — '+' add / '-' remove — so tests can assert
   *  removals precede adds (the remove-then-add contract). */
  events: string[];
  peersAsked: number;
}

/** An in-memory backlog — label writes land on the spy lists, never
 *  on a store, and mutate the row so the seam's re-read sees current
 *  labels (mirroring a real store; stale-snapshot guards read through
 *  the same seam). `peers` fixes the candidate set a stage sees;
 *  the default mirrors prod's `taskBacklog` tiers (ready ∪ open ∪
 *  in_progress) — a closed or foreign-status row is never offered to
 *  the judge. A supplied peer is still a store row: item reads and
 *  label writes find it (tagMates reads `item()` before `addLabel`).
 *  Structurally satisfies the narrower RouteBacklog seam (item +
 *  label writes) too. */
export const backlog = (rows: TaskRow[], peers?: TaskRow[]): BacklogSpy => {
  const find = (id: string): TaskRow | undefined =>
    rows.find(r => r.id === id) ?? (peers ?? []).find(r => r.id === id);
  const spy: BacklogSpy = {
    added: [],
    removed: [],
    events: [],
    peersAsked: 0,
    item: find,
    peers: item => {
      spy.peersAsked += 1;
      return (
        peers ??
        rows.filter(r => r.id !== item.id && (r.status === 'open' || r.status === 'in_progress'))
      );
    },
    addLabel: (id, l) => {
      spy.added.push([id, l]);
      spy.events.push(`+${id}:${l}`);
      // --add-label is set semantics — a standing label never doubles
      const r = find(id);
      if (r !== undefined && !(r.labels ?? []).includes(l)) {
        r.labels = [...(r.labels ?? []), l];
      }
    },
    removeLabel: (id, l) => {
      spy.removed.push([id, l]);
      spy.events.push(`-${id}:${l}`);
      const r = find(id);
      if (r !== undefined) r.labels = (r.labels ?? []).filter(x => x !== l);
    },
  };
  return spy;
};

/** What specStore records per annotate — the id, the heading, and the
 *  exact lines appended under it. */
export interface SpecAnnotateCall {
  id: string;
  heading: string;
  lines: string[];
}

export interface SpecStoreSpy extends TaskSpecFacade {
  /** every annotate call, in order */
  annotated: SpecAnnotateCall[];
  /** raw body text per item — tests seed spec sections through
   *  `description` on the rows and read appended artifacts back here */
  bodies: Map<string, string>;
}

/** An in-memory TaskSpecFacade — `spec()` projects the stored body
 *  through the REAL parser (`parseTaskSpecBody`, the same read prod's
 *  adapter makes: a `## Acceptance` section becomes `acceptance[]`,
 *  `## Questions` stays body prose), and `annotate()` appends the
 *  `## heading` section the way prod's read-modify-write does while
 *  recording the call. Enforces the contract's loud failures an
 *  engine must hit — missing item, empty/multi-line heading, empty
 *  lines — but not the managed-section dup guard (an intake artifact
 *  never targets a managed name). */
export const specStore = (rows: TaskRow[]): SpecStoreSpy => {
  const bodies = new Map(rows.map(r => [r.id, r.description ?? '']));
  const titles = new Map(rows.map(r => [r.id, r.title ?? `task ${r.id}`]));
  const spy: SpecStoreSpy = {
    annotated: [],
    bodies,
    spec: id => {
      const d = bodies.get(id);
      return d === undefined
        ? undefined
        : { id, title: titles.get(id) ?? '', ...parseTaskSpecBody(d) };
    },
    annotate: (id, heading, lines) => {
      if (heading.trim() === '' || /[\r\n]/.test(heading)) {
        throw new Error('specStore annotate: heading must be a single non-empty line');
      }
      if (lines.length === 0) {
        throw new Error('specStore annotate: an artifact with no lines is no artifact');
      }
      const base = bodies.get(id);
      if (base === undefined) {
        throw new Error(`specStore annotate: item "${id}" is not in the store`);
      }
      spy.annotated.push({ id, heading, lines: [...lines] });
      const section = `## ${heading}\n${lines.join('\n')}`;
      bodies.set(id, base === '' ? section : `${base}\n\n${section}`);
    },
  };
  return spy;
};
