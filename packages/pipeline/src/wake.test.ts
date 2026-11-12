/**
 * run-waker suite — specs/bro-v0pvd.3.md. The scan discovers
 * (run,item) anchors off the journal plane, the wake conditions gate
 * `resumePipeline` on world-state probes + the customer channel,
 * and the `<run>.wake.json` sig gate makes every pass idempotent.
 * Hermetic: fake journal dirs, scripted engines, injected probes.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { testRepoInit } from '@broject/core';
import { parse } from 'smol-toml';
import { appendCustomerRecord, customerChannelPath, fileVerdictStore } from './customer.ts';
import { parsePipelineFormula } from './formula.ts';
import { appendJournalRow, type JournalRow, pipelineDir } from './journal.ts';
import {
  type EngineFn,
  type EngineMap,
  type RunResult,
  resumePipeline,
  type StageCall,
} from './runner.ts';
import { SPEC_FORMULA } from './spec-formula.fixture.ts';
import { acceptStage } from './stages/accept.ts';
import { type ResolvedRun, scanPipelineRuns, type WakeDeps, wakePipeline } from './wake.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const SHA = 'cafebabe';
const CUSTOMER = 'customer-1';
const ITEM = 'bro-wake1';
const TS = '2026-01-01T00:00:00.000Z';

const tmp = () => mkdtempSync(join(tmpdir(), 'pipeline-wake-'));

/** A repo with an empty pipeline plane. */
const repo = () => {
  const dir = tmp();
  testRepoInit(dir);
  const d = pipelineDir({ dir });
  assert.ok(d !== null);
  return { dir, d };
};

const row = (over: Partial<JournalRow>): JournalRow => ({
  run_id: 'R1',
  item: ITEM,
  seq: 1,
  stage: 'classify',
  intent: 'judge',
  attempt: 1,
  formula_sha: SHA,
  ts: TS,
  customer: CUSTOMER,
  ...over,
});

/** A journal file's rows — seqs auto-assigned unless overridden. */
const writeRun = (
  d: string,
  runId: string,
  item: string,
  stages: { stage: string; intent: string; verdict?: string; extra?: Partial<JournalRow> }[]
): void => {
  const file = join(d, `${runId}.journal.jsonl`);
  stages.forEach((s, i) => {
    appendJournalRow(
      file,
      row({
        run_id: runId,
        item,
        seq: i + 1,
        stage: s.stage,
        intent: s.intent,
        ...(s.verdict !== undefined ? { verdict: s.verdict } : {}),
        ...s.extra,
      })
    );
  });
};

/** A settled-tail run parked at accept's emit — the customer-wait
 *  anchor every verdict test shares. */
const acceptPending = (d: string, runId = 'R1', item = ITEM): void =>
  writeRun(d, runId, item, [
    { stage: 'classify', intent: 'judge', verdict: 'solo' },
    { stage: 'route', intent: 'judge', verdict: 'spawn' },
    { stage: 'intake', intent: 'spec', verdict: 'accepted' },
    { stage: 'work', intent: 'spawn', verdict: 'done' },
    { stage: 'verify', intent: 'verify', verdict: 'verified' },
    { stage: 'review', intent: 'judge', verdict: 'push' },
    { stage: 'accept', intent: 'emit' }, // verdict-less — the pending anchor
  ]);

/** Engines that carry a resume from accept's settle to `end`:
 *  merge→landed, capture→captured. Everything before the anchor is
 *  already journaled — only post-anchor stages run. */
const tailEngines = (): EngineMap => ({
  'act-gate': (async () => ({ verdict: 'landed' })) as EngineFn,
  learn: (async () => ({ verdict: 'captured' })) as EngineFn,
});

const noKey = (): string | undefined => undefined;

/** The resolver every test shares — the run spec is ambient here;
 *  prod binds it from the formula sidecar + engine module (.10). */
const resolver =
  (dir: string, engines: EngineMap, formulaSha = SHA): WakeDeps['resolve'] =>
  async (): Promise<ResolvedRun | undefined> => ({
    formula: FORMULA,
    opts: { engines, dir, formulaSha, admit: () => true },
  });

const verdictRecord = (item: string, verdict: string) => ({
  kind: 'verdict' as const,
  item,
  verdict,
  accepted_by: CUSTOMER,
  ts: TS,
});

describe('scanPipelineRuns', () => {
  test('discovers one view per (run,item) with the collapsed tail', () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'route', intent: 'judge' }, // pending — the tail
    ]);
    writeRun(d, 'R2', 'bro-other', [{ stage: 'work', intent: 'spawn' }]);
    const views = scanPipelineRuns(dir);
    assert.equal(views.length, 2);
    const v1 = views.find(v => v.runId === 'R1');
    assert.ok(v1);
    assert.equal(v1.item, ITEM);
    assert.equal(v1.tail.intent, 'judge');
    assert.equal(v1.tail.verdict, undefined);
    assert.equal(v1.formulaSha, SHA);
    assert.equal(v1.customer, CUSTOMER);
  });

  test('outside a repo the plane is empty', () => {
    assert.deepEqual(scanPipelineRuns(tmp()), []);
  });
});

describe('wakePipeline — anchor classes', () => {
  test('a terminal run is skipped — never a wake candidate', async () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [{ stage: 'capture', intent: 'capture', verdict: 'captured' }]);
    const report = await wakePipeline({
      dir,
      resolve: resolver(dir, {}),
    });
    assert.equal(report.scanned, 1);
    assert.equal(report.runs[0].action, 'skipped');
    assert.match(report.runs[0].detail ?? '', /terminal/);
  });

  test('formula drift skips — the waker never wakes a stale spec', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    const report = await wakePipeline({
      dir,
      resolve: resolver(dir, tailEngines(), 'other-sha'),
    });
    assert.equal(report.runs[0].action, 'skipped');
    assert.match(report.runs[0].detail ?? '', /drift/);
  });

  test('an unresolvable run waits for the next pass — never deduped', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    const report = await wakePipeline({ dir, resolve: async () => undefined });
    assert.equal(report.runs[0].action, 'unresolved');
  });

  test('crash-mid-drive residue (settled → stage) always wakes once, then the world decides', async () => {
    const { dir, d } = repo();
    // verify settled 'verified' → transition 'review' — the drive died
    // before review's intent landed. The payload carries complexity so
    // review's gate_on passes and the judge actually invokes.
    writeRun(d, 'R1', ITEM, [
      {
        stage: 'verify',
        intent: 'verify',
        verdict: 'verified',
        extra: { payload: { complexity: 'complex' } },
      },
    ]);
    const engines = tailEngines();
    // review(judge) + accept(emit pending, no verdict) park the run —
    // judge 'push' → accept → emit → pending
    const calls: string[] = [];
    engines.judge = (async (call: StageCall) => {
      calls.push(call.stage.name);
      return { verdict: 'push' };
    }) as EngineFn;
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    engines.fleet = (async () => ({ verdict: 'done' })) as EngineFn;
    engines.e2e = (async () => ({ verdict: 'verified' })) as EngineFn;
    engines.intake = (async () => ({ verdict: 'accepted' })) as EngineFn;
    let resumes = 0;
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      resume: async (f, i, j, o) => {
        resumes += 1;
        return resumePipeline(f, i, j, o);
      },
    };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0].action, 'woken');
    assert.equal(resumes, 1);
    assert.deepEqual(calls, ['review']); // resume re-entered at review
    // the run is now pending-emit with no verdict — second pass waits,
    // no second resume (the sig gate + fresh channel agree)
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'waiting');
    assert.equal(resumes, 1);
  });
});

describe('wakePipeline — customer channel', () => {
  test('pending emit waits for a verdict; the verdict wakes and settles the gate', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    const engines = tailEngines();
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    let resumes = 0;
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      // pin the clock at the tail's stamp — age bucket 0, so ONLY a
      // verdict can wake this anchor (the re-emit cadence is covered
      // by its own test)
      now: () => Date.parse(TS) + 100,
      resume: async (f, i, j, o) => {
        resumes += 1;
        return resumePipeline(f, i, j, o);
      },
    };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0].action, 'waiting');
    assert.equal(resumes, 0);
    // the customer signs — next pass wakes, accept settles 'accepted',
    // merge→capture run to end
    const channel = customerChannelPath({ dir, runId: 'R1' });
    assert.ok(channel !== null);
    appendCustomerRecord(channel, verdictRecord(ITEM, 'accepted'));
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'woken');
    assert.equal(resumes, 1);
    // the run ended — a third pass finds no live anchor for it
    const r3 = await wakePipeline(deps);
    const row = r3.runs.find(r => r.item === ITEM);
    assert.ok(row === undefined || row.action === 'skipped');
  });

  test('a stale pending emit re-fires on the re-emit cadence (crash-window emit)', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    const emitCalls: unknown[] = [];
    const engines = tailEngines();
    engines.accept = acceptStage({
      emit: async (_c, bundle) => {
        emitCalls.push(bundle);
      },
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      reemitMs: 1000, // 1s cadence — the 2026-01-01 tail is ancient
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    };
    const r = await wakePipeline(deps);
    assert.equal(r.runs[0].action, 'woken');
    assert.equal(emitCalls.length, 1); // the recheck re-emitted idempotently
    // and it re-parked pending — the next pass dedupes on the same
    // world (same channel hash, same age bucket)
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'waiting');
  });

  test('intake questions park waits on pending answers, wakes on one', async () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'route', intent: 'judge', verdict: 'spawn' },
      { stage: 'intake', intent: 'spec', verdict: 'questions' }, // → park
    ]);
    const intakeCalls: string[] = [];
    const engines = tailEngines();
    engines.judge = (async () => ({ verdict: 'push' })) as EngineFn;
    engines.intake = (async call => {
      intakeCalls.push(call.stage.name);
      return { verdict: 'accepted' };
    }) as EngineFn;
    engines.fleet = (async () => ({ verdict: 'done' })) as EngineFn;
    engines.e2e = (async () => ({ verdict: 'verified' })) as EngineFn;
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    const deps: WakeDeps = { dir, resolve: resolver(dir, engines) };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0].action, 'waiting');
    assert.match(r1.runs[0].detail ?? '', /answers/);
    assert.equal(intakeCalls.length, 0);
    const channel = customerChannelPath({ dir, runId: 'R1' });
    assert.ok(channel !== null);
    appendCustomerRecord(channel, {
      kind: 'answer',
      item: ITEM,
      answers: { q1: 'the spec field' },
      ts: TS,
    });
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'woken');
    assert.ok(intakeCalls.length >= 1); // intake re-entered and answered
  });
});

describe('wakePipeline — act-gate PR seam', () => {
  test('pending gate waits on the probe; unbound probe never guesses', async () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'route', intent: 'judge', verdict: 'spawn' },
      { stage: 'intake', intent: 'spec', verdict: 'accepted' },
      { stage: 'work', intent: 'spawn', verdict: 'done' },
      { stage: 'verify', intent: 'verify', verdict: 'verified' },
      { stage: 'review', intent: 'judge', verdict: 'push' },
      { stage: 'accept', intent: 'emit', verdict: 'accepted' },
      { stage: 'merge', intent: 'gate' }, // pending act-gate probe
    ]);
    const engines = tailEngines();
    // no prSettled probe → unevaluated wait, retried each pass
    const r1 = await wakePipeline({ dir, resolve: resolver(dir, engines) });
    assert.equal(r1.runs[0].action, 'waiting');
    assert.match(r1.runs[0].detail ?? '', /probe/);
    // probe says still settling → evaluated wait (sig stored)
    let settled = false;
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      probes: { prSettled: async () => settled },
    };
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'waiting');
    // probe flips → wake; merge's gate engine settles 'landed' → capture → end
    settled = true;
    engines['act-gate'] = (async () => ({ verdict: 'landed' })) as EngineFn;
    engines.learn = (async () => ({ verdict: 'captured' })) as EngineFn;
    const r3 = await wakePipeline(deps);
    assert.equal(r3.runs[0].action, 'woken');
  });
});

describe('wakePipeline — provider walls + capacity', () => {
  test('route queue onwall waits while the provider is walled, wakes when it lifts', async () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      {
        stage: 'route',
        intent: 'judge',
        verdict: 'queue',
        extra: {
          payload: {
            reason: 'onwall',
            provider: 'devin',
            wall: { provider: 'devin', cause: 'rate_limited', until: '2026-01-02T00:00:00.000Z' },
          },
        },
      }, // → park
    ]);
    const engines = tailEngines();
    engines.judge = (async () => ({ verdict: 'spawn' })) as EngineFn;
    engines.intake = (async () => ({ verdict: 'accepted' })) as EngineFn;
    engines.fleet = (async () => ({ verdict: 'done' })) as EngineFn;
    engines.e2e = (async () => ({ verdict: 'verified' })) as EngineFn;
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    let walls: { provider: string; cause: 'rate_limited'; until?: string }[] = [
      { provider: 'devin', cause: 'rate_limited', until: '2026-01-02T00:00:00.000Z' },
    ];
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      probes: { walls: async () => walls },
    };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0].action, 'waiting');
    assert.match(r1.runs[0].detail ?? '', /walled/);
    walls = []; // the wall lifted — next pass wakes, route re-dispatches
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0].action, 'woken');
  });

  test('route queue chain-spent re-asks route while walls stand — the payload names no slot', async () => {
    const { dir, d } = repo();
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      {
        stage: 'route',
        intent: 'judge',
        verdict: 'queue',
        // chain-spent payloads carry no provider — route.ts's dispatch
        // returns bare {verdict:'queue', reason:'chain-spent'}
        extra: { payload: { reason: 'chain-spent', class: 'solo' } },
      }, // → park
    ]);
    const engines = tailEngines();
    engines.judge = (async () => ({ verdict: 'spawn' })) as EngineFn;
    engines.intake = (async () => ({ verdict: 'accepted' })) as EngineFn;
    engines.fleet = (async () => ({ verdict: 'done' })) as EngineFn;
    engines.e2e = (async () => ({ verdict: 'verified' })) as EngineFn;
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    // a wall still stands — but with no recorded slot the waker
    // re-asks route to re-walk the chain rather than waiting for
    // EVERY wall to clear (a freed chain member may already dispatch)
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      probes: {
        walls: async () => [{ provider: 'devin', cause: 'rate_limited' as const }],
      },
    };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0].action, 'woken');
    // the same wall set must not re-fire per tick — the reduced sig
    // ({a,w}) dedupes the still-spent re-park
    const r2 = await wakePipeline(deps);
    assert.notEqual(r2.runs[0].action, 'failed');
  });

  test('stage-saturated alert waits for journaled capacity, wakes when a seat frees', async () => {
    const { dir, d } = repo();
    // the candidate: parked at the work door by in_flight=1 saturation
    writeRun(d, 'CAND', 'bro-cand', [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'route', intent: 'judge', verdict: 'spawn' },
      { stage: 'intake', intent: 'spec', verdict: 'accepted' },
      {
        stage: 'work',
        intent: 'alert',
        extra: {
          alert: 'stage-saturated',
          resume: 'work',
          detail: 'in_flight 1 reached',
        },
      },
    ]);
    // the occupant: a pending spawn intent at work — moving + holding
    // the stage seat (flowTail's crash-window rule)
    writeRun(d, 'SIB', 'bro-sib', [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'route', intent: 'judge', verdict: 'spawn' },
      { stage: 'intake', intent: 'spec', verdict: 'accepted' },
      { stage: 'work', intent: 'spawn' }, // pending — occupies
    ]);
    const engines = tailEngines();
    engines.judge = (async () => ({ verdict: 'push' })) as EngineFn;
    // a recheck-capable fleet handler: the sibling's pending spawn
    // attests "didn't land" (undefined) → bounded refire → invoke
    // 'done' → the flow walks on to accept's emit wait, which holds
    // NO seat (the customer-wait exception) — the work seat frees.
    // (A hook-less spawn would halt recheck-unavailable with NO row —
    // the intent stays the anchor and correctly dedupes forever.)
    engines.fleet = {
      invoke: (async () => ({ verdict: 'done' })) as EngineFn,
      recheck: async () => undefined,
    };
    engines.e2e = (async () => ({ verdict: 'verified' })) as EngineFn;
    engines.intake = (async () => ({ verdict: 'accepted' })) as EngineFn;
    engines.accept = acceptStage({
      emit: async () => {},
      verdictStore: fileVerdictStore(dir),
      keyFor: noKey,
    });
    const deps: WakeDeps = { dir, resolve: resolver(dir, engines) };
    // pass 1: the sibling's pending spawn wakes (registry signal) and
    // walks to its accept wait; the candidate still sees the
    // scan-time occupancy → waits. Order-independent: the snapshot is
    // taken before either resume.
    const r1 = await wakePipeline(deps);
    const sib1 = r1.runs.find(r => r.runId === 'SIB');
    const cand1 = r1.runs.find(r => r.runId === 'CAND');
    assert.equal(sib1?.action, 'woken');
    assert.equal(cand1?.action, 'waiting');
    assert.match(cand1?.detail ?? '', /capacity/);
    // pass 2: the sibling now waits on the customer (moving:false) —
    // no seat — the candidate's saturation clears and it resumes
    const r2 = await wakePipeline(deps);
    const cand2 = r2.runs.find(r => r.runId === 'CAND');
    assert.equal(cand2?.action, 'woken');
  });
});

describe('wakePipeline — durability', () => {
  test('a failed resume retries next pass (the failed mark bypasses the sig gate)', async () => {
    const { dir, d } = repo();
    // the firing anchor: intake questions parked, answer already given
    writeRun(d, 'R2', 'bro-q', [{ stage: 'intake', intent: 'spec', verdict: 'questions' }]);
    const engines = tailEngines();
    engines.intake = (async () => ({ verdict: 'declined' })) as EngineFn; // → close, ends the run
    const channel = customerChannelPath({ dir, runId: 'R2' });
    assert.ok(channel !== null);
    appendCustomerRecord(channel, {
      kind: 'answer',
      item: 'bro-q',
      answers: 'yes',
      ts: TS,
    });
    let calls = 0;
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, engines),
      resume: async (f, i, j, o) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('transient');
        }
        return resumePipeline(f, i, j, o);
      },
    };
    const r1 = await wakePipeline(deps);
    const q1 = r1.runs.find(r => r.runId === 'R2');
    assert.equal(q1?.action, 'failed');
    assert.match(q1?.detail ?? '', /transient/);
    const r2 = await wakePipeline(deps);
    const q2 = r2.runs.find(r => r.runId === 'R2');
    assert.equal(q2?.action, 'woken'); // retried despite identical inputs
    assert.equal(calls, 2);
  });

  test('a held wake.lock makes the pass a no-op', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    // a FOREIGN holder — the lock dir with a live pid entry (the
    // in-process holdFileLock is re-entrant and can't fake this)
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(d, 'wake.lock'), { recursive: true });
    writeFileSync(join(d, 'wake.lock', `h-${process.ppid}`), 'foreign');
    const report = await wakePipeline({ dir, resolve: resolver(dir, tailEngines()) });
    assert.equal(report.locked, true);
    assert.equal(report.scanned, 0);
    const { rmSync } = await import('node:fs');
    rmSync(join(d, 'wake.lock'), { recursive: true, force: true });
    const report2 = await wakePipeline({ dir, resolve: resolver(dir, tailEngines()) });
    assert.equal(report2.locked, false);
    assert.equal(report2.scanned, 1);
  });
});

describe('wakePipeline — pass robustness', () => {
  /** A resume spy that attests nothing — the journal tail stands, so
   *  only the sig gate decides whether the anchor re-wakes. */
  const parkedResume = (): { fn: WakeDeps['resume']; calls: () => number } => {
    let calls = 0;
    const fn: WakeDeps['resume'] = async () => {
      calls += 1;
      return { item: ITEM, outcome: 'park', stage: 'x', ctx: {} } as RunResult;
    };
    return { fn, calls: () => calls };
  };

  test('a throwing probe fails THIS run — the pass still serves the rest', async () => {
    const { dir, d } = repo();
    // R1: pending act-gate intent — its probe throws
    writeRun(d, 'R1', ITEM, [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'merge', intent: 'gate' },
    ]);
    // R2: pending emit with no verdict — an ordinary wait
    writeRun(d, 'R2', 'bro-wait', [
      { stage: 'classify', intent: 'judge', verdict: 'solo' },
      { stage: 'accept', intent: 'emit' },
    ]);
    const report = await wakePipeline({
      dir,
      resolve: resolver(dir, tailEngines()),
      // pin the clock at the tail's stamp — R2's emit stays bucket-0
      // (no verdict → a plain wait, no resume)
      now: () => Date.parse(TS) + 100,
      probes: {
        prSettled: async () => {
          throw new Error('probe exploded');
        },
      },
    });
    const r1 = report.runs.find(r => r.runId === 'R1');
    const r2 = report.runs.find(r => r.runId === 'R2');
    assert.equal(r1?.action, 'failed');
    assert.match(r1?.detail ?? '', /decide: probe exploded/);
    assert.equal(r2?.action, 'waiting'); // the loop carried on
  });

  test('an unreadable journal file is skipped + reported, not fatal', async () => {
    const { dir, d } = repo();
    acceptPending(d, 'R1');
    // a DIRECTORY wearing the journal suffix — readdir lists it,
    // fileJournal's read throws EISDIR (not ENOENT)
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(d, 'BROKEN.journal.jsonl'));
    const bad: string[] = [];
    const views = scanPipelineRuns(dir, f => bad.push(f));
    assert.deepEqual(bad, ['BROKEN.journal.jsonl']);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.runId, 'R1');
    const report = await wakePipeline({
      dir,
      resolve: resolver(dir, tailEngines()),
      now: () => Date.parse(TS) + 100, // keep the emit anchor waiting — this test is about the scan
    });
    assert.deepEqual(report.unreadable, ['BROKEN.journal.jsonl']);
    assert.equal(report.scanned, 1);
  });

  test('a same-process second pass reports locked — the file lock is re-entrant', async () => {
    const { dir, d } = repo();
    acceptPending(d);
    const resume = parkedResume();
    const deps: WakeDeps = { dir, resolve: resolver(dir, tailEngines()), resume: resume.fn };
    // p1 runs its synchronous prefix (lock + scan + inflight mark)
    // before its first await — p2 must see the in-flight pass
    const p1 = wakePipeline(deps);
    const p2 = wakePipeline(deps);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r2.locked, true);
    assert.equal(r2.scanned, 0);
    assert.equal(r1.locked, false);
    assert.equal(r1.scanned, 1);
  });

  test('a static pending tail re-asks once per reemitMs, never per tick', async () => {
    const { dir, d } = repo();
    // crash-mid-invoke residue on a synchronous engine — the fallthrough
    writeRun(d, 'R1', ITEM, [{ stage: 'review', intent: 'judge' }]);
    const resume = parkedResume();
    const t0 = Date.parse('2026-06-01T00:00:00.000Z');
    let now = t0;
    const deps: WakeDeps = {
      dir,
      resolve: resolver(dir, tailEngines()),
      resume: resume.fn,
      reemitMs: 60_000,
      now: () => now,
    };
    const r1 = await wakePipeline(deps);
    assert.equal(r1.runs[0]?.action, 'woken');
    assert.equal(resume.calls(), 1);
    // same world, same bucket → deduped
    const r2 = await wakePipeline(deps);
    assert.equal(r2.runs[0]?.action, 'waiting');
    assert.equal(resume.calls(), 1);
    // the tail never moved but the cadence bucket rolled — one re-ask
    now = t0 + 60_000;
    const r3 = await wakePipeline(deps);
    assert.equal(r3.runs[0]?.action, 'woken');
    assert.equal(resume.calls(), 2);
  });

  test('an unreadable customer channel fails only the anchors that read it', async () => {
    const { dir, d } = repo();
    // crash-mid-drive residue — its decision never touches the channel
    writeRun(d, 'R1', ITEM, [{ stage: 'review', intent: 'judge' }]);
    // a DIRECTORY wearing the channel file's name — readFileSync
    // throws EISDIR, which channelRows propagates like any seam
    const channel = customerChannelPath({ dir, runId: 'R1' });
    assert.ok(channel !== null);
    mkdirSync(channel);
    const resume = parkedResume();
    const report = await wakePipeline({
      dir,
      resolve: resolver(dir, tailEngines()),
      resume: resume.fn,
    });
    // the crash-resume anchor doesn't consume channel rows — the
    // unreadable file must not fail it
    assert.equal(report.runs[0]?.action, 'woken');
    assert.equal(resume.calls(), 1);
  });
});
