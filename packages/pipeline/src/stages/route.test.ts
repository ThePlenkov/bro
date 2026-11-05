import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import type { ProviderEntry, RoutingTable } from '@broject/core';
import { CLASS_LABEL_PREFIX } from '@broject/core';
import { parsePipelineFormula } from '../formula.ts';
import { memoryJournal, type JournalRow, type PipelineJournal } from '../journal.ts';
import {
  DEFAULT_ADMIT_INTENTS,
  runPipeline,
  type EngineHandler,
  type RunOptions,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { backlog, choice, judge, noul, row, type JudgeSpy } from '../testkit.ts';
import { stageDispatch } from './classify.ts';
import {
  QUEUE_REASONS,
  routeStage,
  type RouteBacklog,
  type RouteDeps,
  type RoutePayload,
} from './route.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const ROUTE_STAGE = FORMULA.stages[1];
const ITEM = 'bro-aa1';
const SHA = 'deadbeef';

/** Test providers — acp/cli both carry the spawn surface. */
const PROVIDERS: Record<string, ProviderEntry> = {
  pa: { type: 'acp', command: 'pa' },
  pb: { type: 'cli', command: 'pb' },
  pc: { type: 'acp', command: 'pc' },
};

/** Three lanes: default (one entry, fallthrough), feature (two
 *  entries, park), sweep (two entries, priority-derived policy). */
const ROUTING: RoutingTable = {
  default: { chain: [{ provider: 'pa' }], onWall: 'fallthrough' },
  feature: {
    chain: [{ provider: 'pa', model: 'm1' }, { provider: 'pb' }],
    onWall: 'park',
  },
  sweep: { chain: [{ provider: 'pb' }, { provider: 'pc', model: 'm2' }] },
};

const call = (item = ITEM, journal?: PipelineJournal): StageCall =>
  ({
    runId: 'r1',
    item,
    stage: ROUTE_STAGE,
    attempt: 1,
    ctx: {},
    journal: journal ?? memoryJournal(),
  }) as StageCall;

const deps = (j: JudgeSpy, b: RouteBacklog, extra: Partial<RouteDeps> = {}): RouteDeps => ({
  judge: j.facade,
  backlog: b,
  routing: ROUTING,
  providers: PROVIDERS,
  kinds: ['devin', 'ts-package'],
  ...extra,
});

const invoke = async (
  j: JudgeSpy,
  b: RouteBacklog,
  extra: Partial<RouteDeps> = {},
  journal?: PipelineJournal
) => routeStage(deps(j, b, extra)).invoke(call(ITEM, journal));

const jrow = (r: Partial<JournalRow> & Pick<JournalRow, 'seq' | 'stage'>): JournalRow => ({
  run_id: 'r1',
  item: ITEM,
  intent: 'judge',
  attempt: 1,
  formula_sha: SHA,
  ts: '2026-11-04T00:00:00Z',
  ...r,
});

/** A journal replaying `route → spawn(pX) → work rate_limited` — the
 *  wall re-entry shape the runner's journal carries when a work death
 *  sends the run back through route. The trailing pending route
 *  intent is the live one the engine fires under. */
const wallJournal = (
  prevPayload: Record<string, unknown>,
  extra: JournalRow[] = []
): PipelineJournal => {
  const j = memoryJournal('r1');
  j.append(jrow({ seq: 1, stage: 'route', verdict: 'spawn', payload: prevPayload }));
  j.append(jrow({ seq: 2, stage: 'work', intent: 'spawn', verdict: 'rate_limited' }));
  for (const r of extra) {
    j.append(r);
  }
  j.append(jrow({ seq: 9, stage: 'route' })); // the live pending intent
  return j;
};

describe('route — the decide', () => {
  test('confident picks → spawn carrying class/kind/orch/timing + resolved provider/model', async () => {
    const j = judge({
      class: choice('feature'),
      kind: choice('devin'),
      orch: choice('acp'),
      timing: choice('now'),
    });
    const b = backlog([row(ITEM)]);
    const res = await invoke(j, b);
    assert.equal(res.verdict, 'spawn');
    const p = res.payload as RoutePayload;
    assert.deepEqual(
      {
        class: p.class,
        kind: p.kind,
        orch: p.orch,
        timing: p.timing,
        provider: p.provider,
        model: p.model,
      },
      {
        class: 'feature',
        kind: 'devin',
        orch: 'acp',
        timing: 'now',
        provider: 'pa',
        model: 'm1', // the class's chain head — judge picks the lane, never the provider
      }
    );
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}feature`]]);
  });

  test('the class question offers exactly the declared lanes, described by their chains', async () => {
    const j = judge({});
    await invoke(j, backlog([row(ITEM)]));
    const q = j.calls[0].questions.class;
    assert.equal(q?.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria).sort(), ['default', 'feature', 'sweep']);
    assert.match(String(q.criteria.feature), /pa\(m1\) → pb/);
  });

  test('kind is asked only when kinds are declared — undeclared set skips the question', async () => {
    const j = judge({});
    const res = await invoke(j, backlog([row(ITEM)]), { kinds: undefined });
    assert.equal(j.calls[0].questions.kind, undefined);
    assert.equal((res.payload as RoutePayload).kind, 'default');
  });

  test('the load signal + walled providers ride the decide state', async () => {
    const j = judge({});
    await invoke(j, backlog([row(ITEM)]), {
      occupancy: () => ({ live: 3, cap: 5 }),
      walls: () => [{ provider: 'pb', cause: 'rate_limited' }],
    });
    const state = j.calls[0].state as {
      load: { live: number; cap: number };
      walledProviders: { provider: string }[];
    };
    assert.deepEqual(state.load, { live: 3, cap: 5 });
    assert.deepEqual(state.walledProviders, [{ provider: 'pb', cause: 'rate_limited' }]);
  });
});

describe('route — the pick', () => {
  test('unanswered class → the default lane; unanswered orch → the exec default', async () => {
    const j = judge({ kind: choice('ts-package') });
    const res = await invoke(j, backlog([row(ITEM)]));
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'spawn');
    assert.equal(p.class, 'default');
    assert.equal(p.kind, 'ts-package');
    assert.equal(p.orch, 'exec');
    assert.equal(p.provider, 'pa');
    assert.equal(p.model, undefined);
  });

  test('a confident class naming an undeclared lane is malformed — default resolves', async () => {
    const j = judge({ class: choice('nonexistent') });
    const res = await invoke(j, backlog([row(ITEM)]));
    assert.equal((res.payload as RoutePayload).class, 'default');
  });

  test('a dimmed class is dropped for that question — lowConfidence still journals', async () => {
    const j = judge({ class: choice('feature', 0.2) }, ['class']);
    const res = await invoke(j, backlog([row(ITEM)]));
    const p = res.payload as RoutePayload;
    assert.equal(p.class, 'default');
    assert.deepEqual(p.lowConfidence, ['class']);
  });

  test('a kind pick outside the declared kinds falls to the first declared', async () => {
    const j = judge({ kind: choice('bogus-kind') });
    const res = await invoke(j, backlog([row(ITEM)]));
    assert.equal((res.payload as RoutePayload).kind, 'devin');
  });
});

describe('route — verdicts', () => {
  test('a confident timing "queue" parks with reason "timing" — the lane still resolves', async () => {
    const j = judge({ class: choice('sweep'), timing: choice('queue') });
    const b = backlog([row(ITEM)]);
    const res = await invoke(j, b);
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.timing, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.timing);
    assert.equal(p.provider, 'pb'); // the would-be target rides the payload
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}sweep`]]);
  });

  test('occupancy saturation parks with reason "saturated" even when the judge says now', async () => {
    const j = judge({ timing: choice('now') });
    const res = await invoke(j, backlog([row(ITEM)]), {
      occupancy: () => ({ live: 4, cap: 4 }),
    });
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.saturated);
  });

  test('cap 0 is uncapped — never saturates', async () => {
    const j = judge({ timing: choice('now') });
    const res = await invoke(j, backlog([row(ITEM)]), {
      occupancy: () => ({ live: 99, cap: 0 }),
    });
    assert.equal(res.verdict, 'spawn');
  });

  test('an affirmed defer is an operator verdict → park, label still written', async () => {
    const j = judge({ class: choice('feature'), defer: noul(0.9) });
    const b = backlog([row(ITEM)]);
    const res = await invoke(j, b);
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'defer');
    assert.equal(p.timing, 'queue');
    assert.equal(p.class, 'feature'); // the judged lane still records where it WOULD run
    assert.equal(p.provider, 'pa'); // …and so does the resolved slot
    assert.equal(p.model, 'm1');
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}feature`]]);
  });

  test('a dimmed defer does not park the item', async () => {
    const j = judge({ defer: noul(0.9, 0.1), timing: choice('now') }, ['defer']);
    const res = await invoke(j, backlog([row(ITEM)]));
    assert.equal(res.verdict, 'spawn');
  });
});

describe('route — walls on the fresh path', () => {
  const wallsOf = (...providers: string[]) =>
    providers.map(p => ({ provider: p, cause: 'rate_limited' as const }));

  test('onWall "park" + walled chain head → queue reason "onwall"', async () => {
    const j = judge({ class: choice('feature'), timing: choice('now') });
    const res = await invoke(j, backlog([row(ITEM)]), { walls: () => wallsOf('pa') });
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.onwall);
  });

  test('onWall "fallthrough" skips the walled head → spawn the next entry', async () => {
    const j = judge({ class: choice('sweep'), timing: choice('now') });
    // priority 3 → derived onWall is 'fallthrough' (P2+ default)
    const res = await invoke(j, backlog([row(ITEM, { priority: 3 })]), {
      walls: () => wallsOf('pb'),
    });
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'spawn');
    assert.equal(p.provider, 'pc');
    assert.equal(p.model, 'm2');
  });

  test('fallthrough with every entry walled → queue reason "chain-spent"', async () => {
    const j = judge({ class: choice('sweep'), timing: choice('now') });
    const res = await invoke(j, backlog([row(ITEM, { priority: 3 })]), {
      walls: () => wallsOf('pb', 'pc'),
    });
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.chainSpent);
  });
});

describe('route — wall re-entry (work.rate_limited → route)', () => {
  const prevSpawn = {
    class: 'sweep',
    kind: 'devin',
    orch: 'acp' as const,
    timing: 'now' as const,
    provider: 'pb',
  };

  test('onWall "park" → queue reason "onwall"; the judge is NEVER called again', async () => {
    const j = judge({});
    const b = backlog([row(ITEM, { priority: 1 })]); // P1 → derived onWall 'park'
    const res = await invoke(j, b, {}, wallJournal(prevSpawn));
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.onwall);
    assert.equal(p.class, 'sweep'); // journaled fields stand
    assert.equal(p.kind, 'devin');
    assert.equal(p.orch, 'acp');
    assert.equal(p.provider, 'pb'); // the died-on slot the park waits out
    assert.deepEqual(p.wall, { provider: 'pb', cause: 'rate_limited' });
    assert.equal(j.calls.length, 0); // deterministic — no decide on a wall
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}sweep`]]);
  });

  test('onWall "fallthrough" → spawn the NEXT chain entry, fields preserved', async () => {
    const j = judge({});
    const res = await invoke(j, backlog([row(ITEM, { priority: 3 })]), {}, wallJournal(prevSpawn));
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'spawn');
    assert.equal(p.provider, 'pc'); // chain[1] — the next provider in the chain
    assert.equal(p.model, 'm2');
    assert.equal(p.timing, 'now');
    assert.equal(p.class, 'sweep');
    assert.equal(p.kind, 'devin');
    assert.equal(p.orch, 'acp');
    assert.deepEqual(p.wall, { provider: 'pb', cause: 'rate_limited' });
    assert.equal(j.calls.length, 0);
  });

  test('fallthrough skips entries the walls seam still reports walled', async () => {
    const j = judge({});
    const res = await invoke(
      j,
      backlog([row(ITEM, { priority: 3 })]),
      {
        routing: { sweep: { chain: [{ provider: 'pa' }, { provider: 'pb' }, { provider: 'pc' }] } },
        walls: () => [{ provider: 'pb', cause: 'rate_limited' }],
      },
      wallJournal({ ...prevSpawn, class: 'sweep', provider: 'pa' })
    );
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'spawn');
    assert.equal(p.provider, 'pc'); // pb skipped — still walled
  });

  test('fallthrough on a spent chain → queue reason "chain-spent"', async () => {
    const j = judge({});
    const res = await invoke(
      j,
      backlog([row(ITEM, { priority: 3 })]),
      {},
      wallJournal({ ...prevSpawn, provider: 'pc', model: 'm2' }) // died on the LAST entry
    );
    const p = res.payload as RoutePayload;
    assert.equal(res.verdict, 'queue');
    assert.equal(p.reason, QUEUE_REASONS.chainSpent);
  });

  test('a queue wake with NO work death is NOT a wall re-entry — fresh decide runs', async () => {
    const j = judge({ class: choice('default'), timing: choice('now') });
    const j_ = memoryJournal('r1');
    j_.append(jrow({ seq: 1, stage: 'route', verdict: 'queue', payload: prevSpawn }));
    j_.append(jrow({ seq: 2, stage: 'route' })); // live intent after a capacity wake
    const res = await invoke(j, backlog([row(ITEM)]), {}, j_);
    assert.equal(res.verdict, 'spawn');
    assert.equal(j.calls.length, 1); // fresh decide fired
  });

  test('a journaled class that drifted out of the table is no anchor — fresh decide, no throw', async () => {
    const j = judge({ class: choice('default'), timing: choice('now') });
    const res = await invoke(
      j,
      backlog([row(ITEM)]),
      {},
      wallJournal({ ...prevSpawn, class: 'ghost-lane' })
    );
    assert.equal(res.verdict, 'spawn');
    assert.equal((res.payload as RoutePayload).class, 'default');
    assert.equal(j.calls.length, 1);
  });
});

describe('route — labels + edges', () => {
  test('re-routing removes stale class: marks before pinning the new lane', async () => {
    const j = judge({ class: choice('feature') });
    const b = backlog([row(ITEM, { labels: ['class:old', 'keep-me'] })]);
    await invoke(j, b);
    assert.deepEqual(b.removed, [[ITEM, 'class:old']]);
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}feature`]]);
  });

  test('the pin already standing → no writes', async () => {
    const j = judge({ class: choice('feature') });
    const b = backlog([row(ITEM, { labels: [`${CLASS_LABEL_PREFIX}feature`] })]);
    await invoke(j, b);
    assert.deepEqual(b.removed, []);
    assert.deepEqual(b.added, []);
  });

  test('labels: false → decide still runs, nothing is written or removed', async () => {
    const j = judge({ class: choice('feature') });
    const b = backlog([row(ITEM, { labels: ['class:stale'] })]);
    const res = await invoke(j, b, { labels: false });
    assert.equal(j.calls.length, 1); // the decide ran — labels gate writes, not routing
    assert.equal(res.verdict, 'spawn');
    assert.deepEqual(b.added, []);
    assert.deepEqual(b.removed, []);
  });

  test('missing item throws — a phantom is never routed', async () => {
    const j = judge({});
    await assert.rejects(() => invoke(j, backlog([])), /not in the backlog/);
  });

  test('empty routing throws — no declared lanes, no class', async () => {
    const j = judge({});
    await assert.rejects(
      () => invoke(j, backlog([row(ITEM)]), { routing: {} }),
      /routing is empty/
    );
  });

  test('a resolved class with no routing entry is a config error naming the class', async () => {
    const j = judge({});
    await assert.rejects(
      () =>
        invoke(j, backlog([row(ITEM)]), {
          routing: { feature: ROUTING.feature },
          providers: PROVIDERS,
        }),
      /fleet\.routing has no class "default"/
    );
  });

  test('an unknown chain provider is a config error naming class + key', async () => {
    const j = judge({ class: choice('feature') });
    await assert.rejects(
      () =>
        invoke(j, backlog([row(ITEM)]), {
          routing: { feature: { chain: [{ provider: 'ghost' }] } },
        }),
      /fleet\.routing\.feature\.chain\[0\]/
    );
  });
});

describe('route inside runPipeline — the full DAG', () => {
  const soloClassify = () => ({
    verdict: 'solo',
    payload: { group: 'solo', complexity: 'cheap', rank: 3 },
  });

  /** The judge-slot multiplexer for a spec-formula run — emulated
   *  classify, the real route stage under test, scripted review. */
  const dagJudge = (route: EngineHandler) =>
    stageDispatch(
      { classify: soloClassify, route, review: () => ({ verdict: 'push' }) },
      DEFAULT_ADMIT_INTENTS
    );

  const runDag = (engines: RunOptions['engines']) =>
    runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines,
    });

  test('classify → route(spawn) → work(rate_limited) → route(fallthrough) → work(done) → end', async () => {
    const j = judge({
      class: choice('sweep'),
      kind: choice('devin'),
      orch: choice('exec'),
      timing: choice('now'),
    });
    const b = backlog([row(ITEM, { priority: 3 })]);
    let workCalls = 0;
    // the wall goes up when the first spawn dies — before that, the
    // fresh route lands the chain head
    let wallUp = false;
    const res = await runDag({
      judge: dagJudge(
        routeStage(
          deps(j, b, {
            walls: () => (wallUp ? [{ provider: 'pb', cause: 'rate_limited' as const }] : []),
          })
        )
      ),
      fleet: () => {
        workCalls += 1;
        // first spawn dies on the wall; the re-routed one lands
        if (workCalls === 1) {
          wallUp = true;
          return { verdict: 'rate_limited' };
        }
        return { verdict: 'done' };
      },
      'act-gate': () => ({ verdict: 'landed' }),
      learn: () => ({ verdict: 'captured' }),
    });
    assert.equal(res.outcome, 'end');
    assert.equal(workCalls, 2);
    assert.equal(j.calls.length, 1); // ONE decide — the wall re-entry is deterministic
    const route = res.ctx.route as RoutePayload;
    assert.equal(route.provider, 'pc'); // fell through the walled pb
    assert.equal(route.model, 'm2');
    assert.equal(route.timing, 'now');
    assert.equal(res.ctx.class, 'sweep'); // flat-merged payload feeds ctx
    assert.deepEqual(b.added, [[ITEM, `${CLASS_LABEL_PREFIX}sweep`]]);
  });

  test('route defer → park; wake re-enters route and routes fresh', async () => {
    const j = judge({ defer: noul(0.9), class: choice('default') });
    const b = backlog([row(ITEM)]);
    const res = await runDag({
      judge: dagJudge(routeStage(deps(j, b))),
      fleet: () => ({ verdict: 'done' }),
      'act-gate': () => ({ verdict: 'landed' }),
      learn: () => ({ verdict: 'captured' }),
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'route');
    assert.equal(res.verdict, 'defer');
  });
});
