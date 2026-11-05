/**
 * accept stage suite — the customer gate (specs/bro-7d5nb.md §accept).
 * The engine emits the journal-derived evidence bundle, suspends on a
 * pending intent, and settles only from the customer's verdict record:
 * accepted|rejected|abandon signed by run.customer — anything else
 * fails closed and the run does not move.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { testRepoInit } from '@broject/core';
import { parse } from 'smol-toml';
import { awaitingCustomerRuns } from '../awaiting.ts';
import {
  appendCustomerRecord,
  customerChannelPath,
  fileVerdictStore,
  latestVerdict,
  readCustomerFile,
} from '../customer.ts';
import { parsePipelineFormula } from '../formula.ts';
import {
  type JournalRow,
  journalRecords,
  memoryJournal,
  openPipelineJournal,
  type PipelineJournal,
} from '../journal.ts';
import {
  type EngineMap,
  type EngineResult,
  PARK_ALERTS,
  resumePipeline,
  runPipeline,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { acceptStage, type EvidenceBundle, REJECTED_VERDICT } from './accept.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
// by name, never by index — a stage-order change in SPEC_FORMULA must
// not silently re-point every call() at the wrong stage
const ACCEPT_STAGE = FORMULA.stages.find(s => s.name === 'accept');
if (ACCEPT_STAGE === undefined) {
  throw new Error('SPEC_FORMULA lost its accept stage');
}
const ITEM = 'bro-acc1';
const SHA = 'cafebabe';
const TS = '2026-11-06T00:00:00Z';
const CUSTOMER = 'customer-1';

const tmp = () => mkdtempSync(join(tmpdir(), 'pipeline-accept-'));

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
  intent: 'verify',
  attempt: 1,
  formula_sha: SHA,
  ts: TS,
  ...(verdict !== undefined ? { verdict } : {}),
  ...extra,
});

const VERIFY_ROWS = { rows: [{ ac: 'ships', verdict: 'pass', proof: 'run-1' }] };

/** The minimal evidence journal: a settled verify row the bundle
 *  must surface (plus any extras). */
const verifyJournal = (...extra: JournalRow[]): PipelineJournal => {
  const j = memoryJournal('r1');
  j.append(rec(1, 'verify', 'verified', { payload: VERIFY_ROWS }));
  for (const r of extra) {
    j.append(r);
  }
  return j;
};

interface EmitSpy {
  calls: { call: StageCall; bundle: EvidenceBundle }[];
}

/** A scripted emit seam — records every bundle it was handed. */
const emitSpy = () => {
  const calls: EmitSpy['calls'] = [];
  return {
    calls,
    fn: async (call: StageCall, bundle: EvidenceBundle): Promise<void> => {
      calls.push({ call, bundle });
    },
  };
};

/** A mutable verdict store — `current` is what the next read answers;
 *  `raw` is `unknown` on purpose: the seam's contract hands the stage
 *  whatever the channel held, malformed rows included. */
const storeSpy = (initial?: unknown) => {
  const s = { current: initial as unknown, calls: 0 };
  return {
    s,
    fn: async (_call: StageCall): Promise<unknown> => {
      s.calls += 1;
      return s.current;
    },
  };
};

const call = (journal: PipelineJournal, over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: ACCEPT_STAGE,
    attempt: 1,
    customer: CUSTOMER,
    ctx: {},
    journal,
    ...over,
  }) as StageCall;

const verdict = (v: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'verdict',
  item: ITEM,
  verdict: v,
  accepted_by: CUSTOMER,
  ts: TS,
  ...extra,
});

describe('accept — emit then suspend', () => {
  test('invoke emits the journal-derived bundle and answers pending', async () => {
    const emit = emitSpy();
    const store = storeSpy();
    const j = verifyJournal(
      rec(2, 'review', 'push', {
        intent: 'judge',
        payload: { notes: 'ok', diff: { files: 3, base: 'main', head: 'w/x' } },
      }),
      rec(3, 'work', 'done', { intent: 'spawn', payload: { draft_pr: 'pr://77' } })
    );
    const res = await acceptStage({ emit: emit.fn, verdictStore: store.fn }).invoke(call(j));
    assert.equal(res, 'pending');
    assert.equal(emit.calls.length, 1);
    const b = emit.calls[0].bundle;
    assert.equal(b.runId, 'r1');
    assert.equal(b.item, ITEM);
    // journal authority: the settled verify record's full payload —
    // the AC rows the customer signs on
    assert.deepEqual(b.verify, [
      { stage: 'verify', verdict: 'verified', ts: TS, payload: VERIFY_ROWS },
    ]);
    // freshest diff provenance + draft_pr ride along
    assert.deepEqual(b.diff, { files: 3, base: 'main', head: 'w/x' });
    assert.equal(b.draft_pr, 'pr://77');
    assert.equal(store.s.calls, 1);
  });

  test('a pre-landed verdict settles in invoke — emit still fired', async () => {
    const emit = emitSpy();
    const store = storeSpy(verdict('accepted'));
    const res = await acceptStage({ emit: emit.fn, verdictStore: store.fn }).invoke(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      verdict: 'accepted',
      payload: { accepted_by: CUSTOMER, ts: TS },
    });
    assert.equal(emit.calls.length, 1);
  });

  test('recheck with no verdict re-emits and stays pending — crash-window cover', async () => {
    const emit = emitSpy();
    const store = storeSpy();
    const h = acceptStage({ emit: emit.fn, verdictStore: store.fn });
    assert.ok(h.recheck !== undefined);
    const res = await h.recheck(call(verifyJournal()));
    assert.equal(res, 'pending');
    assert.equal(emit.calls.length, 1); // idempotent re-emit — the dedup key is the run
  });
});

describe('accept — the verdict gate', () => {
  test('accepted signed by the run customer settles with the spec payload', async () => {
    const store = storeSpy(verdict('accepted', { notes: 'lgtm' }));
    const h = acceptStage({ emit: emitSpy().fn, verdictStore: store.fn });
    const res = await h.recheck?.(call(verifyJournal()));
    assert.deepEqual(res, {
      verdict: 'accepted',
      payload: { accepted_by: CUSTOMER, notes: 'lgtm', ts: TS },
    });
  });

  test('rejected carries the customer notes as the fix scope', async () => {
    const store = storeSpy(verdict(REJECTED_VERDICT, { notes: 'misses ac-2' }));
    const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      verdict: 'rejected',
      payload: { accepted_by: CUSTOMER, notes: 'misses ac-2', ts: TS },
    });
  });

  test('abandon settles terminal — terminal word, customer-signed', async () => {
    const store = storeSpy(verdict('abandon'));
    const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      verdict: 'abandon',
      payload: { accepted_by: CUSTOMER, ts: TS },
    });
  });

  test('wrong accepted_by fails closed — the run does not move', async () => {
    const store = storeSpy(verdict('accepted', { accepted_by: 'worker-7' }));
    const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      alert: PARK_ALERTS.customerMismatch,
      detail: 'verdict signed by "worker-7" — run customer is "customer-1"',
    });
  });

  test('rejected without notes fails closed — no scopeless fix round', async () => {
    const store = storeSpy(verdict(REJECTED_VERDICT));
    const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      alert: PARK_ALERTS.fixNotesMissing,
      detail: "accept.rejected requires non-empty notes — the customer's fix scope",
    });
  });

  test('rejected with blank-string notes fails closed the same way', async () => {
    const store = storeSpy(verdict(REJECTED_VERDICT, { notes: '   ' }));
    const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
      call(verifyJournal())
    );
    assert.deepEqual(res, {
      alert: PARK_ALERTS.fixNotesMissing,
      detail: "accept.rejected requires non-empty notes — the customer's fix scope",
    });
  });

  const MALFORMED: [string, unknown][] = [
    ['a bare string', 'accepted'],
    ['a record with a non-enum verdict', verdict('lgtm')],
    ['a record missing accepted_by', verdict('accepted', { accepted_by: undefined })],
    ['a record naming another item', verdict('accepted', { item: 'bro-other' })],
    ['a record missing item', verdict('accepted', { item: undefined })],
    ['a record with non-string notes', verdict('accepted', { notes: 3 })],
    ['a record with non-string ts', verdict('accepted', { ts: 3 })],
  ];
  for (const [what, raw] of MALFORMED) {
    test(`malformed verdict record — ${what} → verdict-malformed`, async () => {
      const store = storeSpy(raw);
      const res = await acceptStage({ emit: emitSpy().fn, verdictStore: store.fn }).recheck?.(
        call(verifyJournal())
      );
      assert.equal((res as { alert?: string }).alert, PARK_ALERTS.verdictMalformed);
    });
  }

  test('a run with no recorded customer fails closed BEFORE emit', async () => {
    const emit = emitSpy();
    const store = storeSpy(verdict('accepted', { accepted_by: 'anybody' }));
    const res = await acceptStage({ emit: emit.fn, verdictStore: store.fn }).invoke(
      call(verifyJournal(), { customer: undefined })
    );
    assert.deepEqual(res, {
      alert: PARK_ALERTS.customerMismatch,
      detail: 'run has no recorded customer — no identity can sign accept',
    });
    assert.equal(emit.calls.length, 0); // no evidence leaks to a gate nobody can pass
    assert.equal(store.s.calls, 0);
  });

  test('a malformed freshest diff/draft_pr throws — stale evidence never ships', async () => {
    const j = verifyJournal(rec(2, 'review', 'push', { intent: 'judge', payload: { diff: 42 } }));
    await assert.rejects(
      async () => acceptStage({ emit: emitSpy().fn, verdictStore: storeSpy().fn }).invoke(call(j)),
      /malformed diff/
    );
    const j2 = verifyJournal(rec(2, 'work', 'done', { intent: 'spawn', payload: { draft_pr: 9 } }));
    await assert.rejects(
      async () => acceptStage({ emit: emitSpy().fn, verdictStore: storeSpy().fn }).invoke(call(j2)),
      /malformed draft_pr/
    );
  });
});

describe('accept — through the runner', () => {
  /** Engines for a work→verify→accept→merge→capture slice — enough
   *  graph to drive accept inside the runner without a spawn seam. */
  const SLICE = parsePipelineFormula(
    parse(`
version = 1
[[stages]]
name = "verify"
engine = "e2e"
verdicts = ["verified", "failed"]
[[stages]]
name = "accept"
engine = "accept"
verdicts = ["accepted", "rejected", "abandon"]
[[stages]]
name = "merge"
engine = "act-gate"
verdicts = ["landed", "dropped"]
[[stages]]
name = "capture"
engine = "learn"
verdicts = ["captured"]
[transitions]
verify = { verified = "accept", failed = "park" }
accept = { accepted = "merge", rejected = "verify", abandon = "abandon" }
merge = { landed = "capture", dropped = "close" }
capture = { captured = "end" }
`)
  );

  const spy = (res: EngineResult, calls: StageCall[] = []) => ({
    calls,
    fn: async (call: StageCall): Promise<EngineResult> => {
      calls.push(call);
      return res;
    },
  });

  const sliceRun = (
    journal: PipelineJournal,
    accept: EngineMap['accept'],
    opts: Record<string, unknown> = {}
  ) =>
    runPipeline(SLICE, ITEM, {
      engines: {
        e2e: spy({ verdict: 'verified', payload: VERIFY_ROWS }).fn,
        accept,
        'act-gate': spy({ verdict: 'landed' }).fn,
        learn: spy({ verdict: 'captured', payload: { lessons: 0, followups: [] } }).fn,
      },
      journal,
      formulaSha: SHA,
      customer: CUSTOMER,
      ...opts,
    });

  const sliceResume = (
    journal: PipelineJournal,
    accept: EngineMap['accept'],
    opts: Record<string, unknown> = {}
  ) =>
    resumePipeline(SLICE, ITEM, journal, {
      engines: {
        e2e: spy({ verdict: 'verified', payload: VERIFY_ROWS }).fn,
        accept,
        'act-gate': spy({ verdict: 'landed' }).fn,
        learn: spy({ verdict: 'captured', payload: { lessons: 0, followups: [] } }).fn,
      },
      journal,
      formulaSha: SHA,
      customer: CUSTOMER,
      ...opts,
    });

  test('emit → pending park → customer accept → merge → end', async () => {
    const j = memoryJournal('r1');
    const emit = emitSpy();
    const store = storeSpy();
    const accept = acceptStage({ emit: emit.fn, verdictStore: store.fn });
    const res = await sliceRun(j, accept);
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'accept');
    assert.equal(res.alert, undefined); // a suspension, not a park alert
    // the pending emit intent is the journal tail — no verdict row
    const tail = journalRecords(j.rows()).at(-1);
    assert.equal(tail?.stage, 'accept');
    assert.equal(tail?.intent, 'emit');
    assert.equal(tail?.verdict, undefined);
    assert.equal(emit.calls.length, 1);
    assert.equal(emit.calls[0]?.bundle.verify[0]?.verdict, 'verified');

    // the customer lands the verdict; a wake settles it and walks on
    store.s.current = verdict('accepted');
    const res2 = await sliceResume(j, accept);
    assert.equal(res2.outcome, 'end');
    const recs = journalRecords(j.rows());
    assert.deepEqual(
      recs.map(r => [r.stage, r.verdict]),
      [
        ['verify', 'verified'],
        ['accept', 'accepted'],
        ['merge', 'landed'],
        ['capture', 'captured'],
      ]
    );
    // journaled with accepted_by — the spec's ledger shape
    const settled = recs.find(r => r.stage === 'accept');
    assert.ok(settled !== undefined);
    assert.equal((settled.payload as { accepted_by: string }).accepted_by, CUSTOMER);
    assert.equal(emit.calls.length, 1); // settled on recheck — no re-emit
  });

  test('rejected re-enters the scoped-fix path with the customer notes', async () => {
    const j = memoryJournal('r1');
    const store = storeSpy();
    const accept = acceptStage({ emit: emitSpy().fn, verdictStore: store.fn });
    const res = await sliceRun(j, accept);
    assert.equal(res.outcome, 'park');
    store.s.current = verdict(REJECTED_VERDICT, { notes: 'redo the ac' });
    const res2 = await sliceResume(j, accept);
    // reject → verify re-entry (this slice's fix target) with the
    // notes carried as the fix scope — bounded by fix rounds
    assert.equal(res2.outcome, 'park');
    const recs = journalRecords(j.rows());
    const fix = recs.find(r => r.fix_round === 1);
    assert.equal(fix?.notes, 'redo the ac');
    // AND the rejection itself is spent: the SAME record is still the
    // channel's latest, but a verdict settles one accept entry only —
    // the re-entered gate parks on a pending emit waiting for a FRESH
    // customer decision instead of re-consuming the stale rejection
    // (each reuse would burn a fix round until exhaustion)
    assert.equal(res2.stage, 'accept');
    assert.equal(res2.alert, undefined); // a suspension, not a failure
    assert.equal(Math.max(...recs.map(r => r.fix_round ?? 0)), 1);
    const tail = recs.at(-1);
    assert.equal(tail?.stage, 'accept');
    assert.equal(tail?.intent, 'emit');
    assert.equal(tail?.verdict, undefined);
    // a fresh record settles the re-entered gate — same verdict word,
    // new ts = a new customer decision the gate honours
    store.s.current = verdict(REJECTED_VERDICT, {
      notes: 'still wrong',
      ts: '2026-11-07T00:00:00Z',
    });
    const res3 = await sliceResume(j, accept);
    // …and THAT one re-scopes too — the consumption ledger keeps
    // exactly-once per record, not per verdict word
    const recs3 = journalRecords(j.rows());
    assert.equal(recs3.filter(r => r.fix_round === 2).length > 0, true);
    assert.equal(res3.outcome, 'park');
  });

  test('a mismatched signer parks the run with a journal alert — no movement', async () => {
    const j = memoryJournal('r1');
    const store = storeSpy();
    const accept = acceptStage({ emit: emitSpy().fn, verdictStore: store.fn });
    const res = await sliceRun(j, accept);
    assert.equal(res.outcome, 'park');
    store.s.current = verdict('accepted', { accepted_by: 'worker-7' });
    const res2 = await sliceResume(j, accept);
    assert.equal(res2.outcome, 'park');
    assert.equal(res2.alert, PARK_ALERTS.customerMismatch);
    const recs = journalRecords(j.rows());
    assert.ok(recs.every(r => r.stage !== 'merge')); // the run did NOT move
    const alert = recs.at(-1);
    assert.equal(alert?.alert, PARK_ALERTS.customerMismatch);
    assert.equal(alert?.resume, 'accept');
  });

  test('abandon is terminal — the run closes, merge never sees it', async () => {
    const j = memoryJournal('r1');
    const store = storeSpy(verdict('abandon'));
    const accept = acceptStage({ emit: emitSpy().fn, verdictStore: store.fn });
    const res = await sliceRun(j, accept);
    // pre-landed verdict: invoke emits, settles, transitions — no park
    assert.equal(res.outcome, 'abandon');
    const recs = journalRecords(j.rows());
    assert.equal(recs.at(-1)?.verdict, 'abandon');
    assert.ok(recs.every(r => r.stage !== 'merge'));
  });

  test('a malformed verdict in the channel parks with verdict-malformed', async () => {
    const j = memoryJournal('r1');
    const store = storeSpy();
    const accept = acceptStage({ emit: emitSpy().fn, verdictStore: store.fn });
    await sliceRun(j, accept);
    store.s.current = { kind: 'verdict', verdict: 'accepted' }; // no accepted_by
    const res2 = await sliceResume(j, accept);
    assert.equal(res2.outcome, 'park');
    assert.equal(res2.alert, PARK_ALERTS.verdictMalformed);
    // a corrected record on the next wake can still settle — the
    // alert was a repairable park, not a tombstone
    store.s.current = verdict('accepted');
    const res3 = await sliceResume(j, accept);
    assert.equal(res3.outcome, 'end');
  });
});

describe('customer channel — the durable carrier', () => {
  test('append + read round-trips verdict and answer records', () => {
    const dir = tmp();
    testRepoInit(dir);
    const file = customerChannelPath({ dir, runId: 'r1' });
    assert.ok(file !== null);
    assert.ok(file.endsWith(join('.git', 'bro', 'pipeline', 'r1.customer.jsonl')));
    appendCustomerRecord(file, {
      kind: 'verdict',
      item: ITEM,
      verdict: 'rejected',
      accepted_by: CUSTOMER,
      notes: 'no',
      ts: TS,
    });
    appendCustomerRecord(file, { kind: 'answer', item: ITEM, answers: { q1: 'a' }, ts: TS });
    const rows = readCustomerFile(file);
    assert.equal(rows.length, 2);
    // the verdict reader sees the last verdict candidate — answers
    // do not shadow it
    assert.deepEqual(latestVerdict(rows), {
      kind: 'verdict',
      item: ITEM,
      verdict: 'rejected',
      accepted_by: CUSTOMER,
      notes: 'no',
      ts: TS,
    });
  });

  test('fileVerdictStore binds the run channel — later verdict wins', () => {
    const dir = tmp();
    testRepoInit(dir);
    const file = customerChannelPath({ dir, runId: 'r1' });
    assert.ok(file !== null);
    const store = fileVerdictStore(dir);
    const c = call(memoryJournal('r1'), { dir });
    assert.equal(store(c), undefined); // nothing answered yet
    appendCustomerRecord(file, {
      kind: 'verdict',
      item: ITEM,
      verdict: 'accepted',
      accepted_by: 'other-run-signer',
      ts: TS,
    });
    assert.deepEqual(store(c), {
      kind: 'verdict',
      item: ITEM,
      verdict: 'accepted',
      accepted_by: 'other-run-signer',
      ts: TS,
    });
  });

  test('awaitingCustomerRuns finds the run parked at accept for the item', async () => {
    const dir = tmp();
    testRepoInit(dir);
    const j = openPipelineJournal({ dir, runId: 'run-9' });
    assert.ok(j !== null);
    j.append({
      run_id: 'run-9',
      item: ITEM,
      seq: 1,
      stage: 'accept',
      intent: 'emit',
      attempt: 1,
      formula_sha: SHA,
      ts: TS,
    });
    // a foreign item's pending accept never matches
    const hits = awaitingCustomerRuns(dir, { item: ITEM, stage: 'accept' });
    assert.deepEqual(hits, [{ runId: 'run-9', stage: 'accept', via: 'pending' }]);
    assert.deepEqual(awaitingCustomerRuns(dir, { item: 'other-item', stage: 'accept' }), []);
    // an accept-stage alert (customer-mismatch) still counts — the
    // corrected record is exactly what the wake needs
    j.append({
      run_id: 'run-9',
      item: ITEM,
      seq: 2,
      stage: 'accept',
      intent: 'alert',
      attempt: 1,
      alert: PARK_ALERTS.customerMismatch,
      resume: 'accept',
      formula_sha: SHA,
      ts: TS,
    });
    assert.deepEqual(awaitingCustomerRuns(dir, { item: ITEM, stage: 'accept' }), [
      { runId: 'run-9', stage: 'accept', via: 'alert' },
    ]);
  });
});
