import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskSpec } from '@broject/core';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from '../formula.ts';
import { memoryJournal, type PipelineJournal } from '../journal.ts';
import {
  PARK_ALERTS,
  resumePipeline,
  runPipeline,
  type RunOptions,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { settled } from '../testkit.ts';
import {
  type EvidenceRow,
  type VerifyDeps,
  type VerifyPayload,
  type VerifySpec,
  verifyStage,
} from './verify.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
// by name, never by index — a stage-order change in SPEC_FORMULA must
// not silently re-point every call() at the wrong stage
const VERIFY_STAGE = FORMULA.stages.find(s => s.name === 'verify');
if (VERIFY_STAGE === undefined) {
  throw new Error('SPEC_FORMULA lost its verify stage');
}
const ITEM = 'bro-vv1';
const SHA = 'cafebabe';

const ACS = ['the CLI exits 0', 'the log shows the run id', 'state persists across restarts'];

/** A task spec carrying `acs` — undefined acceptance is the
 *  unverifiable shape (a row without spec sections). */
const spec = (acceptance?: string[]): TaskSpec => ({
  id: ITEM,
  title: `task ${ITEM}`,
  ...(acceptance !== undefined ? { acceptance } : {}),
});

interface SpecSpy {
  calls: string[];
  seam: VerifySpec;
}

/** A scripted taskSpec seam — records the ids it was asked for. */
const specSpy = (s: TaskSpec | undefined): SpecSpy => {
  const calls: string[] = [];
  return {
    calls,
    seam: {
      spec: id => {
        calls.push(id);
        return s;
      },
    },
  };
};

const pass = (ac: string, proof = `run:${ac}`): EvidenceRow => ({ ac, verdict: 'pass', proof });
const fail = (ac: string, proof = `run:${ac}`): EvidenceRow => ({ ac, verdict: 'fail', proof });

interface E2eSpy {
  calls: { call: StageCall; ac: string }[];
  fn: (call: StageCall, ac: string) => Promise<EvidenceRow>;
}

/** A scripted e2e seam — records each (call, ac) it served and answers
 *  from `script`: a function computes the row per AC, a map looks it
 *  up by criterion (falling back to pass), a queue shifts answers per
 *  invocation (the last sticks). */
const e2eSpy = (
  script: ((ac: string) => EvidenceRow) | Record<string, EvidenceRow> | EvidenceRow[]
): E2eSpy => {
  const calls: E2eSpy['calls'] = [];
  let i = 0;
  return {
    calls,
    fn: async (call: StageCall, ac: string): Promise<EvidenceRow> => {
      calls.push({ call, ac });
      if (typeof script === 'function') {
        return script(ac);
      }
      if (Array.isArray(script)) {
        return script[Math.min(i++, script.length - 1)];
      }
      return script[ac] ?? pass(ac);
    },
  };
};

const call = (over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: VERIFY_STAGE,
    attempt: 1,
    ctx: {},
    journal: memoryJournal(),
    ...over,
  }) as StageCall;

const deps = (sp: SpecSpy, e2e: VerifyDeps['e2e']): VerifyDeps => ({
  taskSpec: sp.seam,
  e2e,
});

const invoke = async (sp: SpecSpy, e2e: VerifyDeps['e2e'], over: Partial<StageCall> = {}) =>
  settled(await verifyStage(deps(sp, e2e)).invoke(call(over)));

describe('verify — the AC list', () => {
  test('one e2e call per declared AC, in declared order', async () => {
    const sp = specSpy(spec(ACS));
    const e = e2eSpy({});
    const res = await invoke(sp, e.fn);
    assert.equal(res.verdict, 'verified');
    assert.deepEqual(
      e.calls.map(c => c.ac),
      ACS
    );
    assert.equal(sp.calls.length, 1);
    assert.equal(sp.calls[0], ITEM);
  });

  test('the seam sees the call — work ctx and journal reach it', async () => {
    const sp = specSpy(spec(ACS.slice(0, 1)));
    const e = e2eSpy({});
    const jn = memoryJournal('r1');
    const work = { verdict: 'done', worktree: '/wt/x', head: 'abc123' };
    await invoke(sp, e.fn, { ctx: { work }, journal: jn });
    assert.equal(e.calls.length, 1);
    assert.equal(e.calls[0].call.item, ITEM);
    assert.deepEqual(e.calls[0].call.ctx.work, work);
    assert.equal(e.calls[0].call.journal, jn);
  });

  test('the item carrying no spec is a throw — a phantom is never unverifiable', async () => {
    const e = e2eSpy({});
    await assert.rejects(
      () => invoke(specSpy(undefined), e.fn),
      /verify: item "bro-vv1" is not in the task spec store/
    );
    assert.equal(e.calls.length, 0);
  });

  test('a malformed acceptance list throws — non-empty strings or nothing', async () => {
    const e = e2eSpy({});
    for (const acceptance of ['x', [42], ['ok', ''], null] as unknown as string[][]) {
      await assert.rejects(
        () => invoke(specSpy({ id: ITEM, title: 't', acceptance }), e.fn),
        /malformed acceptance list/
      );
    }
    assert.equal(e.calls.length, 0);
  });
});

describe('verify — verdicts', () => {
  test('every row pass → verified — the rows and summary ride the payload', async () => {
    const sp = specSpy(spec(ACS));
    const e = e2eSpy(ac => pass(ac, `probe:${ac}`));
    const res = await invoke(sp, e.fn);
    assert.equal(res.verdict, 'verified');
    const p = res.payload as VerifyPayload;
    assert.equal(p.rows.length, 3);
    assert.deepEqual(
      p.rows.map(r => [r.ac, r.verdict, r.proof]),
      ACS.map(ac => [ac, 'pass', `probe:${ac}`])
    );
    assert.equal(p.summary, 'all 3 acceptance criteria verified');
    assert.equal(p.notes, undefined); // notes belong to failed
  });

  test('any fail → failed — the failing rows compose the fix scope', async () => {
    const sp = specSpy(spec(ACS));
    const e = e2eSpy({
      [ACS[0]]: pass(ACS[0]),
      [ACS[1]]: fail(ACS[1], 'e2e-run-77'),
      [ACS[2]]: fail(ACS[2], 'e2e-run-78'),
    });
    const res = await invoke(sp, e.fn);
    assert.equal(res.verdict, 'failed');
    const p = res.payload as VerifyPayload;
    assert.equal(p.rows.length, 3); // the whole evidence bundle is journaled
    assert.equal(p.summary, '2 of 3 acceptance criteria failed');
    assert.ok(p.notes !== undefined && p.notes !== ''); // non-empty by construction
    assert.match(p.notes, /address the failed acceptance criteria/);
    // only the FAILING rows scope the fix — the pass stays evidence, not scope
    assert.match(p.notes, new RegExp(`${ACS[1]} \\(evidence: e2e-run-77\\)`));
    assert.match(p.notes, new RegExp(`${ACS[2]} \\(evidence: e2e-run-78\\)`));
    assert.ok(!p.notes.includes(ACS[0]));
  });

  test('one fail among passes still fails — verified requires EVERY row', async () => {
    const sp = specSpy(spec(ACS));
    const e = e2eSpy({ [ACS[1]]: fail(ACS[1]) });
    const res = await invoke(sp, e.fn);
    assert.equal(res.verdict, 'failed');
  });

  test('no declared AC → unverifiable — the seam never runs', async () => {
    const sp = specSpy(spec()); // acceptance absent entirely
    const e = e2eSpy({});
    const res = await invoke(sp, e.fn);
    assert.equal(res.verdict, 'unverifiable');
    const p = res.payload as VerifyPayload;
    assert.deepEqual(p.rows, []);
    assert.match(p.summary ?? '', /no declared acceptance criteria/);
    assert.equal(e.calls.length, 0);
  });

  test('an empty AC list is unverifiable too — not "no checks"', async () => {
    const res = await invoke(specSpy(spec([])), e2eSpy({}).fn);
    assert.equal(res.verdict, 'unverifiable');
  });
});

describe('verify — fail loud', () => {
  const CASES: [string, unknown][] = [
    ['a missing verdict', { ac: ACS[0], proof: 'run-1' }],
    ['a verdict outside pass|fail', { ac: ACS[0], verdict: 'skip', proof: 'run-1' }],
    ['a missing proof', { ac: ACS[0], verdict: 'pass' }],
    ['an empty proof', { ac: ACS[0], verdict: 'pass', proof: '' }],
    ['a non-string proof', { ac: ACS[0], verdict: 'pass', proof: 42 }],
    ['an ac for a different criterion', { ac: 'something else', verdict: 'pass', proof: 'r' }],
    ['a missing ac', { verdict: 'pass', proof: 'run-1' }],
    ['a bare string', 'pass'],
    ['null', null],
  ];
  for (const [name, row] of CASES) {
    test(`${name} throws — unreadable evidence is never journaled`, async () => {
      const sp = specSpy(spec(ACS.slice(0, 1)));
      const e = e2eSpy(() => row as EvidenceRow);
      await assert.rejects(() => invoke(sp, e.fn), /malformed evidence row/);
    });
  }

  test('a row failing later in the list still throws — partial evidence settles nothing', async () => {
    const sp = specSpy(spec(ACS));
    const e = e2eSpy(ac =>
      ac === ACS[2] ? ({ ac, verdict: 'maybe' } as unknown as EvidenceRow) : pass(ac)
    );
    await assert.rejects(() => invoke(sp, e.fn), /malformed evidence row/);
    assert.equal(e.calls.length, 3); // the bad answer, not the count, is the failure
  });

  test('a throwing e2e seam propagates — the pending intent is the crash marker', async () => {
    const sp = specSpy(spec(ACS.slice(0, 1)));
    await assert.rejects(
      () =>
        invoke(sp, async () => {
          throw new Error('e2e runner is down');
        }),
      /e2e runner is down/
    );
  });
});

describe('verify inside runPipeline — the spec DAG', () => {
  /** The upstream/downstream engines stubbed around the real verify
   *  stage: classify complex (the review gate passes), route spawns,
   *  intake accepts, work reports done, review pushes, accept accepts,
   *  merge lands, capture captures. */
  const runDag = (
    d: VerifyDeps,
    opts: { work?: (c: StageCall) => { verdict: string }; runOpts?: Partial<RunOptions> } = {},
    journal: PipelineJournal = memoryJournal()
  ) => {
    const workCalls: StageCall[] = [];
    const res = runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal,
      ...opts.runOpts,
      admit: () => true, // the fleet spawn intent needs the go-marker
      engines: {
        judge: {
          invoke: c =>
            c.stage.name === 'classify'
              ? { verdict: 'solo', payload: { group: 'solo', complexity: 'complex', rank: 1 } }
              : c.stage.name === 'route'
                ? {
                    verdict: 'spawn',
                    payload: { class: 'default', kind: 'k', orch: 'exec', timing: 'now' },
                  }
                : { verdict: 'push', payload: { notes: 'looks good' } },
        },
        intake: () => ({ verdict: 'accepted' }),
        fleet: (c: StageCall) => {
          workCalls.push(c);
          return opts.work !== undefined ? opts.work(c) : { verdict: 'done' };
        },
        e2e: verifyStage(d),
        accept: () => ({ verdict: 'accepted' }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });
    return { res, workCalls };
  };

  test('verified → review → accept → merge → capture → end, ctx.verify absorbed', async () => {
    const sp = specSpy(spec(ACS.slice(0, 2)));
    const e = e2eSpy({});
    const { res, workCalls } = runDag(deps(sp, e.fn));
    const r = await res;
    assert.equal(r.outcome, 'end');
    assert.equal(workCalls.length, 1);
    assert.equal(e.calls.length, 2); // one per declared AC
    const p = r.ctx.verify as VerifyPayload;
    assert.equal(p.rows.length, 2);
    assert.equal(p.summary, 'all 2 acceptance criteria verified');
  });

  test('failed → work re-entry — the composed scope is journaled with the verdict', async () => {
    const jn = memoryJournal();
    const sp = specSpy(spec(ACS.slice(0, 2)));
    // first verify round: the second AC fails; the re-work's verify passes all
    let n = 0;
    const e = e2eSpy(ac => (n++ < 2 && ac === ACS[1] ? fail(ac, 'e2e-run-9') : pass(ac)));
    const { res, workCalls } = runDag(deps(sp, e.fn), {}, jn);
    const r = await res;
    assert.equal(r.outcome, 'end');
    assert.equal(workCalls.length, 2); // the run + the failed-scope re-entry
    assert.equal(e.calls.length, 4); // two ACs verified twice
    const p = r.ctx.verify as VerifyPayload; // the LAST verify's payload won
    assert.equal(
      p.rows.every(row => row.verdict === 'pass'),
      true
    );
    // the failed round settled durable: verdict + the composed fix scope
    const failed = jn.rows().filter(row => row.stage === 'verify' && row.verdict === 'failed');
    assert.equal(failed.length, 1);
    const fp = failed[0].payload as VerifyPayload;
    assert.match(fp.notes ?? '', new RegExp(`${ACS[1]} \\(evidence: e2e-run-9\\)`));
    assert.ok(!(fp.notes ?? '').includes(ACS[0])); // the passing AC is not scope
    // the re-entry is SCOPED — fix_round + the failed rows' scope, same
    // contract as review.fix / accept.rejected
    assert.equal(workCalls[1].fixRound, 1);
    assert.match(workCalls[1].notes ?? '', new RegExp(ACS[1]));
  });

  test('repeated failed verdicts consume the fix budget — exhaustion parks', async () => {
    const sp = specSpy(spec(ACS.slice(0, 1)));
    const e = e2eSpy(ac => fail(ac, 'still broken'));
    const { res, workCalls } = runDag(deps(sp, e.fn), { runOpts: { fixRounds: 1 } });
    const r = await res;
    assert.equal(r.outcome, 'park');
    assert.equal(r.alert, PARK_ALERTS.fixRoundsExhausted);
    assert.equal(workCalls.length, 2); // original + one scoped round
    assert.equal(workCalls[1].fixRound, 1);
  });

  test('unverifiable → park — the item goes back for spec enrichment', async () => {
    const sp = specSpy(spec()); // no AC declared
    const e = e2eSpy({});
    const { res, workCalls } = runDag(deps(sp, e.fn));
    const r = await res;
    assert.equal(r.outcome, 'park');
    assert.equal(r.stage, 'verify');
    assert.equal(r.verdict, 'unverifiable');
    assert.equal(workCalls.length, 1); // work ran, its output just can't be verified
    assert.equal(e.calls.length, 0);
  });

  test('a pending verify intent re-fires on resume — e2e is not spawn-like', async () => {
    const j = memoryJournal('r1');
    // the run's settled history through work.done — replay rebuilds ctx
    const base = {
      run_id: 'r1',
      item: ITEM,
      attempt: 1,
      formula_sha: SHA,
      ts: '2026-11-06T00:00:00Z',
    };
    j.append({
      ...base,
      seq: 1,
      stage: 'classify',
      intent: 'judge',
      verdict: 'solo',
      payload: { group: 'solo', complexity: 'complex', rank: 1 },
    });
    j.append({
      ...base,
      seq: 2,
      stage: 'route',
      intent: 'judge',
      verdict: 'spawn',
      payload: { class: 'default', kind: 'k', orch: 'exec', timing: 'now' },
    });
    j.append({ ...base, seq: 3, stage: 'intake', intent: 'spec', verdict: 'accepted' });
    j.append({ ...base, seq: 4, stage: 'work', intent: 'spawn', verdict: 'done' });
    // the crash window: the verify intent journaled, verdict never came
    j.append({ ...base, seq: 5, stage: 'verify', intent: 'verify' });
    const sp = specSpy(spec(ACS.slice(0, 1)));
    const e = e2eSpy({});
    const res = await resumePipeline(FORMULA, ITEM, j, {
      formulaSha: SHA,
      admit: () => true,
      engines: {
        judge: { invoke: () => ({ verdict: 'push', payload: { notes: 'ok' } }) },
        intake: () => ({ verdict: 'accepted' }),
        fleet: () => ({ verdict: 'done' }),
        e2e: verifyStage(deps(sp, e.fn)),
        accept: () => ({ verdict: 'accepted' }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });
    assert.equal(res.outcome, 'end');
    assert.equal(e.calls.length, 1); // re-fired, not re-checked — no hook bound
    assert.equal(e.calls[0].call.attempt, 2); // a bounded fresh attempt
  });

  test('an unbound e2e engine parks engine-unavailable', async () => {
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines: {
        judge: {
          invoke: c =>
            c.stage.name === 'classify'
              ? { verdict: 'solo', payload: { group: 'solo', complexity: 'cheap', rank: 1 } }
              : {
                  verdict: 'spawn',
                  payload: { class: 'd', kind: 'k', orch: 'exec', timing: 'now' },
                },
        },
        intake: () => ({ verdict: 'accepted' }),
        fleet: () => ({ verdict: 'done' }),
      },
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.engineUnavailable);
    assert.equal(res.stage, 'verify');
  });
});
