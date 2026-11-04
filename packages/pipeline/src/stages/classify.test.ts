import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import type { DecideResult, JudgeAnswer, JudgeFacade, JudgeQuestion, TaskRow } from '@broject/core';
import { parsePipelineFormula } from '../formula.ts';
import { memoryJournal } from '../journal.ts';
import { runPipeline, type StageCall } from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import {
  classifyStage,
  CLUMP_LABEL_PREFIX,
  DEFAULT_MAX_PEERS,
  DUP_LABEL_PREFIX,
  stageDispatch,
  taskBacklog,
  type ClassifyBacklog,
  type ClassifyPayload,
} from './classify.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const ITEM = 'bro-aa1';
const SHA = 'deadbeef';

const row = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  id,
  title: `task ${id}`,
  status: 'open',
  ...extra,
});

const choice = (c: string, confidence = 0.9): JudgeAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: {},
  confidence,
  decidedBy: 'fake',
});
const noul = (n: number, confidence = 0.9): JudgeAnswer => ({
  type: 'noul',
  noul: n,
  confidence,
  decidedBy: 'fake',
});
const score = (s: number, confidence = 0.9): JudgeAnswer => ({
  type: 'score',
  score: s,
  probabilities: {},
  confidence,
  decidedBy: 'fake',
});

interface JudgeSpy {
  calls: { state: unknown; questions: Record<string, JudgeQuestion> }[];
  facade: JudgeFacade;
}

/** A scripted JudgeFacade — answers come from `answers`, every asked
 *  question id + the seen state are recorded for assertions. */
const judge = (answers: Record<string, JudgeAnswer>, lowConfidence: string[] = []): JudgeSpy => {
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

interface BacklogSpy extends ClassifyBacklog {
  added: [string, string][];
  removed: [string, string][];
  peersAsked: number;
}

/** An in-memory backlog — label writes land on the spy lists, never
 *  on a store. */
const backlog = (rows: TaskRow[], peers?: TaskRow[]): BacklogSpy => {
  const spy: BacklogSpy = {
    added: [],
    removed: [],
    peersAsked: 0,
    item: id => rows.find(r => r.id === id),
    peers: () => {
      spy.peersAsked += 1;
      return peers ?? rows.filter(r => r.id !== ITEM);
    },
    addLabel: (id, l) => {
      spy.added.push([id, l]);
    },
    removeLabel: (id, l) => {
      spy.removed.push([id, l]);
    },
  };
  return spy;
};

const call = (item = ITEM): StageCall =>
  ({
    runId: 'r1',
    item,
    stage: FORMULA.stages[0],
    attempt: 1,
    ctx: {},
    journal: memoryJournal(),
  }) as StageCall;

const invoke = async (j: JudgeSpy, b: ClassifyBacklog, deps: { labels?: boolean } = {}) =>
  classifyStage({ judge: j.facade, backlog: b, ...deps }).invoke(call());

describe('classify — dedup', () => {
  test('a confident dup_of peer → duplicate with dupOf + dup: label', async () => {
    const j = judge({ dup_of: choice('bro-bb2') });
    const b = backlog([row(ITEM), row('bro-bb2', { title: 'same fix' })]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'duplicate');
    const p = res.payload as ClassifyPayload;
    assert.equal(p.group, 'duplicate');
    assert.equal(p.dupOf, 'bro-bb2');
    assert.equal(p.complexity, 'complex'); // unanswered → conservative
    assert.equal(p.rank, 1);
    assert.deepEqual(b.added, [[ITEM, `${DUP_LABEL_PREFIX}bro-bb2`]]);
    assert.deepEqual(b.removed, []);
  });

  test('dup_of "none" → not a duplicate', async () => {
    const j = judge({ dup_of: choice('none'), clump: choice('solo') });
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'solo');
    assert.deepEqual(b.added, []);
  });

  test('a low-confidence dup_of is NOT honored — no closing on a dim answer', async () => {
    const j = judge({ dup_of: choice('bro-bb2', 0.3) }, ['dup_of']);
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'solo');
    const p = res.payload as ClassifyPayload;
    assert.deepEqual(p.lowConfidence, ['dup_of']);
    assert.deepEqual(b.added, []);
  });

  test('a dup_of naming a non-peer is no dup', async () => {
    const j = judge({ dup_of: choice('bro-zz9') });
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'solo');
  });
});

describe('classify — clump', () => {
  test('affinity: clump "new" + affirmed mates → clumpId + labels on item and mates', async () => {
    const j = judge({
      clump: choice('new'),
      'mate_bro-bb2': noul(0.9),
      'mate_bro-cc3': noul(0.1),
      rank: score(4),
    });
    const b = backlog([row(ITEM), row('bro-bb2'), row('bro-cc3')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'clump');
    const p = res.payload as ClassifyPayload;
    assert.equal(p.group, 'clump');
    assert.equal(p.clumpId, ITEM); // founding member names the group
    assert.equal(p.rank, 1); // score 4 → rank 1
    assert.deepEqual(b.added, [
      [ITEM, `${CLUMP_LABEL_PREFIX}${ITEM}`],
      ['bro-bb2', `${CLUMP_LABEL_PREFIX}${ITEM}`],
    ]);
  });

  test('joining an existing clump id labels the item; a labeled mate keeps its tag', async () => {
    const j = judge({ clump: choice('g7'), 'mate_bro-bb2': noul(0.9) });
    const b = backlog([
      row(ITEM),
      row('bro-bb2', { labels: [`${CLUMP_LABEL_PREFIX}g7`] }),
      row('bro-cc3', { labels: [`${CLUMP_LABEL_PREFIX}g7`] }),
    ]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'clump');
    const p = res.payload as ClassifyPayload;
    assert.equal(p.clumpId, 'g7');
    // bb2 was affirmed a mate but already carries a clump label — no rewrite
    assert.deepEqual(b.added, [[ITEM, `${CLUMP_LABEL_PREFIX}g7`]]);
  });

  test('an existing clump id is offered as a criterion, not invented', async () => {
    const j = judge({ clump: choice('solo') });
    const b = backlog([row(ITEM), row('bro-bb2', { labels: ['clump:g7', 'other'] })]);
    await invoke(j, b);
    const criteria = j.calls[0].questions.clump;
    assert.equal(criteria?.type, 'choice');
    assert.ok(Object.hasOwn(criteria.criteria, 'g7'));
    assert.ok(Object.hasOwn(criteria.criteria, 'new'));
    assert.ok(Object.hasOwn(criteria.criteria, 'solo'));
  });
});

describe('classify — solo', () => {
  test('no clump signal → solo, no labels written', async () => {
    const j = judge({ clump: choice('solo'), complexity: choice('cheap'), rank: score(0) });
    const b = backlog([row(ITEM)]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'solo');
    const p = res.payload as ClassifyPayload;
    assert.equal(p.group, 'solo');
    assert.equal(p.complexity, 'cheap');
    assert.equal(p.rank, 5); // score 0 → last position
    assert.deepEqual(b.added, []);
  });
});

describe('classify — complexity', () => {
  test('confident cheap → cheap; confident complex → complex', async () => {
    const cheap = judge({ complexity: choice('cheap') });
    const res = await invoke(cheap, backlog([row(ITEM)]));
    assert.equal((res.payload as ClassifyPayload).complexity, 'cheap');
    const complex = judge({ complexity: choice('complex') });
    const res2 = await invoke(complex, backlog([row(ITEM)]));
    assert.equal((res2.payload as ClassifyPayload).complexity, 'complex');
  });

  test('unanswered or dimmed complexity → complex (never fails open)', async () => {
    const dim = judge({ complexity: choice('cheap', 0.2) }, ['complexity']);
    const res = await invoke(dim, backlog([row(ITEM)]));
    assert.equal((res.payload as ClassifyPayload).complexity, 'complex');
  });
});

describe('classify — defer', () => {
  test('affirmed defer + reason → defer verdict carrying the reason', async () => {
    const j = judge({ defer: noul(0.8), defer_reason: choice('blocked') });
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'defer');
    const p = res.payload as ClassifyPayload;
    assert.equal(p.group, 'defer');
    assert.equal(p.reason, 'blocked');
    assert.deepEqual(b.added, []); // defer marks the bead nowhere
  });

  test('defer without a confident reason → "unspecified"', async () => {
    const j = judge({ defer: noul(0.9) });
    const res = await invoke(j, backlog([row(ITEM)]));
    assert.equal((res.payload as ClassifyPayload).reason, 'unspecified');
  });

  test('a dimmed defer does not park the item', async () => {
    const j = judge({ defer: noul(0.9, 0.1), clump: choice('solo') }, ['defer']);
    const res = await invoke(j, backlog([row(ITEM)]));
    assert.equal(res.verdict, 'solo');
  });
});

describe('classify — seams + edges', () => {
  test('missing item throws — a phantom is never classified', async () => {
    const j = judge({});
    const b = backlog([]);
    await assert.rejects(() => invoke(j, b), /not in the backlog/);
  });

  test('re-classification removes stale dup:/clump: marks before writing', async () => {
    const j = judge({ clump: choice('new') });
    const b = backlog([row(ITEM, { labels: ['dup:bro-old', 'keep-me', 'clump:old'] })]);
    await invoke(j, b);
    assert.deepEqual(b.removed, [
      [ITEM, 'dup:bro-old'],
      [ITEM, 'clump:old'],
    ]);
    assert.deepEqual(b.added, [[ITEM, `${CLUMP_LABEL_PREFIX}${ITEM}`]]);
  });

  test('labels: false → decide still runs, nothing is written', async () => {
    const j = judge({ dup_of: choice('bro-bb2') });
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b, { labels: false });
    assert.equal(res.verdict, 'duplicate');
    assert.deepEqual(b.added, []);
  });

  test('peers are capped for the decide — criteria stay bounded', async () => {
    const peers = Array.from({ length: DEFAULT_MAX_PEERS + 4 }, (_, i) => row(`bro-p${i}`));
    const j = judge({});
    const b = backlog([row(ITEM)], peers);
    await invoke(j, b);
    const state = j.calls[0].state as { peers: unknown[] };
    assert.equal(state.peers.length, DEFAULT_MAX_PEERS);
    const mateQuestions = Object.keys(j.calls[0].questions).filter(k => k.startsWith('mate_'));
    assert.equal(mateQuestions.length, DEFAULT_MAX_PEERS);
  });
});

describe('taskBacklog — prod seam over TaskStore', () => {
  const store = {
    rows: [] as TaskRow[],
    updates: [] as [string, Record<string, string | number>][],
    get(id: string) {
      return this.rows.find(r => r.id === id);
    },
    ready() {
      return this.rows.filter(r => r.status === 'open');
    },
    list(f?: { status?: string }) {
      return this.rows.filter(r => f?.status === undefined || r.status === f.status);
    },
    update(id: string, patch: Record<string, string | number>) {
      this.updates.push([id, patch]);
    },
  };

  test('label writes map to --add-label/--remove-label patches', () => {
    store.rows = [];
    store.updates = [];
    const b = taskBacklog(store as never);
    b.addLabel('x1', 'clump:g1');
    b.removeLabel('x1', 'dup:o1');
    assert.deepEqual(store.updates, [
      ['x1', { 'add-label': 'clump:g1' }],
      ['x1', { 'remove-label': 'dup:o1' }],
    ]);
  });

  test('peers = ready ∪ open ∪ in_progress, deduped, item excluded', () => {
    store.rows = [
      row(ITEM),
      row('a', { status: 'open' }),
      row('b', { status: 'in_progress' }),
      row('c', { status: 'open' }),
      row('d', { status: 'closed' }),
    ];
    const b = taskBacklog(store as never);
    const ids = b.peers(row(ITEM)).map(r => r.id);
    assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
  });
});

describe('stageDispatch — one judge slot, many stages', () => {
  test('dispatches on stage name; unbound stage throws loud', async () => {
    const j = judge({ clump: choice('solo') });
    const b = backlog([row(ITEM)]);
    const h = stageDispatch({ classify: classifyStage({ judge: j.facade, backlog: b }) });
    const res = await h.invoke(call());
    assert.equal(res.verdict, 'solo');
    const routeCall = { ...call(), stage: FORMULA.stages[1] };
    await assert.rejects(async () => h.invoke(routeCall), /no engine bound for stage "route"/);
  });
});

describe('classify inside runPipeline — the payload feeds the gate', () => {
  test('cheap item: real classify engine → review stage synthesizes skip', async () => {
    const j = judge({ clump: choice('solo'), complexity: choice('cheap') });
    const b = backlog([row(ITEM)]);
    const journal = memoryJournal();
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal,
      admit: () => true,
      engines: {
        judge: stageDispatch({
          classify: classifyStage({ judge: j.facade, backlog: b }),
          route: () => ({ verdict: 'queue' }), // cheap → park before work
        }),
      },
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'route');
    const p = res.ctx.classify as ClassifyPayload;
    assert.equal(p.group, 'solo');
    assert.equal(p.complexity, 'cheap'); // flat merge feeds review.gate_on
    assert.equal(res.ctx.complexity, 'cheap');
    assert.equal(j.calls.length, 1); // one decide for the whole classification
  });
});
