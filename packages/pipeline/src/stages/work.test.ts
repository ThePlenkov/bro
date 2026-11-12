import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type AgentInfo, SpawnError } from '@broject/core';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from '../formula.ts';
import { type JournalRow, memoryJournal, type PipelineJournal } from '../journal.ts';
import {
  type EngineMap,
  type RunOptions,
  resumePipeline,
  runPipeline,
  SATURATION_ALERT,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { settled } from '../testkit.ts';
import { type FleetDeps, type FleetPayload, type FleetSpawnRequest, workStage } from './work.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
// by name, never by index — a stage-order change in SPEC_FORMULA must
// not silently re-point the call() helper at the wrong stage
const WORK_STAGE = FORMULA.stages.find(s => s.name === 'work');
if (WORK_STAGE === undefined) {
  throw new Error('SPEC_FORMULA lost its work stage');
}
const ITEM = 'bro-wk1';
const SHA = 'cafebabe';

/** A worker observation — the connector's AgentInfo shape, scripted
 *  per test. */
const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'ag-1',
  molStep: ITEM,
  backend: 'native',
  state: 'running',
  ...over,
});

interface SpawnSpy {
  calls: { call: StageCall; req: FleetSpawnRequest }[];
  fn: FleetDeps['spawn'];
}

/** A scripted spawn seam — records every (call, request) and answers
 *  an AgentInfo, a function of the request, or throws the given
 *  error (SpawnError refusals included). */
const spawnSpy = (
  script: AgentInfo | ((req: FleetSpawnRequest) => AgentInfo) | Error = agent({
    state: 'spawned',
  })
): SpawnSpy => {
  const calls: SpawnSpy['calls'] = [];
  return {
    calls,
    fn: async (call, req) => {
      calls.push({ call, req });
      if (script instanceof Error) {
        throw script;
      }
      return typeof script === 'function' ? script(req) : script;
    },
  };
};

interface ObserveSpy {
  calls: StageCall[];
  fn: FleetDeps['observe'];
}

/** A scripted observe seam — a queue (the last answer sticks), a
 *  constant, or a function of the call. */
const observeSpy = (
  script:
    | AgentInfo
    | undefined
    | readonly (AgentInfo | undefined)[]
    | ((call: StageCall) => AgentInfo | undefined)
): ObserveSpy => {
  const calls: StageCall[] = [];
  let i = 0;
  return {
    calls,
    fn: async call => {
      calls.push(call);
      if (typeof script === 'function') {
        return script(call);
      }
      if (Array.isArray(script)) {
        return script[Math.min(i++, script.length - 1)];
      }
      return script;
    },
  };
};

const deps = (
  spawn: FleetDeps['spawn'],
  observe: FleetDeps['observe'],
  over: Partial<FleetDeps> = {}
): FleetDeps => ({ spawn, observe, ...over });

const call = (over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: WORK_STAGE,
    attempt: 1,
    ctx: {},
    journal: memoryJournal(),
    ...over,
  }) as StageCall;

const invoke = async (d: FleetDeps, over: Partial<StageCall> = {}) =>
  workStage(d).invoke(call(over));
const recheck = async (d: FleetDeps, over: Partial<StageCall> = {}) =>
  workStage(d).recheck?.(call(over));

/** One settled journal row — the run_id/item/stage/intent skeleton
 *  every row carries; formula_sha feeds the provenance fallback. */
const journalRow = (over: Partial<JournalRow>): JournalRow => ({
  run_id: 'r1',
  item: ITEM,
  seq: 1,
  stage: 'route',
  intent: 'judge',
  attempt: 1,
  formula_sha: SHA,
  ts: '2026-01-01T00:00:00Z',
  ...over,
});

describe('work — the spawn request', () => {
  test('invoke fires the spawn — item as molStep, batch lane, route ctx fields', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    const jn = memoryJournal();
    const res = await invoke(deps(sp.fn, ob.fn), {
      ctx: {
        provider: 'p1',
        model: 'm1',
        class: 'default',
        kind: 'devin',
        orch: 'exec',
        timing: 'now',
      },
      journal: jn,
    });
    assert.equal(res, 'pending'); // live worker — the intent stays the anchor
    assert.equal(sp.calls.length, 1);
    assert.equal(sp.calls[0].call.item, ITEM);
    assert.equal(sp.calls[0].call.journal, jn); // the seam sees the call
    const req = sp.calls[0].req;
    assert.equal(req.molStep, ITEM);
    assert.equal(req.lane, 'batch');
    assert.equal(req.provider, 'p1');
    assert.equal(req.model, 'm1');
    assert.equal(req.class, 'default');
    assert.equal(req.kind, 'devin');
    assert.equal(req.orch, 'exec');
    assert.equal(req.fixRound, undefined);
    assert.equal(req.notes, undefined);
  });

  test('fix scope rides the request on a scoped re-entry', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    await invoke(deps(sp.fn, ob.fn), { fixRound: 2, notes: 'fix the failing AC' });
    const req = sp.calls[0].req;
    assert.equal(req.fixRound, 2);
    assert.equal(req.notes, 'fix the failing AC');
  });

  test('pipeline provenance — deps identity + journaled sha + stage name', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    const jn = memoryJournal('r1');
    jn.append(journalRow({ verdict: 'spawn', payload: { class: 'default' } }));
    await invoke(deps(sp.fn, ob.fn, { pipeline: { formula: 'spec.toml', sessionId: 'sess-1' } }), {
      journal: jn,
    });
    assert.deepEqual(sp.calls[0].req.pipeline, {
      formula: 'spec.toml',
      formulaSha: SHA, // the journaled run sha — deps carried none
      stage: 'work',
      sessionId: 'sess-1',
    });
  });

  test('deps.formulaSha wins over the journaled sha', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    const jn = memoryJournal('r1');
    jn.append(journalRow({ formula_sha: 'journaled-sha' }));
    await invoke(
      deps(sp.fn, ob.fn, { pipeline: { formula: 'spec.toml', formulaSha: 'dep-sha' } }),
      { journal: jn }
    );
    assert.equal(sp.calls[0].req.pipeline?.formulaSha, 'dep-sha');
  });

  test('no deps.pipeline → no provenance — never fabricated', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    const jn = memoryJournal('r1');
    jn.append(journalRow({}));
    await invoke(deps(sp.fn, ob.fn), { journal: jn });
    assert.equal(sp.calls[0].req.pipeline, undefined);
  });

  test('non-string and non-vocabulary ctx values never reach the request', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    await invoke(deps(sp.fn, ob.fn), {
      ctx: { provider: 42, model: '', orch: 'bogus', kind: 'devin' },
    });
    const req = sp.calls[0].req;
    assert.equal(req.provider, undefined);
    assert.equal(req.model, undefined);
    assert.equal(req.orch, undefined); // outside acp|foreground|exec
    assert.equal(req.kind, 'devin');
  });

  test('deps.lane overrides the batch default', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    await invoke(deps(sp.fn, ob.fn, { lane: 'interactive' }));
    assert.equal(sp.calls[0].req.lane, 'interactive');
  });
});

describe('work — exit taxonomy', () => {
  const CASES: [string, AgentInfo, string][] = [
    ['ok', agent({ state: 'exited', cause: 'ok' }), 'done'],
    [
      'rate_limited',
      agent({ state: 'exited', cause: 'rate_limited', resetAt: '2026-01-01T01:00:00Z' }),
      'rate_limited',
    ],
    ['quota rides rate_limited', agent({ state: 'blocked', cause: 'quota' }), 'rate_limited'],
    ['blocked reads by cause', agent({ state: 'blocked', cause: 'rate_limited' }), 'rate_limited'],
    ['crash', agent({ state: 'exited', cause: 'crash' }), 'crash'],
    ['auth is a worker-side failure', agent({ state: 'exited', cause: 'auth' }), 'crash'],
    ['unclassified exit', agent({ state: 'exited' }), 'crash'],
    ['stopped', agent({ state: 'stopped' }), 'stopped'],
    ['lost — dead with no record', agent({ state: 'lost' }), 'crash'],
  ];
  for (const [name, obs, verdict] of CASES) {
    test(`${name} → ${verdict} — settles in the same wake`, async () => {
      const sp = spawnSpy(agent({ state: 'spawned' }));
      const ob = observeSpy(obs);
      const res = settled(await invoke(deps(sp.fn, ob.fn)));
      assert.equal(res.verdict, verdict);
      assert.equal(ob.calls.length, 1); // one post-spawn read
    });
  }

  test('a live worker answers pending — the spawn intent stays the anchor', async () => {
    for (const state of ['spawned', 'running'] as const) {
      const res = await invoke(
        deps(spawnSpy(agent({ state: 'spawned' })).fn, observeSpy(agent({ state })).fn)
      );
      assert.equal(res, 'pending');
    }
  });

  test('the post-spawn read must be this attempt — a stale generation cannot settle', async () => {
    // spawn minted runId r2; the registry still answers the previous
    // attempt's terminal entry (runId r1) — settling on it would mark
    // unexecuted work done, so invoke falls back to the spawn's own
    // 'spawned' AgentInfo → pending
    const sp = spawnSpy(agent({ state: 'spawned', runId: 'r2' }));
    const ob = observeSpy(agent({ state: 'exited', cause: 'ok', runId: 'r1' }));
    const res = await invoke(deps(sp.fn, ob.fn));
    assert.equal(res, 'pending');
    // same generation reads through — an instant death still settles
    const sp2 = spawnSpy(agent({ state: 'spawned', runId: 'r2' }));
    const ob2 = observeSpy(agent({ state: 'exited', cause: 'ok', runId: 'r2' }));
    const res2 = settled(await invoke(deps(sp2.fn, ob2.fn)));
    assert.equal(res2.verdict, 'done');
  });

  test('done carries nested worker provenance + diff — never flat route keys', async () => {
    const obs = agent({
      state: 'exited',
      cause: 'ok',
      provider: 'p1',
      model: 'm1',
      class: 'default',
      worktree: '/wt/x',
    });
    const diffCalls: AgentInfo[] = [];
    const res = settled(
      await invoke(
        deps(spawnSpy().fn, observeSpy(obs).fn, {
          diff: async (_c, w) => {
            diffCalls.push(w);
            return { files: ['src/a.ts'], base: 'main', head: 'abc123', worktree: '/wt/x' };
          },
        })
      )
    );
    assert.equal(res.verdict, 'done');
    const p = res.payload as FleetPayload;
    assert.deepEqual(p.worker, {
      agentId: 'ag-1',
      backend: 'native',
      provider: 'p1',
      model: 'm1',
      class: 'default',
    });
    assert.equal(p.worktree, '/wt/x');
    assert.equal(p.cause, 'ok');
    // flat provider/model/class keys stay route's — the worker's
    // provenance is nested only
    assert.equal('provider' in p, false);
    assert.equal('model' in p, false);
    assert.equal('class' in p, false);
    assert.deepEqual(p.diff, {
      files: ['src/a.ts'],
      base: 'main',
      head: 'abc123',
      worktree: '/wt/x',
    });
    assert.equal(diffCalls[0], obs); // the diff seam saw the observation
  });

  test('non-done verdicts carry no diff — partial work is not evidence', async () => {
    let diffCalls = 0;
    const res = settled(
      await invoke(
        deps(spawnSpy().fn, observeSpy(agent({ state: 'exited', cause: 'crash' })).fn, {
          diff: async () => {
            diffCalls++;
            return { files: ['a.ts'] };
          },
        })
      )
    );
    assert.equal(res.verdict, 'crash');
    assert.equal(diffCalls, 0);
    assert.equal((res.payload as FleetPayload).diff, undefined);
  });

  test('rate_limited carries the provider reset; a done with no diff seam journals none', async () => {
    const res = settled(
      await invoke(
        deps(
          spawnSpy().fn,
          observeSpy(
            agent({
              state: 'exited',
              cause: 'rate_limited',
              resetAt: '2026-01-01T01:00:00Z',
            })
          ).fn
        )
      )
    );
    const p = res.payload as FleetPayload;
    assert.equal(res.verdict, 'rate_limited');
    assert.equal(p.cause, 'rate_limited');
    assert.equal(p.resetAt, '2026-01-01T01:00:00Z');
    const done = settled(
      await invoke(deps(spawnSpy().fn, observeSpy(agent({ state: 'exited', cause: 'ok' })).fn))
    );
    assert.equal((done.payload as FleetPayload).diff, undefined);
  });
});

describe('work — spawn refusals', () => {
  test('SpawnError cap → the capacity-wait park — never a verdict, never rate_limited', async () => {
    const res = await invoke(
      deps(spawnSpy(new SpawnError('fleet at maxConcurrent', 'cap')).fn, observeSpy(undefined).fn)
    );
    assert.deepEqual(res, { alert: SATURATION_ALERT, detail: 'fleet at maxConcurrent' });
  });

  test('SpawnError conflict + a live worker → pending — attach to the owner', async () => {
    const sp = spawnSpy(new SpawnError('already running', 'conflict'));
    const ob = observeSpy(agent({ state: 'running' }));
    const res = await invoke(deps(sp.fn, ob.fn));
    assert.equal(res, 'pending');
    assert.equal(ob.calls.length, 1); // the refusal consulted the world
  });

  test('SpawnError conflict with no live worker → throws — a real conflict', async () => {
    for (const obs of [
      undefined,
      agent({ state: 'exited', cause: 'ok' }),
      agent({ state: 'lost' }),
    ]) {
      await assert.rejects(
        () =>
          invoke(
            deps(spawnSpy(new SpawnError('claim refused', 'conflict')).fn, observeSpy(obs).fn)
          ),
        /claim refused/
      );
    }
  });

  test('input/config/unavailable refusals and plain throws propagate — the crash marker', async () => {
    for (const kind of ['input', 'config', 'unavailable'] as const) {
      await assert.rejects(
        () =>
          invoke(
            deps(
              spawnSpy(new SpawnError(`spawn ${kind} refused`, kind)).fn,
              observeSpy(undefined).fn
            )
          ),
        new RegExp(`spawn ${kind} refused`)
      );
    }
    await assert.rejects(
      () => invoke(deps(spawnSpy(new Error('connector down')).fn, observeSpy(undefined).fn)),
      /connector down/
    );
  });
});

describe('work — recheck', () => {
  test('no worker → undefined — the bounded refire attestation', async () => {
    const res = await recheck(deps(spawnSpy().fn, observeSpy(undefined).fn));
    assert.equal(res, undefined);
  });

  test('a live worker → pending — the intent stays the anchor', async () => {
    const res = await recheck(deps(spawnSpy().fn, observeSpy(agent({ state: 'running' })).fn));
    assert.equal(res, 'pending');
  });

  test('a terminal worker settles the pending record — verdict + payload', async () => {
    const obs = agent({ state: 'exited', cause: 'ok', worktree: '/wt/x' });
    const out = await recheck(
      deps(spawnSpy().fn, observeSpy(obs).fn, {
        diff: async () => ({ files: ['src/a.ts'], head: 'h1' }),
      })
    );
    assert.ok(out !== undefined);
    const res = settled(out);
    assert.equal(res.verdict, 'done');
    const p = res.payload as FleetPayload;
    assert.equal(p.cause, 'ok');
    assert.deepEqual(p.diff, { files: ['src/a.ts'], head: 'h1' });
  });

  test('an observation for another step throws — never settle on foreign work', async () => {
    await assert.rejects(
      () =>
        invoke(
          deps(
            spawnSpy().fn,
            observeSpy(agent({ state: 'exited', cause: 'ok', molStep: 'bro-other' })).fn
          )
        ),
      /for step "bro-other", not "bro-wk1"/
    );
  });
});

describe('work inside runPipeline — the spec DAG', () => {
  /** The upstream/downstream engines stubbed around the real work
   *  stage: classify solo-cheap (the review gate skips), route
   *  spawns with routing fields, intake accepts, verify verified,
   *  review skipped by gate, accept accepts, merge lands, capture
   *  captures. */
  const dagEngines = (d: FleetDeps): EngineMap => ({
    judge: {
      invoke: c =>
        c.stage.name === 'classify'
          ? { verdict: 'solo', payload: { group: 'solo', complexity: 'cheap', rank: 1 } }
          : c.stage.name === 'route'
            ? {
                verdict: 'spawn',
                payload: {
                  class: 'default',
                  kind: 'k',
                  orch: 'exec',
                  timing: 'now',
                  provider: 'p1',
                  model: 'm1',
                },
              }
            : { verdict: 'push', payload: { notes: 'ok' } },
    },
    intake: () => ({ verdict: 'accepted' }),
    fleet: workStage(d),
    e2e: () => ({ verdict: 'verified' }),
    accept: () => ({ verdict: 'accepted' }),
    'act-gate': () => ({ verdict: 'landed' }),
    learn: () => ({ verdict: 'captured' }),
  });

  const runOpts = (
    d: FleetDeps,
    journal: PipelineJournal,
    over: Partial<RunOptions> = {}
  ): RunOptions => ({
    formulaSha: SHA,
    journal,
    admit: () => true, // the fleet spawn intent needs the go-marker
    engines: dagEngines(d),
    ...over,
  });

  test('spawn in flight → pending park — the verdict-less intent is the anchor', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy([agent({ state: 'running' })]);
    const jn = memoryJournal('r1');
    const res = await runPipeline(FORMULA, ITEM, runOpts(deps(sp.fn, ob.fn), jn));
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'work');
    assert.equal(sp.calls.length, 1);
    const rows = jn.rows().filter(r => r.stage === 'work');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].intent, 'spawn');
    assert.equal(rows[0].verdict, undefined); // pending — no verdict row
    // the routing fields reached the spawn through ctx
    assert.equal(sp.calls[0].req.provider, 'p1');
    assert.equal(sp.calls[0].req.model, 'm1');
  });

  test('resume: recheck observes the exit → done → end — spawn fired once, diff journaled', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy([
      agent({ state: 'running' }), // invoke's post-spawn read
      agent({ state: 'exited', cause: 'ok', worktree: '/wt/x', provider: 'p1' }), // recheck
    ]);
    const d = deps(sp.fn, ob.fn, {
      diff: async () => ({ files: ['src/a.ts'], base: 'main', head: 'h1', worktree: '/wt/x' }),
      pipeline: { formula: 'spec.toml' },
    });
    const jn = memoryJournal('r1');
    const parked = await runPipeline(FORMULA, ITEM, runOpts(d, jn));
    assert.equal(parked.outcome, 'park');
    const res = await resumePipeline(FORMULA, ITEM, jn, runOpts(d, jn));
    assert.equal(res.outcome, 'end');
    assert.equal(sp.calls.length, 1); // recheck never re-fires
    assert.equal(ob.calls.length, 2); // one per wake
    // the verdict row completes the intent with the work payload
    const done = jn.rows().filter(r => r.stage === 'work' && r.verdict === 'done');
    assert.equal(done.length, 1);
    const p = done[0].payload as FleetPayload;
    assert.equal(p.cause, 'ok');
    assert.equal(p.worktree, '/wt/x');
    assert.deepEqual(p.diff, {
      files: ['src/a.ts'],
      base: 'main',
      head: 'h1',
      worktree: '/wt/x',
    });
    assert.equal(p.worker?.agentId, 'ag-1');
    // the spawn carried provenance — journaled sha resolved, stage 'work'
    assert.equal(sp.calls[0].req.pipeline?.formulaSha, SHA);
    assert.equal(sp.calls[0].req.pipeline?.stage, 'work');
  });

  test('admit refusal settles the stage without firing the spawn', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(agent({ state: 'running' }));
    const admitCalls: StageCall[] = [];
    let refused = false;
    const jn = memoryJournal('r1');
    const res = await runPipeline(
      FORMULA,
      ITEM,
      runOpts(deps(sp.fn, ob.fn), jn, {
        admit: c => {
          admitCalls.push(c);
          if (!refused) {
            refused = true;
            return { verdict: 'rate_limited', payload: { reason: 'go-marker' } };
          }
          return true;
        },
      })
    );
    assert.equal(res.outcome, 'park'); // pending on the admitted spawn
    assert.equal(admitCalls.length, 2); // one per spawn intent
    assert.equal(sp.calls.length, 1); // fired only after admission
    const refusal = jn.rows().filter(r => r.stage === 'work' && r.verdict === 'rate_limited');
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0].admit, true); // refusal detail never enters ctx
  });

  test('a verdict-less spawn intent with no worker re-fires bounded on resume', async () => {
    const sp = spawnSpy(agent({ state: 'spawned' }));
    const ob = observeSpy(undefined); // the spawn "never landed" — every read misses
    const jn = memoryJournal('r1');
    // seed the crash window directly: work intent journaled, no verdict
    const base = {
      run_id: 'r1',
      item: ITEM,
      attempt: 1,
      formula_sha: SHA,
      ts: '2026-01-01T00:00:00Z',
    };
    jn.append({
      ...base,
      seq: 1,
      stage: 'classify',
      intent: 'judge',
      verdict: 'solo',
      payload: { group: 'solo', complexity: 'cheap', rank: 1 },
    });
    jn.append({
      ...base,
      seq: 2,
      stage: 'route',
      intent: 'judge',
      verdict: 'spawn',
      payload: { class: 'default', kind: 'k', orch: 'exec', timing: 'now' },
    });
    jn.append({ ...base, seq: 3, stage: 'intake', intent: 'spec', verdict: 'accepted' });
    jn.append({ ...base, seq: 4, stage: 'work', intent: 'spawn' }); // verdict-less
    const res = await resumePipeline(FORMULA, ITEM, jn, runOpts(deps(sp.fn, ob.fn), jn));
    // recheck attested "didn't land" → bounded refire attempt 2 →
    // spawn fires → post-spawn observe ALSO undefined → falls back to
    // the spawn's own AgentInfo (spawned → pending) → park again
    assert.equal(res.outcome, 'park');
    assert.equal(sp.calls.length, 1);
    const intents = jn.rows().filter(r => r.stage === 'work' && r.intent === 'spawn');
    assert.equal(intents.length, 2); // the original + the refire
    assert.equal(intents[1].attempt, 2);
    assert.equal(intents[1].verdict, undefined);
  });
});
