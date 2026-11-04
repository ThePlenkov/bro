import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type PipelineFormula, SKIP_VERDICT } from './formula.ts';
import { type JournalRow, journalRecords, memoryJournal, type PipelineJournal } from './journal.ts';
import {
  type EngineFn,
  type EngineMap,
  type EngineResult,
  PARK_ALERTS,
  type RecheckFn,
  type RunOptions,
  resumePipeline,
  runPipeline,
  type StageCall,
} from './runner.ts';

/** The spec's own 6-stage formula (specs/bro-7d5nb.md) — hand-built as
 *  the validated shape so the runner tests exercise the same graph the
 *  parser conformance test parses. */
const FORMULA: PipelineFormula = {
  kind: 'pipeline',
  version: 1,
  stages: [
    { name: 'classify', engine: 'judge', verdicts: ['solo', 'clump', 'duplicate', 'defer'] },
    { name: 'route', engine: 'judge', verdicts: ['spawn', 'queue', 'defer'] },
    { name: 'work', engine: 'fleet', verdicts: ['done', 'rate_limited', 'crash', 'stopped'] },
    {
      name: 'review',
      engine: 'judge',
      gate_on: { field: 'complexity', op: '==', value: 'complex' },
      verdicts: ['push', 'fix', 'abandon'],
    },
    { name: 'merge', engine: 'act-gate', verdicts: ['landed', 'blocked', 'dropped'] },
    { name: 'capture', engine: 'learn', mode: 'always-capture', verdicts: ['captured'] },
  ],
  transitions: {
    classify: { solo: 'route', clump: 'route', duplicate: 'close', defer: 'park' },
    route: { spawn: 'work', queue: 'park', defer: 'park' },
    work: { done: 'review', rate_limited: 'route', crash: 'retry', stopped: 'abandon' },
    review: { skip: 'merge', push: 'merge', fix: 'work', abandon: 'abandon' },
    merge: { landed: 'capture', blocked: 'retry', dropped: 'close' },
    capture: { captured: 'end' },
  },
};

const SHA = 'deadbeef';

interface Spy {
  calls: StageCall[];
  fn: EngineFn;
}

/** A scripted engine — answers each call with the next queued result;
 *  `calls` records every invocation for assertions. */
const spy = (results: (EngineResult | Error)[], calls: StageCall[] = []): Spy => ({
  calls,
  fn: async call => {
    calls.push(call);
    const next = results.shift();
    if (next === undefined) throw new Error(`scripted engine exhausted at ${call.stage.name}`);
    if (next instanceof Error) throw next;
    return next;
  },
});

const happyScript = (complexity = 'complex') => ({
  judge: spy([
    { verdict: 'solo', payload: { group: 'solo', complexity, rank: 1 } },
    {
      verdict: 'spawn',
      payload: { class: 'interactive', kind: 'ts', orch: 'foreground', timing: 'now' },
    },
    { verdict: 'push', payload: { notes: 'looks good' } },
  ]),
  fleet: spy([{ verdict: 'done', payload: { pr: 42 } }]),
  'act-gate': spy([{ verdict: 'landed' }]),
  learn: spy([{ verdict: 'captured', payload: { lessons: 0, followups: [] } }]),
});

/** Spy map → EngineMap. */
const emap = (e: Record<string, Spy>): EngineMap =>
  Object.fromEntries(Object.entries(e).map(([k, s]) => [k, s.fn])) as EngineMap;

const run = (engines: EngineMap, opts: Partial<RunOptions> = {}, journal = memoryJournal()) =>
  runPipeline(FORMULA, 'bro-7d5nb.2', { engines, journal, formulaSha: SHA, ...opts });

const records = (j: PipelineJournal): JournalRow[] => journalRecords(j.rows());

describe('runPipeline — happy path', () => {
  test('walks classify → route → work → review → merge → capture to end', async () => {
    const e = happyScript();
    const j = memoryJournal();
    const res = await run(emap(e), {}, j);
    assert.equal(res.outcome, 'end');
    assert.equal(res.stage, 'capture');
    assert.deepEqual(
      e.judge.calls.map(c => c.stage.name),
      ['classify', 'route', 'review']
    );
    assert.equal(e.fleet.calls.length, 1);
    const recs = records(j);
    assert.deepEqual(
      recs.map(r => [r.stage, r.verdict]),
      [
        ['classify', 'solo'],
        ['route', 'spawn'],
        ['work', 'done'],
        ['review', 'push'],
        ['merge', 'landed'],
        ['capture', 'captured'],
      ]
    );
    assert.ok(
      recs.every(r => r.run_id === res.runId && r.formula_sha === SHA && r.item === 'bro-7d5nb.2')
    );
  });

  test('payloads merge into the pipeline context — flat and stage-scoped', async () => {
    const e = happyScript();
    const res = await run(emap(e));
    const reviewCall = e.judge.calls[2];
    assert.equal(reviewCall.ctx.complexity, 'complex'); // flat merge
    assert.equal((reviewCall.ctx.classify as { rank: number }).rank, 1); // stage-scoped
    assert.equal((res.ctx.work as { pr: number }).pr, 42);
  });
});

describe('gate_on — three outcomes, fail closed', () => {
  test('cheap items synthesize skip — review engine never invoked', async () => {
    const e = happyScript('cheap');
    const j = memoryJournal();
    const res = await run(emap(e), {}, j);
    assert.equal(res.outcome, 'end');
    assert.equal(e.judge.calls.length, 2); // classify + route only — review skipped
    const skip = records(j).find(r => r.verdict === SKIP_VERDICT);
    assert.equal(skip?.stage, 'review');
    assert.equal(skip?.intent, 'gate');
    assert.equal(e['act-gate'].calls.length, 1); // review.skip → merge still ran
  });

  test('an absent gate field parks indeterminate — never fails open', async () => {
    const e = happyScript();
    e.judge = spy([
      { verdict: 'solo', payload: { group: 'solo', rank: 1 } }, // no complexity
      { verdict: 'spawn', payload: {} },
    ]);
    const res = await run(emap(e));
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.gateIndeterminate);
    assert.equal(res.stage, 'review');
    assert.equal(e.judge.calls.length, 2);
    assert.equal(e['act-gate'].calls.length, 0);
  });
});

describe('terminal actions', () => {
  test('duplicate → close (settled drop)', async () => {
    const e = happyScript();
    e.judge = spy([{ verdict: 'duplicate', payload: { group: 'duplicate' } }]);
    const res = await run(emap(e));
    assert.equal(res.outcome, 'close');
    assert.equal(res.stage, 'classify');
    assert.equal(res.verdict, 'duplicate');
  });

  test('stopped → abandon (failed drop)', async () => {
    const e = happyScript();
    e.fleet = spy([{ verdict: 'stopped' }]);
    const res = await run(emap(e));
    assert.equal(res.outcome, 'abandon');
    assert.equal(res.stage, 'work');
  });

  test('route defer → park; resume re-enters the same stage', async () => {
    const j = memoryJournal('r1');
    const e = happyScript();
    e.judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'defer', payload: {} },
    ]);
    const parked = await run(emap(e), { runId: 'r1' }, j);
    assert.equal(parked.outcome, 'park');
    assert.equal(parked.stage, 'route');
    // wake: the item re-enters the PARKED stage — route, not classify
    const judge2 = spy([{ verdict: 'spawn', payload: {} }, { verdict: 'push' }]);
    const res = await resumePipeline(FORMULA, 'bro-7d5nb.2', j, {
      engines: {
        judge: judge2.fn,
        fleet: e.fleet.fn,
        'act-gate': e['act-gate'].fn,
        learn: e.learn.fn,
      },
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'end');
    assert.equal(judge2.calls[0].stage.name, 'route'); // re-entered at the parked stage
  });
});

describe('retry — bounded same-stage attempts', () => {
  test('crash retries until the budget exhausts → park', async () => {
    const e = happyScript();
    e.fleet = spy([
      { verdict: 'crash' },
      { verdict: 'crash' },
      { verdict: 'crash' },
      { verdict: 'crash' },
    ]);
    const res = await run(emap(e));
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.attemptsExhausted);
    assert.equal(e.fleet.calls.length, 3); // default budget: 3 attempts
    assert.deepEqual(
      e.fleet.calls.map(c => c.attempt),
      [1, 2, 3]
    );
  });

  test('a crash that recovers inside the budget continues', async () => {
    const e = happyScript();
    e.fleet = spy([{ verdict: 'crash' }, { verdict: 'done', payload: { pr: 1 } }]);
    const res = await run(emap(e));
    assert.equal(res.outcome, 'end');
    assert.equal(e.fleet.calls.length, 2);
  });

  test('rate_limited re-enters route, not retry', async () => {
    const e = happyScript();
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
      { verdict: 'spawn', payload: {} }, // re-routed after the wall
      { verdict: 'push' },
    ]);
    e.fleet = spy([{ verdict: 'rate_limited' }, { verdict: 'done' }]);
    const res = await run({ ...emap(e), judge: judge.fn });
    assert.equal(res.outcome, 'end');
    assert.equal(judge.calls[2].stage.name, 'route');
  });
});

describe('scoped-fix mode — review.fix → work', () => {
  test('fix re-enters work with notes as scope; fix_round journaled', async () => {
    const j = memoryJournal();
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
      { verdict: 'fix', payload: { notes: 'repair the gate test' } },
      { verdict: 'push' },
    ]);
    const fleet = spy([{ verdict: 'done' }, { verdict: 'done' }]);
    const e: EngineMap = {
      judge: judge.fn,
      fleet: fleet.fn,
      'act-gate': spy([{ verdict: 'landed' }]).fn,
      learn: spy([{ verdict: 'captured' }]).fn,
    };
    const res = await run(e, {}, j);
    assert.equal(res.outcome, 'end');
    const fixCall = fleet.calls[1];
    assert.equal(fixCall.notes, 'repair the gate test');
    assert.equal(fixCall.fixRound, 1);
    assert.equal(fixCall.attempt, 1); // a fresh entry, not a retry
    const fixIntent = j
      .rows()
      .find(r => r.stage === 'work' && r.fix_round === 1 && r.verdict === undefined);
    assert.ok(fixIntent !== undefined);
  });

  test('fix without notes parks — no scopeless re-entry', async () => {
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
      { verdict: 'fix', payload: {} }, // missing notes
    ]);
    const fleet = spy([{ verdict: 'done' }]);
    const res = await run({ judge: judge.fn, fleet: fleet.fn });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.fixNotesMissing);
    assert.equal(res.stage, 'review'); // parks AT the source — a wake re-judges
    assert.equal(fleet.calls.length, 1);
  });

  test('fix rounds are bounded — exhaustion parks', async () => {
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
      { verdict: 'fix', payload: { notes: 'round 1' } },
      { verdict: 'fix', payload: { notes: 'round 2' } },
    ]);
    const fleet = spy([{ verdict: 'done' }, { verdict: 'done' }]);
    const res = await run({ judge: judge.fn, fleet: fleet.fn }, { fixRounds: 1 });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.fixRoundsExhausted);
    assert.equal(fleet.calls.length, 2); // original + one fix round
    assert.equal(fleet.calls[1].fixRound, 1);
  });
});

describe('the admit seam — spawn idempotence', () => {
  test('admit consulted before spawn intents; a refusal verdict skips the engine', async () => {
    const admitted: StageCall[] = [];
    const e = happyScript();
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
      { verdict: 'spawn', payload: {} }, // re-route after the refusal
      { verdict: 'push' },
    ]);
    let consults = 0;
    const res = await run(
      { ...emap(e), judge: judge.fn },
      {
        admit: call => {
          admitted.push(call);
          consults += 1;
          // refuse the first spawn, admit the re-try through route
          return consults === 1 ? { verdict: 'rate_limited' } : true;
        },
      }
    );
    assert.equal(admitted.length, 2); // only 'spawn' intents are gated
    assert.ok(admitted.every(c => c.stage.name === 'work'));
    assert.equal(e.fleet.calls.length, 1); // refused once — engine ran only on the admit
    assert.equal(res.outcome, 'end'); // rate_limited → route → spawn → done → …
  });

  test('admit true lets the engine run', async () => {
    const e = happyScript();
    const res = await run(emap(e), { admit: () => true });
    assert.equal(res.outcome, 'end');
    assert.equal(e.fleet.calls.length, 1);
  });
});

describe('resume — the write-ahead contract', () => {
  const crashSetup = () => {
    const j = memoryJournal('r1');
    const judge = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
    ]);
    const fleet = spy([new Error('runner killed mid-stage')]);
    const engines: EngineMap = { judge: judge.fn, fleet: fleet.fn };
    return { j, judge, fleet, engines };
  };

  test('a crash leaves a verdict-less intent; recheck settles it without re-firing', async () => {
    const { j, fleet, engines } = crashSetup();
    await assert.rejects(run(engines, { runId: 'r1' }, j), /runner killed/);
    const pending = records(j).at(-1);
    assert.equal(pending?.stage, 'work');
    assert.equal(pending?.verdict, undefined); // side effect may or may not have landed

    const recheck: RecheckFn = () => ({ verdict: 'done', payload: { pr: 7 } });
    const judge2 = spy([{ verdict: 'push' }]);
    const res = await resumePipeline(FORMULA, 'bro-7d5nb.2', j, {
      engines: {
        ...engines,
        fleet: { invoke: fleet.fn, recheck },
        judge: judge2.fn,
        'act-gate': spy([{ verdict: 'landed' }]).fn,
        learn: spy([{ verdict: 'captured' }]).fn,
      },
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'end');
    assert.equal(fleet.calls.length, 1); // never re-invoked — recheck answered
    const work = records(j).find(r => r.stage === 'work' && r.verdict !== undefined);
    assert.equal(work?.verdict, 'done'); // same seq completed
    assert.equal(records(j).filter(r => r.stage === 'work').length, 1);
  });

  test("recheck 'pending' parks WITHOUT a new row — the intent stays the anchor", async () => {
    const { j, engines, fleet } = crashSetup();
    await assert.rejects(run(engines, { runId: 'r1' }, j), /runner killed/);
    const before = j.rows().length;
    const res = await resumePipeline(FORMULA, 'bro-7d5nb.2', j, {
      engines: { ...engines, fleet: { invoke: fleet.fn, recheck: () => 'pending' as const } },
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'work');
    assert.equal(j.rows().length, before); // nothing journaled — next wake re-checks again
    assert.equal(records(j).at(-1)?.verdict, undefined);
  });

  test('recheck undefined re-fires a non-spawn intent; spawn intents need recheck', async () => {
    // judge (judge intent) crashed → re-fire is safe
    const j = memoryJournal('r2');
    const judgeFirst = spy([new Error('killed'), { verdict: 'spawn', payload: {} }]);
    await assert.rejects(run({ judge: judgeFirst.fn }, { runId: 'r2' }, j), /killed/);
    const judge2 = spy([{ verdict: 'solo', payload: {} }, { verdict: 'queue' }]);
    const res = await resumePipeline(FORMULA, 'bro-7d5nb.2', j, {
      engines: { judge: { invoke: judge2.fn } }, // no recheck — re-fires
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'route');
    assert.equal(judge2.calls[0].attempt, 2); // re-fired as attempt 2

    // fleet (spawn intent) crashed → missing recheck fails closed
    const j2 = memoryJournal('r3');
    const jg = spy([
      { verdict: 'solo', payload: { complexity: 'complex' } },
      { verdict: 'spawn', payload: {} },
    ]);
    const fl = spy([new Error('killed')]);
    await assert.rejects(run({ judge: jg.fn, fleet: fl.fn }, { runId: 'r3' }, j2), /killed/);
    const res2 = await resumePipeline(FORMULA, 'bro-7d5nb.2', j2, {
      engines: { judge: jg.fn, fleet: { invoke: fl.fn } }, // invoke-only: no recheck
      formulaSha: SHA,
    });
    assert.equal(res2.outcome, 'park');
    assert.equal(res2.alert, PARK_ALERTS.recheckUnavailable);
    assert.equal(fl.calls.length, 1); // never blindly re-fired
  });

  test('a formula change mid-run parks — drift never auto-resumes', async () => {
    const j = memoryJournal('r4');
    const e = happyScript();
    e.judge = spy([{ verdict: 'solo', payload: { complexity: 'complex' } }, { verdict: 'queue' }]);
    const parked = await run(emap(e), { runId: 'r4' }, j);
    assert.equal(parked.outcome, 'park');
    const res = await resumePipeline(FORMULA, 'bro-7d5nb.2', j, {
      engines: emap(e),
      formulaSha: 'different-sha',
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.formulaDrift);
  });

  test('a settled run resumes through its transition — merge.blocked → retry', async () => {
    const j = memoryJournal('r5');
    const e = happyScript();
    e['act-gate'] = spy([{ verdict: 'blocked' }, { verdict: 'blocked' }, { verdict: 'blocked' }]);
    const res = await run(emap(e), { runId: 'r5' }, j);
    assert.equal(res.outcome, 'park'); // merge retried to exhaustion
    assert.equal(res.alert, PARK_ALERTS.attemptsExhausted);
    assert.deepEqual(
      e['act-gate'].calls.map(c => c.attempt),
      [1, 2, 3]
    );
  });
});

describe('runner invariants', () => {
  test('a missing engine binding parks, never crashes the item', async () => {
    const e = happyScript();
    const res = await run({ judge: e.judge.fn }); // no fleet/act-gate/learn
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.engineUnavailable);
  });

  test('an undeclared engine verdict parks on the missing transition', async () => {
    const judge = spy([{ verdict: 'bogus-verdict' }]);
    const res = await run({ judge: judge.fn });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.missingTransition);
  });

  test('runPipeline without a journal or git dir fails loud', async () => {
    const e = happyScript();
    await assert.rejects(runPipeline(FORMULA, 'x', { engines: emap(e) }), /needs a journal/);
  });
});
