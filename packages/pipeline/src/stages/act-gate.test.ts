/**
 * act-gate stage suite — the merge stage's PR settle probe
 * (specs/bro-7d5nb.md §merge, bead bro-v0pvd.2). The engine resolves
 * the run's PR identity from pipeline ctx, probes the act state
 * through the injected seam, and maps lifecycle + gate read onto
 * landed|blocked|dropped — 'pending' suspends on the verdict-less
 * intent, recheck re-asks the same read-only probe idempotently.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from '../formula.ts';
import { memoryJournal, type PipelineJournal } from '../journal.ts';
import {
  type EngineHandler,
  type EngineMap,
  type EngineOutcome,
  type EngineResult,
  PARK_ALERTS,
  resumePipeline,
  runPipeline,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import {
  type ActGateDeps,
  type ActGateObservation,
  type ActGatePrRef,
  actGateStage,
} from './act-gate.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
// by name, never by index — a stage-order change in SPEC_FORMULA must
// not silently re-point every call() at the wrong stage
const MERGE_STAGE = FORMULA.stages.find(s => s.name === 'merge');
if (MERGE_STAGE === undefined) {
  throw new Error('SPEC_FORMULA lost its merge stage');
}
const ITEM = 'bro-v0pvd.2';
const SHA = 'feedface';

/** The stage under test — deps with a scripted probe. */
const stageOf = (probe: ActGateDeps['probe']): EngineHandler => actGateStage({ probe });

const call = (journal: PipelineJournal, over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: MERGE_STAGE,
    attempt: 1,
    ctx: { pr: 42 },
    journal,
    ...over,
  }) as StageCall;

/** A well-formed OPEN observation — overrides spread over it. */
const openObs = (
  gate: Partial<ActGateObservation['gate']> = {},
  over: Partial<ActGateObservation> = {}
): ActGateObservation => ({
  state: 'OPEN',
  headSha: 'abc123def',
  url: 'https://example.test/pull/42',
  gate: { ok: true, settling: false, ...gate },
  ...over,
});

/** A scripted probe seam — answers each call with the next queued
 *  result; `calls` records (call, pr) pairs for assertions.
 *  `undefined` IS a scriptable answer (probe-undefined → the
 *  pr-unreadable park), so exhaustion is a length check, not a
 *  shifted-undefined. */
const probeSpy = (results: (ActGateObservation | undefined | Error)[]) => {
  const calls: { call: StageCall; pr: ActGatePrRef }[] = [];
  return {
    calls,
    fn: async (c: StageCall, pr: ActGatePrRef): Promise<ActGateObservation | undefined> => {
      calls.push({ call: c, pr });
      if (results.length === 0) {
        throw new Error(`scripted probe exhausted at attempt ${c.attempt}`);
      }
      const next = results.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
};

/** Narrow an invoke/recheck outcome to a settling result — 'pending',
 *  alerts, and an absent recheck hook all throw like testkit's
 *  `settled` (fixture bug, not a branch). Split ifs keep each
 *  conditional under the code-health branch threshold. */
const settled = (r: EngineOutcome | undefined): EngineResult => {
  if (r === undefined || r === 'pending') {
    throw new Error(`act-gate did not settle — got ${JSON.stringify(r)}`);
  }
  if ('alert' in r) {
    throw new Error(`act-gate parked — ${JSON.stringify(r)}`);
  }
  return r;
};

describe('act-gate — lifecycle → verdict', () => {
  test('MERGED settles landed with merge provenance', async () => {
    const probe = probeSpy([
      { state: 'MERGED', headSha: 'abc123def', mergedBy: 'octocat', url: 'u' },
    ]);
    const res = settled(await stageOf(probe.fn).invoke(call(memoryJournal())));
    assert.equal(res.verdict, 'landed');
    const p = res.payload as Record<string, unknown>;
    assert.equal(p.state, 'MERGED'); // lifecycle echoed — landed via merge
    assert.equal(p.pr, 42); // the ctx ref echoed verbatim
    assert.equal(p.headSha, 'abc123def');
    assert.equal(p.mergedBy, 'octocat');
    assert.equal(p.gate, undefined); // no gate read on a merged PR
    assert.match(String(p.summary), /merged by octocat/);
    assert.equal(probe.calls[0]?.pr, 42);
  });

  test('CLOSED settles dropped — closed unmerged is terminal', async () => {
    const probe = probeSpy([{ state: 'CLOSED', headSha: 'abc123def' }]);
    const res = settled(await stageOf(probe.fn).invoke(call(memoryJournal())));
    assert.equal(res.verdict, 'dropped');
    const p = res.payload as Record<string, unknown>;
    assert.equal(p.pr, 42);
    assert.match(String(p.summary), /closed unmerged/);
  });

  test('OPEN + settling answers pending — the intent stays the resume anchor', async () => {
    const probe = probeSpy([openObs({ ok: false, settling: true, ciPending: 2 })]);
    const res = await stageOf(probe.fn).invoke(call(memoryJournal()));
    assert.equal(res, 'pending');
  });

  test('settling wins over BOTH ok and blockers — the gate has not finished', async () => {
    const probe = probeSpy([
      openObs({ ok: true, settling: true }),
      openObs({ ok: false, settling: true, blockers: ['1 failing check(s)'] }),
    ]);
    const h = stageOf(probe.fn);
    assert.equal(await h.invoke(call(memoryJournal())), 'pending');
    assert.equal(await h.invoke(call(memoryJournal())), 'pending');
    assert.equal(probe.calls.length, 2);
  });

  test('OPEN settled green lands — gate detail nests provider/model', async () => {
    const probe = probeSpy([openObs({}, { provider: 'github', model: 'gh' })]);
    const res = settled(await stageOf(probe.fn).invoke(call(memoryJournal())));
    assert.equal(res.verdict, 'landed');
    const p = res.payload as {
      verdict: string;
      state: string;
      gate: Record<string, unknown>;
      headSha?: string;
    };
    assert.equal(p.verdict, 'landed');
    assert.equal(p.state, 'OPEN'); // merge-ready, not yet physically merged
    assert.equal(p.headSha, 'abc123def');
    assert.deepEqual(p.gate, { ok: true, settling: false, provider: 'github', model: 'gh' });
    assert.match(String((res.payload as Record<string, unknown>).summary), /settled green/);
  });

  test('OPEN settled with blockers answers blocked — blockers journal as detail', async () => {
    const probe = probeSpy([
      openObs({
        ok: false,
        settling: false,
        blockers: ['1 failing check(s)', '2 unresolved review thread(s)'],
        ciFailing: 1,
        openThreads: 2,
      }),
    ]);
    const res = settled(await stageOf(probe.fn).invoke(call(memoryJournal())));
    assert.equal(res.verdict, 'blocked');
    const p = res.payload as { gate: Record<string, unknown>; summary?: string };
    assert.deepEqual(p.gate.blockers, ['1 failing check(s)', '2 unresolved review thread(s)']);
    assert.equal(p.gate.ciFailing, 1);
    assert.equal(p.gate.openThreads, 2);
    assert.match(String(p.summary), /1 failing check\(s\)/);
  });
});

describe('act-gate — PR identity from ctx', () => {
  test('ctx.pr reaches the probe verbatim — number, string, record', async () => {
    for (const pr of [42, '#42', { repo: 'o/r', number: 7 }]) {
      const probe = probeSpy([openObs()]);
      await stageOf(probe.fn).invoke(call(memoryJournal(), { ctx: { pr } }));
      assert.deepEqual(probe.calls[0]?.pr, pr);
    }
  });

  test('draft_pr is the fallback alias — the accept bundle convention', async () => {
    const probe = probeSpy([openObs()]);
    await stageOf(probe.fn).invoke(call(memoryJournal(), { ctx: { draft_pr: 'pr://77' } }));
    assert.equal(probe.calls[0]?.pr, 'pr://77');
  });

  test('work-scoped pr/draft_pr resolve when flat keys are absent', async () => {
    const probe = probeSpy([openObs(), openObs()]);
    const h = stageOf(probe.fn);
    await h.invoke(call(memoryJournal(), { ctx: { work: { pr: 9, worktree: '/wt' } } }));
    await h.invoke(call(memoryJournal(), { ctx: { work: { draft_pr: 'pr://5' } } }));
    assert.equal(probe.calls[0]?.pr, 9);
    assert.equal(probe.calls[1]?.pr, 'pr://5');
  });

  test('flat pr wins over work.pr — the merged view is the contract', async () => {
    const probe = probeSpy([openObs()]);
    await stageOf(probe.fn).invoke(call(memoryJournal(), { ctx: { pr: 1, work: { pr: 2 } } }));
    assert.equal(probe.calls[0]?.pr, 1);
  });

  test('absent identity parks pr-identity-missing — the probe never fires', async () => {
    const probe = probeSpy([]);
    const res = await stageOf(probe.fn).invoke(call(memoryJournal(), { ctx: {} }));
    assert.ok(typeof res === 'object' && res !== null && 'alert' in res);
    assert.equal((res as { alert: string }).alert, PARK_ALERTS.prIdentityMissing);
    assert.equal(probe.calls.length, 0);
  });

  test('malformed identities park — never probed, never fail open', async () => {
    for (const pr of [true, 0, -3, 1.5, '', [], {}, null]) {
      const probe = probeSpy([]);
      const res = await stageOf(probe.fn).invoke(call(memoryJournal(), { ctx: { pr } }));
      assert.ok(
        typeof res === 'object' && res !== null && 'alert' in res,
        `pr=${JSON.stringify(pr)}`
      );
      assert.equal((res as { alert: string }).alert, PARK_ALERTS.prIdentityMissing);
      assert.equal(probe.calls.length, 0);
    }
  });
});

describe('act-gate — probe contract', () => {
  test('probe undefined parks pr-unreadable — definitive absence', async () => {
    const probe = probeSpy([undefined]);
    const res = await stageOf(probe.fn).invoke(call(memoryJournal()));
    assert.ok(typeof res === 'object' && res !== null && 'alert' in res);
    const a = res as { alert: string; detail?: string };
    assert.equal(a.alert, PARK_ALERTS.prUnreadable);
    assert.match(String(a.detail), /42/);
  });

  test('a probe throw propagates — the pending intent is the crash marker', async () => {
    const probe = probeSpy([new Error('gh exploded')]);
    await assert.rejects(
      async () => stageOf(probe.fn).invoke(call(memoryJournal())),
      /gh exploded/
    );
  });

  test('malformed observations throw — the seam contract, fail loud', async () => {
    const bad: unknown[] = [
      'not-a-record',
      42,
      { state: 'open' }, // lowercase is not the normalized vocabulary
      { state: 'WEIRD' },
      { state: 'OPEN' }, // no gate read
      { state: 'OPEN', gate: 'yes' },
      { state: 'OPEN', gate: { ok: 'yes', settling: false } },
      { state: 'OPEN', gate: { ok: true, settling: 1 } },
      { state: 'OPEN', gate: { ok: true, settling: false, blockers: 'x' } },
      { state: 'OPEN', gate: { ok: true, settling: false, ciPending: '2' } },
      { state: 'OPEN', gate: { ok: true, settling: false }, headSha: 5 },
      { state: 'CLOSED', url: 9 }, // optional fields validate on every lifecycle
      { state: 'MERGED', gate: { ok: true } }, // gate present must be well-formed too
    ];
    for (const obs of bad) {
      const probe = probeSpy([obs as ActGateObservation]);
      await assert.rejects(
        async () => stageOf(probe.fn).invoke(call(memoryJournal())),
        /act-gate/,
        `obs=${JSON.stringify(obs)}`
      );
    }
  });
});

describe('act-gate — recheck', () => {
  test('recheck shares the probe — settling re-parks pending, idempotent', async () => {
    const probe = probeSpy([
      openObs({ ok: false, settling: true, ciPending: 1 }),
      openObs({ ok: true, settling: false }),
    ]);
    const h = stageOf(probe.fn);
    assert.equal(await h.recheck?.(call(memoryJournal())), 'pending');
    const res = settled(await h.recheck?.(call(memoryJournal())));
    assert.equal(res.verdict, 'landed');
    // read-only probe — every wake re-asks, no dedup channel
    assert.equal(probe.calls.length, 2);
  });

  test('recheck answers the same outcomes invoke does — never undefined', async () => {
    const probe = probeSpy([
      { state: 'CLOSED' },
      openObs({ ok: false, settling: false, blockers: ['merge conflicts'] }),
      undefined,
    ]);
    const h = stageOf(probe.fn);
    const j = memoryJournal();
    assert.equal(settled(await h.recheck?.(call(j)))?.verdict, 'dropped');
    assert.equal(settled(await h.recheck?.(call(j)))?.verdict, 'blocked');
    const third = await h.recheck?.(call(j));
    assert.ok(typeof third === 'object' && third !== null && 'alert' in third);
    assert.equal((third as { alert: string }).alert, PARK_ALERTS.prUnreadable);
  });
});

// --- runPipeline slices ---------------------------------------------------------

/** The merge slice — verify feeds ctx (its payload's `pr` is the
 *  stand-in for the work stage's journaled ref), merge is the stage
 *  under test, capture proves the landed walk continues. */
const SLICE = parsePipelineFormula(
  parse(`
version = 1
[[stages]]
name = "verify"
engine = "e2e"
verdicts = ["verified"]
[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["landed", "blocked", "dropped"]
[[stages]]
name = "capture"
engine = "learn"
verdicts = ["captured"]
[transitions]
verify = { verified = "merge" }
merge = { landed = "capture", blocked = "retry", dropped = "close" }
capture = { captured = "end" }
`)
);

const sliceEngines = (
  gate: EngineHandler,
  verifyPayload: Record<string, unknown> = { pr: 42 }
) => ({
  e2e: async (): Promise<EngineResult> => ({ verdict: 'verified', payload: verifyPayload }),
  'act-gate': gate,
  learn: async (): Promise<EngineResult> => ({
    verdict: 'captured',
    payload: { lessons: 0, followups: [] },
  }),
});

const sliceRun = (
  journal: PipelineJournal,
  gate: EngineHandler,
  verifyPayload?: Record<string, unknown>
) =>
  runPipeline(SLICE, ITEM, {
    engines: sliceEngines(gate, verifyPayload) as EngineMap,
    journal,
    formulaSha: SHA,
  });

const sliceResume = (
  journal: PipelineJournal,
  gate: EngineHandler,
  verifyPayload?: Record<string, unknown>
) =>
  resumePipeline(SLICE, ITEM, journal, {
    engines: sliceEngines(gate, verifyPayload) as EngineMap,
    formulaSha: SHA,
  });

describe('act-gate — runPipeline', () => {
  test('pending → wake → landed → capture → end', async () => {
    const j = memoryJournal('r1');
    const probe = probeSpy([
      openObs({ ok: false, settling: true, ciPending: 3, reviewersPending: 1 }),
      openObs({ ok: true, settling: false }),
    ]);
    const gate = stageOf(probe.fn);
    const res = await sliceRun(j, gate);
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'merge');
    assert.equal(res.alert, undefined); // a suspension, not a park alert
    // the pending gate intent is the journal tail — no verdict row
    const tail = j.rows().at(-1);
    assert.equal(tail?.stage, 'merge');
    assert.equal(tail?.intent, 'gate'); // STAGE_INTENTS['act-gate']
    assert.equal(tail?.verdict, undefined);
    assert.equal(probe.calls.length, 1);

    // the settle lands; a wake's recheck completes the record and walks on
    const res2 = await sliceResume(j, gate);
    assert.equal(res2.outcome, 'end');
    const recs = j.rows();
    const landed = recs.find(r => r.stage === 'merge' && r.verdict === 'landed');
    assert.ok(landed !== undefined);
    assert.equal((landed.payload as { pr: number }).pr, 42);
    assert.ok(recs.some(r => r.stage === 'capture' && r.verdict === 'captured'));
    assert.equal(probe.calls.length, 2);
  });

  test('blocked → retry bounded by maxAttempts → attempts-exhausted park', async () => {
    const j = memoryJournal('r1');
    const blocked = openObs({ ok: false, settling: false, blockers: ['merge conflicts'] });
    const probe = probeSpy([blocked, blocked, blocked]);
    const gate = stageOf(probe.fn);
    const res = await runPipeline(SLICE, ITEM, {
      engines: sliceEngines(gate) as EngineMap,
      journal: j,
      formulaSha: SHA,
      maxAttempts: 2,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'merge');
    assert.equal(res.alert, PARK_ALERTS.attemptsExhausted);
    assert.equal(probe.calls.length, 2); // attempt 1 + retry attempt 2 — budget spent
    const alerts = j.rows().filter(r => r.alert !== undefined);
    assert.equal(alerts.at(-1)?.alert, PARK_ALERTS.attemptsExhausted);
    assert.equal(alerts.at(-1)?.resume, 'merge');
  });

  test('dropped → close — the run settles without capture', async () => {
    const j = memoryJournal('r1');
    const probe = probeSpy([{ state: 'CLOSED', headSha: 'abc123def' }]);
    const gate = stageOf(probe.fn);
    const res = await sliceRun(j, gate);
    assert.equal(res.outcome, 'close');
    assert.equal(res.stage, 'merge');
    assert.equal(res.verdict, 'dropped');
    assert.ok(j.rows().every(r => r.stage !== 'capture'));
  });

  test('missing PR identity parks with pr-identity-missing — probe never fires', async () => {
    const j = memoryJournal('r1');
    const probe = probeSpy([]);
    const gate = stageOf(probe.fn);
    const res = await sliceRun(j, gate, {}); // verify payload carries no pr
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'merge');
    assert.equal(res.alert, PARK_ALERTS.prIdentityMissing);
    assert.equal(probe.calls.length, 0);
    const alert = j.rows().at(-1);
    assert.equal(alert?.alert, PARK_ALERTS.prIdentityMissing);
    assert.equal(alert?.resume, 'merge');
  });
});
