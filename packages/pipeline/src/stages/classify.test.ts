import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import type { TaskRow } from '@broject/core';
import { parsePipelineFormula } from '../formula.ts';
import { memoryJournal } from '../journal.ts';
import { DEFAULT_ADMIT_INTENTS, runPipeline, type StageCall } from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { backlog, choice, judge, noul, row, score, settled, type JudgeSpy } from '../testkit.ts';
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
  settled(await classifyStage({ judge: j.facade, backlog: b, ...deps }).invoke(call()));

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
    assert.equal(p.rank, 3); // unanswered → midpoint, not first-in-line
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

  test('clump "new" with NO affirmed mate is solo — never a one-bead group', async () => {
    const j = judge({ clump: choice('new'), 'mate_bro-bb2': noul(0.1) });
    const b = backlog([row(ITEM), row('bro-bb2')]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'solo');
    assert.equal((res.payload as ClassifyPayload).group, 'solo');
    assert.deepEqual(b.added, []); // no self-named clump label
  });

  test('clump:solo / clump:new labels never collide with the sentinels', async () => {
    const j = judge({ clump: choice('solo') });
    const b = backlog([row(ITEM), row('bro-bb2', { labels: ['clump:new', 'clump:solo'] })]);
    await invoke(j, b);
    const criteria = j.calls[0].questions.clump;
    assert.equal(criteria?.type, 'choice');
    // exactly the two sentinels — a foreign 'new'/'solo' name is never
    // offered as a joinable group (the sentinel owns the key)
    assert.deepEqual(Object.keys(criteria.criteria).sort(), ['new', 'solo']);
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
    const j = judge({ clump: choice('new'), 'mate_bro-bb2': noul(0.9) });
    const b = backlog([
      row(ITEM, { labels: ['dup:bro-old', 'keep-me', 'clump:old'] }),
      row('bro-bb2'),
    ]);
    await invoke(j, b);
    assert.deepEqual(b.removed, [
      [ITEM, 'dup:bro-old'],
      [ITEM, 'clump:old'],
    ]);
    assert.deepEqual(b.added, [
      [ITEM, `${CLUMP_LABEL_PREFIX}${ITEM}`],
      ['bro-bb2', `${CLUMP_LABEL_PREFIX}${ITEM}`],
    ]);
    // one ordered log proves removals land BEFORE the adds — the
    // remove-then-add contract separate added/removed lists can't show
    assert.deepEqual(
      b.events.map(e => e[0]),
      ['-', '-', '+', '+']
    );
  });

  test('labels: false → decide still runs, nothing is written or removed', async () => {
    const j = judge({ dup_of: choice('bro-bb2') });
    const b = backlog([row(ITEM, { labels: ['dup:stale'] }), row('bro-bb2')]);
    const res = await invoke(j, b, { labels: false });
    assert.equal(res.verdict, 'duplicate');
    assert.deepEqual(b.added, []);
    assert.deepEqual(b.removed, []); // stale marks stay when labels are off
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
    /** the ready queue is a SUBSET of open rows — membership lives in
     *  readyIds, so the mock can't fake it with a status filter */
    readyIds: new Set<string>(),
    updates: [] as [string, Record<string, string | number>][],
    get(id: string) {
      return this.rows.find(r => r.id === id);
    },
    ready() {
      return this.rows.filter(r => this.readyIds.has(r.id));
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

  test('peers: ready queue first, then open ∪ in_progress — deduped, item excluded', () => {
    store.rows = [
      row(ITEM),
      row('c', { status: 'open' }), // open, NOT in the ready queue
      row('a', { status: 'open' }), // ready — listed after 'c', so order proves the tier
      row('b', { status: 'in_progress' }),
      row('d', { status: 'closed' }),
    ];
    store.readyIds = new Set(['a']);
    const b = taskBacklog(store as never);
    // 'a' leads (ready tier) though 'c' precedes it in the open listing;
    // 'a' is not re-emitted by the open tier (dedup); 'd' is closed — out
    assert.deepEqual(
      b.peers(row(ITEM)).map(r => r.id),
      ['a', 'c', 'b']
    );
  });

  test('the cap is taken by affinity — a likely duplicate is never crowded out', () => {
    const item = row(ITEM, { title: 'pipeline dedup gate', parent: 'epic1' });
    const dup = row('dup', {
      status: 'in_progress',
      title: 'pipeline dedup gate',
      parent: 'epic1',
    });
    store.rows = [
      item,
      // a full queue of unrelated peers ahead of the duplicate —
      // position alone would cut it at any cap
      ...Array.from({ length: 10 }, (_, i) =>
        row(`u${i}`, { status: 'open', title: `unrelated work ${i}` })
      ),
      dup,
    ];
    store.readyIds = new Set(['u0']);
    const b = taskBacklog(store as never, { limit: 5 });
    const ids = b.peers(item).map(r => r.id);
    assert.equal(ids[0], 'dup'); // affinity beats queue position
    assert.equal(ids.length, 5); // still capped
  });
});

describe('stageDispatch — one judge slot, many stages', () => {
  test('dispatches on stage name; unbound stage throws loud', async () => {
    const j = judge({ clump: choice('solo') });
    const b = backlog([row(ITEM)]);
    const h = stageDispatch(
      { classify: classifyStage({ judge: j.facade, backlog: b }) },
      DEFAULT_ADMIT_INTENTS
    );
    const res = settled(await h.invoke(call()));
    assert.equal(res.verdict, 'solo');
    const routeCall = { ...call(), stage: FORMULA.stages[1] };
    await assert.rejects(async () => h.invoke(routeCall), /no engine bound for stage "route"/);
  });

  test('missing recheck hook: read intent → "didn\'t land", spawn-like → pending park', async () => {
    const h = stageDispatch(
      {
        classify: () => ({ verdict: 'solo' }),
        work: () => ({ verdict: 'done' }),
      },
      DEFAULT_ADMIT_INTENTS
    );
    const workStage = FORMULA.stages.find(s => s.engine === 'fleet');
    assert.ok(workStage !== undefined);
    const judgeCall = { ...call(), stage: FORMULA.stages[0] };
    const spawnCall = { ...call(), stage: workStage };
    // judge intent: undefined attests "didn't land" → bounded re-fire
    assert.equal(await h.recheck?.(judgeCall), undefined);
    // spawn intent: 'pending' parks — never a blind respawn through
    // the always-bound wrapper
    assert.equal(await h.recheck?.(spawnCall), 'pending');
    // the run's configured admit set is honored, not just the default —
    // declare 'judge' spawn-like and its recheck parks too
    const custom = stageDispatch({ classify: () => ({ verdict: 'solo' }) }, ['judge']);
    assert.equal(await custom.recheck?.(judgeCall), 'pending');
  });
});

describe('classify inside runPipeline — the payload feeds the gate', () => {
  test('cheap item: real classify engine → review.gate_on skips review', async () => {
    const j = judge({ clump: choice('solo'), complexity: choice('cheap') });
    const b = backlog([row(ITEM)]);
    let reviewCalls = 0;
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines: {
        judge: stageDispatch(
          {
            classify: classifyStage({ judge: j.facade, backlog: b }),
            route: () => ({ verdict: 'spawn' }),
            review: () => {
              reviewCalls += 1;
              return { verdict: 'push' };
            },
          },
          DEFAULT_ADMIT_INTENTS
        ),
        intake: () => ({ verdict: 'accepted' }),
        fleet: () => ({ verdict: 'done' }),
        e2e: () => ({ verdict: 'verified' }),
        accept: () => ({ verdict: 'accepted' }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });
    assert.equal(res.outcome, 'end'); // full run — merge → capture
    const p = res.ctx.classify as ClassifyPayload;
    assert.equal(p.group, 'solo');
    assert.equal(p.complexity, 'cheap');
    assert.equal(res.ctx.complexity, 'cheap'); // flat merge fed the gate
    assert.equal(reviewCalls, 0); // gate_on failed → synthesized skip, review never ran
    assert.equal(j.calls.length, 1); // one decide for the whole classification
  });
});
