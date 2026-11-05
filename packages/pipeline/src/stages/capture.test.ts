import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from '../formula.ts';
import {
  type JournalRow,
  journalRecords,
  memoryJournal,
  type PipelineJournal,
} from '../journal.ts';
import {
  PARK_ALERTS,
  type RunOptions,
  resumePipeline,
  runPipeline,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import {
  type CaptureDeps,
  type CaptureOutcome,
  type CapturePayload,
  captureStage,
  type LandContext,
  type RetroReceipt,
} from './capture.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const CAPTURE_STAGE = FORMULA.stages[5];
const ITEM = 'bro-cc4';
const SHA = 'cafebabe';
const TS = '2026-11-06T00:00:00Z';

/** A two-stage merge → capture formula — enough graph to drive the
 *  stage through the runner without the spawn seam (gate + capture
 *  intents are not spawn-like, so no `admit` is needed). */
const LAND_FORMULA = parsePipelineFormula(
  parse(`
version = 1
[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["landed", "dropped"]
[[stages]]
name = "capture"
engine = "learn"
mode = "always-capture"
verdicts = ["captured"]
[transitions]
merge = { landed = "capture", dropped = "close" }
capture = { captured = "end" }
`)
);

/** A formula whose merge settles on a non-`landed` word — the
 *  fail-closed path: capture reached with no land in the journal. */
const UNLANDED_FORMULA = parsePipelineFormula(
  parse(`
version = 1
[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["ok"]
[[stages]]
name = "capture"
engine = "learn"
verdicts = ["captured"]
[transitions]
merge = { ok = "capture" }
capture = { captured = "end" }
`)
);

/** A journaled record builder — settled unless verdict is nulled. */
const rec = (
  seq: number,
  stage: string,
  verdict: string | undefined,
  extra: Partial<JournalRow> = {}
): JournalRow => ({
  run_id: 'r1',
  item: ITEM,
  seq,
  stage,
  intent: stage === 'merge' ? 'gate' : 'spawn',
  attempt: 1,
  formula_sha: SHA,
  ts: TS,
  ...(verdict !== undefined ? { verdict } : {}),
  ...extra,
});

/** The minimal land: one settled `landed` record on the merge stage. */
const landed = (extra: Partial<JournalRow> = {}) => rec(1, 'merge', 'landed', extra);

interface SeamSpy {
  calls: { call: StageCall; ctx: LandContext }[];
}

/** A scripted learn-capture seam — records the call + land context it
 *  was handed, answers with `out`. */
const captureSpy = (out: CaptureOutcome, order?: string[]) => {
  const calls: SeamSpy['calls'] = [];
  return {
    calls,
    fn: async (call: StageCall, ctx: LandContext): Promise<CaptureOutcome> => {
      order?.push('capture');
      calls.push({ call, ctx });
      return out;
    },
  };
};

/** A scripted retro-queue seam — records the intent it queued, answers
 *  with `receipt`. It QUEUES: nothing here ever executes a retro. */
const retroSpy = (receipt?: RetroReceipt, order?: string[]) => {
  const calls: SeamSpy['calls'] = [];
  return {
    calls,
    fn: async (call: StageCall, ctx: LandContext): Promise<RetroReceipt | undefined> => {
      order?.push('retro');
      calls.push({ call, ctx });
      return receipt;
    },
  };
};

const deps = (c: CaptureDeps['capture'], r: CaptureDeps['retro']): CaptureDeps => ({
  capture: c,
  retro: r,
});

const call = (journal: PipelineJournal, over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: CAPTURE_STAGE,
    attempt: 1,
    ctx: {},
    journal,
    ...over,
  }) as StageCall;

/** A journal carrying one landed merge record (plus any extras). */
const landJournal = (...extra: JournalRow[]): PipelineJournal => {
  const j = memoryJournal('r1');
  j.append(landed());
  for (const r of extra) {
    j.append(r);
  }
  return j;
};

const invoke = async (journal: PipelineJournal, d: CaptureDeps, over: Partial<StageCall> = {}) =>
  captureStage(d).invoke(call(journal, over));

describe('capture — the land context', () => {
  test('captured on land — the spec pair rides the payload', async () => {
    const cap = captureSpy({ lessons: 3, followups: ['bro-x1', 'bro-x2'] });
    const ret = retroSpy({ batch: 'b7' });
    const res = await invoke(landJournal(), deps(cap.fn, ret.fn));
    assert.equal(res.verdict, 'captured');
    const p = res.payload as CapturePayload;
    assert.equal(p.lessons, 3);
    assert.deepEqual(p.followups, ['bro-x1', 'bro-x2']);
    assert.equal(p.retro.queued, true);
    assert.equal(p.retro.batch, 'b7');
  });

  test('the seam sees item + runId + the landed record — stage, ts, payload', async () => {
    const cap = captureSpy({ lessons: 1 });
    const j = landJournal();
    const res = await invoke(j, deps(cap.fn, retroSpy().fn));
    assert.equal(cap.calls.length, 1);
    const ctx = cap.calls[0].ctx;
    assert.equal(ctx.item, ITEM);
    assert.equal(ctx.runId, 'r1'); // the live call's run, same as the journaled rows
    assert.equal(ctx.landed.stage, 'merge');
    assert.equal(ctx.landed.ts, TS);
    assert.equal(res.verdict, 'captured');
  });

  test('the last settled landed wins — an earlier one is superseded', async () => {
    const cap = captureSpy({ lessons: 0 });
    const j = landJournal(rec(2, 'land', 'landed', { ts: '2026-11-06T01:00:00Z' }));
    await invoke(j, deps(cap.fn, retroSpy().fn));
    assert.equal(cap.calls[0].ctx.landed.stage, 'land'); // the later record's stage
  });

  test('a molecule the work journaled scopes the sweep — last settled mol wins', async () => {
    const cap = captureSpy({ lessons: 1 });
    const j = landJournal(
      rec(2, 'work', 'done', { payload: { mol: 'mol-1' } }),
      rec(3, 'work', 'done', { payload: { mol: 'mol-2' }, fix_round: 1 })
    );
    const res = await invoke(j, deps(cap.fn, retroSpy().fn));
    assert.equal(cap.calls[0].ctx.mol, 'mol-2');
    assert.equal((res.payload as CapturePayload).mol, 'mol-2');
  });

  test('a non-string mol is ignored — malformed payload data is never harvested', async () => {
    const cap = captureSpy({ lessons: 0 });
    const j = landJournal(
      rec(2, 'work', 'done', { payload: { mol: 'mol-1' } }),
      rec(3, 'work', 'done', { payload: { mol: 42 } })
    );
    await invoke(j, deps(cap.fn, retroSpy().fn));
    assert.equal(cap.calls[0].ctx.mol, 'mol-1'); // the malformed later one is skipped
  });

  test('no mol in the run — the sweep runs unscoped', async () => {
    const cap = captureSpy({ lessons: 0 });
    const res = await invoke(landJournal(), deps(cap.fn, retroSpy().fn));
    assert.equal(cap.calls[0].ctx.mol, undefined);
    assert.equal((res.payload as CapturePayload).mol, undefined);
  });

  test('other runs and items are invisible — the journal scan is run+item scoped', async () => {
    const cap = captureSpy({ lessons: 0 });
    const j = memoryJournal('r1');
    j.append(rec(1, 'work', 'done', { payload: { mol: 'mol-foreign' } }));
    j.append({ ...landed(), run_id: 'rX' }); // a foreign run's land
    j.append({ ...landed({ seq: 2 }), item: 'bro-zz9' }); // a foreign item's land
    await assert.rejects(() => invoke(j, deps(cap.fn, retroSpy().fn)), /no settled "landed"/);
    assert.equal(cap.calls.length, 0);
  });
});

describe('capture — the sweep', () => {
  test('an empty sweep is still captured — lessons 0, followups []', async () => {
    const res = await invoke(landJournal(), deps(captureSpy({ lessons: 0 }).fn, retroSpy().fn));
    assert.equal(res.verdict, 'captured');
    const p = res.payload as CapturePayload;
    assert.equal(p.lessons, 0);
    assert.deepEqual(p.followups, []);
    assert.equal(p.skipped, undefined);
  });

  test('harvest skips surface in the payload — never silently dropped', async () => {
    const skipped = [
      { origin: 'bro-d1', reason: 'no trigger scope (paths/commands/terms)' },
      { origin: 'bro-d2', reason: 'closed drill frame has no result memo' },
    ];
    const res = await invoke(
      landJournal(),
      deps(captureSpy({ lessons: 1, skipped }).fn, retroSpy().fn)
    );
    assert.deepEqual((res.payload as CapturePayload).skipped, skipped);
  });

  test('the capture sweep runs BEFORE the retro queue', async () => {
    const order: string[] = [];
    await invoke(
      landJournal(),
      deps(captureSpy({ lessons: 0 }, order).fn, retroSpy(undefined, order).fn)
    );
    assert.deepEqual(order, ['capture', 'retro']);
  });

  test('a retro seam returning void still records queued', async () => {
    const res = await invoke(
      landJournal(),
      deps(captureSpy({ lessons: 1 }).fn, retroSpy(undefined).fn)
    );
    assert.deepEqual((res.payload as CapturePayload).retro, { queued: true });
  });

  test('the retro seam receives the same land context — intent queued, not executed', async () => {
    const ret = retroSpy({ batch: 'b3' });
    const j = landJournal(rec(2, 'work', 'done', { payload: { mol: 'mol-5' } }));
    await invoke(j, deps(captureSpy({ lessons: 2 }).fn, ret.fn));
    assert.equal(ret.calls.length, 1);
    const ctx = ret.calls[0].ctx;
    assert.equal(ctx.item, ITEM);
    assert.equal(ctx.runId, 'r1');
    assert.equal(ctx.mol, 'mol-5');
    assert.equal(ctx.landed.stage, 'merge');
  });
});

describe('capture — fail closed', () => {
  test('no settled landed record throws — capture runs on land, never earlier', async () => {
    const cap = captureSpy({ lessons: 1 });
    const ret = retroSpy();
    const j = memoryJournal('r1');
    j.append(rec(1, 'work', 'done'));
    await assert.rejects(
      () => invoke(j, deps(cap.fn, ret.fn)),
      /no settled "landed" record — capture runs on land/
    );
    assert.equal(cap.calls.length, 0);
    assert.equal(ret.calls.length, 0);
  });

  test('an unknown mode token throws — a stage that cannot tell its scope runs nothing', async () => {
    const cap = captureSpy({ lessons: 1 });
    await assert.rejects(
      () =>
        invoke(landJournal(), deps(cap.fn, retroSpy().fn), {
          stage: { ...CAPTURE_STAGE, mode: 'weekly-batch' },
        }),
      /capture: unknown mode "weekly-batch"/
    );
    assert.equal(cap.calls.length, 0);
  });

  test('a missing mode reads as always-capture — the default sweep runs', async () => {
    const res = await invoke(landJournal(), deps(captureSpy({ lessons: 1 }).fn, retroSpy().fn), {
      stage: { ...CAPTURE_STAGE, mode: undefined },
    });
    assert.equal(res.verdict, 'captured');
  });

  test('malformed lessons throw — an unreadable report is never echoed', async () => {
    for (const lessons of [Number.NaN, -1, 1.5, '3']) {
      const out = { lessons } as unknown as CaptureOutcome;
      await assert.rejects(
        () => invoke(landJournal(), deps(captureSpy(out).fn, retroSpy().fn)),
        /malformed outcome — lessons must be a non-negative integer/
      );
    }
  });

  test('malformed followups throw — a bead-id list or nothing', async () => {
    for (const followups of ['bro-x1', [1], ['ok', '']]) {
      const out = { lessons: 1, followups } as unknown as CaptureOutcome;
      await assert.rejects(
        () => invoke(landJournal(), deps(captureSpy(out).fn, retroSpy().fn)),
        /malformed followups/
      );
    }
  });

  test('malformed skipped throw — origin+reason records or nothing', async () => {
    const out = {
      lessons: 1,
      skipped: [{ origin: 'bro-d1' }],
    } as unknown as CaptureOutcome;
    await assert.rejects(
      () => invoke(landJournal(), deps(captureSpy(out).fn, retroSpy().fn)),
      /malformed skipped/
    );
  });

  test('a malformed retro receipt throws — the seam speaks {batch?} or void', async () => {
    await assert.rejects(
      () =>
        invoke(
          landJournal(),
          deps(captureSpy({ lessons: 1 }).fn, retroSpy({ batch: 7 } as unknown as RetroReceipt).fn)
        ),
      /malformed receipt/
    );
    await assert.rejects(
      () =>
        invoke(
          landJournal(),
          deps(captureSpy({ lessons: 1 }).fn, retroSpy('b9' as unknown as RetroReceipt).fn)
        ),
      /malformed receipt/
    );
  });

  test('a throwing learn seam propagates — the retro hook never fires', async () => {
    const ret = retroSpy();
    const d = deps(async () => {
      throw new Error('learn store is down');
    }, ret.fn);
    await assert.rejects(() => invoke(landJournal(), d), /learn store is down/);
    assert.equal(ret.calls.length, 0);
  });

  test('a throwing retro seam propagates — the sweep already ran (re-fire is dedup-safe)', async () => {
    const cap = captureSpy({ lessons: 2 });
    const d = deps(cap.fn, async () => {
      throw new Error('retro queue is down');
    });
    await assert.rejects(() => invoke(landJournal(), d), /retro queue is down/);
    assert.equal(cap.calls.length, 1);
  });
});

describe('capture inside runPipeline — the runner contract', () => {
  const runLand = (
    d: CaptureDeps,
    opts: Partial<RunOptions> = {},
    journal = memoryJournal(),
    gate: () => { verdict: string } = () => ({ verdict: 'landed' })
  ) =>
    runPipeline(LAND_FORMULA, ITEM, {
      formulaSha: SHA,
      journal,
      // no admit: gate + capture intents are not spawn-like — the stage
      // must never consult the go-marker seam
      ...opts,
      engines: { 'act-gate': gate, learn: captureStage(d) },
    });

  test('landed → capture runs → captured → end', async () => {
    const cap = captureSpy({ lessons: 4, followups: ['bro-z9'] });
    const ret = retroSpy({ batch: 'b1' });
    const j = memoryJournal();
    const res = await runLand(deps(cap.fn, ret.fn), {}, j);
    assert.equal(res.outcome, 'end');
    assert.equal(res.stage, 'capture');
    assert.equal(res.verdict, 'captured');
    const p = res.ctx.capture as CapturePayload;
    assert.equal(p.lessons, 4);
    assert.deepEqual(p.followups, ['bro-z9']);
    assert.equal(p.retro.batch, 'b1');
    // the intent journaled BEFORE the side effect — same seq completes
    const rows = j.rows().filter(r => r.stage === 'capture');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].intent, 'capture');
    assert.equal(rows[0].verdict, undefined); // the write-ahead row
    assert.equal(rows[1].verdict, 'captured');
    assert.equal(rows[1].seq, rows[0].seq);
    // the batch id is durable — it landed in the journaled payload
    const done = journalRecords(j.rows()).at(-1);
    assert.ok(done !== undefined);
    assert.equal((done.payload as CapturePayload).retro.batch, 'b1');
  });

  test('dropped → close — neither seam is consulted', async () => {
    const cap = captureSpy({ lessons: 1 });
    const ret = retroSpy();
    const res = await runLand(deps(cap.fn, ret.fn), {}, memoryJournal(), () => ({
      verdict: 'dropped',
    }));
    assert.equal(res.outcome, 'close');
    assert.equal(cap.calls.length, 0);
    assert.equal(ret.calls.length, 0);
  });

  test('a pending capture intent re-fires on resume — learn is not spawn-like', async () => {
    const cap = captureSpy({ lessons: 2 });
    const ret = retroSpy();
    const j = memoryJournal('r1');
    j.append(landed());
    // the crash window: the capture intent journaled, verdict never came
    j.append({ ...rec(2, 'capture', undefined), intent: 'capture' });
    const res = await resumePipeline(LAND_FORMULA, ITEM, j, {
      formulaSha: SHA,
      engines: {
        'act-gate': () => ({ verdict: 'landed' }),
        learn: captureStage(deps(cap.fn, ret.fn)),
      },
    });
    assert.equal(res.outcome, 'end');
    assert.equal(cap.calls.length, 1); // re-fired, not re-checked — no hook bound
    assert.equal(ret.calls.length, 1);
    assert.equal(cap.calls[0].call.attempt, 2); // a bounded fresh attempt
  });

  test('capture without land fails closed — throw, bounded re-fire, attempts-exhausted park', async () => {
    const cap = captureSpy({ lessons: 1 });
    const ret = retroSpy();
    const d = deps(cap.fn, ret.fn);
    // a run id on the journal — resumePipeline derives run identity
    // from it; a minted-per-call id would lose the pending intent
    const j = memoryJournal('r1');
    const opts = (jj: PipelineJournal): RunOptions => ({
      formulaSha: SHA,
      journal: jj,
      maxAttempts: 2,
      engines: { 'act-gate': () => ({ verdict: 'ok' }), learn: captureStage(d) },
    });
    // the run reaches capture on an "ok" merge — no landed anywhere
    await assert.rejects(
      () => runPipeline(UNLANDED_FORMULA, ITEM, opts(j)),
      /capture runs on land/
    );
    await assert.rejects(
      () => resumePipeline(UNLANDED_FORMULA, ITEM, j, opts(j)),
      /capture runs on land/
    );
    const res = await resumePipeline(UNLANDED_FORMULA, ITEM, j, opts(j));
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.attemptsExhausted);
    // two bounded invocations journaled intents — the seams never ran:
    // the land check throws first, capture on un-landed work never sweeps
    assert.equal(j.rows().filter(r => r.intent === 'capture').length, 2);
    assert.equal(cap.calls.length, 0);
    assert.equal(ret.calls.length, 0);
  });

  test('an unbound learn engine parks engine-unavailable — before any land check', async () => {
    const j = memoryJournal();
    const res = await runPipeline(LAND_FORMULA, ITEM, {
      formulaSha: SHA,
      journal: j,
      engines: { 'act-gate': () => ({ verdict: 'landed' }) },
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.engineUnavailable);
  });
});

describe('capture in the spec DAG — the last stage', () => {
  test('classify → … → merge.landed → capture → end, ctx.capture absorbed', async () => {
    const cap = captureSpy({ lessons: 2, followups: ['bro-f1'] });
    const ret = retroSpy({ batch: 'b0' });
    const j = memoryJournal();
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: j,
      admit: () => true,
      engines: {
        judge: {
          invoke: c =>
            c.stage.name === 'classify'
              ? { verdict: 'solo', payload: { group: 'solo', complexity: 'cheap', rank: 1 } }
              : {
                  verdict: 'spawn',
                  payload: { class: 'default', kind: 'k', orch: 'exec', timing: 'now' },
                },
        },
        // cheap complexity — the review gate synthesizes skip; capture
        // still reads the landed record (a skipped review changes nothing)
        fleet: () => ({ verdict: 'done', payload: { mol: 'mol-7' } }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: captureStage(deps(cap.fn, ret.fn)),
      },
    });
    assert.equal(res.outcome, 'end');
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].ctx.mol, 'mol-7'); // the work stage's mol reached the sweep
    const p = res.ctx.capture as CapturePayload;
    assert.equal(p.mol, 'mol-7');
    assert.equal(p.landed.stage, 'merge');
    assert.equal(ret.calls.length, 1);
  });
});
