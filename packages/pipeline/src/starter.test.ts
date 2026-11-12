import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { testRepoInit } from '@broject/core';
import { parse } from 'smol-toml';
import { formulaSha, type PipelineFormula, parsePipelineFormula } from './formula.ts';
import { fileJournal, pipelineDir, type JournalRow } from './journal.ts';
import { type RunOptions, type RunResult, runPipeline } from './runner.ts';
import { liveRunItems, startRuns, writeFormulaSidecar } from './starter.ts';
import { SPEC_FORMULA } from './spec-formula.fixture.ts';

/** The spec's own formula — the graph every starter test drives, and
 *  the sha the run must stamp on every journal row. */
const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const SHA = formulaSha(SPEC_FORMULA);
const BYTES = SPEC_FORMULA;

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-starter-'));
  testRepoInit(dir);
  return dir;
};

/** A scripted runPipeline — records every (item, opts) and plays the
 *  queued RunResults; a queued Error throws (the per-item isolation
 *  path). */
const runSpy = (results: (Partial<RunResult> | Error)[] = []) => {
  const calls: { item: string; opts: RunOptions }[] = [];
  const run: typeof runPipeline = async (
    _formula: PipelineFormula,
    item: string,
    opts: RunOptions
  ): Promise<RunResult> => {
    calls.push({ item, opts });
    const next = results.length > 0 ? results.shift()! : { outcome: 'park' as const };
    if (next instanceof Error) {
      throw next;
    }
    return {
      runId: `run-${item}`,
      item,
      outcome: next.outcome ?? 'park',
      stage: next.stage ?? 'classify',
      ctx: {},
      ...next,
    } as RunResult;
  };
  return { calls, run };
};

/** One journaled row for `liveRunItems`/dedup tests — appended straight
 *  to `<runId>.journal.jsonl` under the repo's pipeline dir. */
const journalRow = (runId: string, item: string, r: Partial<JournalRow>): JournalRow => ({
  run_id: runId,
  item,
  seq: r.seq ?? 1,
  stage: r.stage ?? 'classify',
  intent: r.intent ?? 'judge',
  attempt: 1,
  ...(r.verdict !== undefined ? { verdict: r.verdict } : {}),
  ...(r.alert !== undefined ? { alert: r.alert } : {}),
  formula_sha: SHA,
  ts: '2026-01-01T00:00:00.000Z',
  ...r,
});

const writeRun = (dir: string, runId: string, rows: JournalRow[]): void => {
  const d = pipelineDir({ dir });
  assert.ok(d !== null);
  const j = fileJournal(join(d, `${runId}.journal.jsonl`));
  for (const r of rows) {
    j.append(r);
  }
};

describe('startRuns — queue → runPipeline', () => {
  test('empty queue → empty report, no runPipeline calls', async () => {
    const dir = tmp();
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: [],
      run: spy.run,
    });
    assert.equal(res.scanned, 0);
    assert.equal(res.started, 0);
    assert.deepEqual(res.items, []);
    assert.equal(spy.calls.length, 0);
  });

  test('a queued item starts a run — customer + formulaSha + engines bound', async () => {
    const dir = tmp();
    const engines = { judge: async () => ({ verdict: 'solo' }) };
    const spy = runSpy([{ outcome: 'park', stage: 'accept', runId: 'run-1' }]);
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      formulaBytes: BYTES,
      customer: 'petr',
      engines,
      items: ['bro-1'],
      run: spy.run,
    });
    assert.equal(res.started, 1);
    assert.equal(res.items[0]!.action, 'started');
    assert.equal(res.items[0]!.runId, 'run-1');
    assert.equal(spy.calls.length, 1);
    const { item, opts } = spy.calls[0]!;
    assert.equal(item, 'bro-1');
    assert.equal(opts.customer, 'petr');
    assert.equal(opts.formulaSha, SHA);
    assert.equal(opts.dir, dir);
    assert.equal(opts.engines, engines);
  });

  test('formulaSha is the loaded sha on EVERY call — never empty', async () => {
    const dir = tmp();
    const spy = runSpy();
    await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['a', 'b', 'c'],
      run: spy.run,
    });
    assert.equal(spy.calls.length, 3);
    for (const c of spy.calls) {
      assert.equal(c.opts.formulaSha, SHA);
      assert.notEqual(c.opts.formulaSha, '');
    }
  });

  test('the <runId>.formula.toml sidecar lands with the raw bytes', async () => {
    const dir = tmp();
    const spy = runSpy([{ runId: 'runX' }]);
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      formulaBytes: BYTES,
      engines: {},
      items: ['bro-9'],
      run: spy.run,
    });
    assert.equal(res.items[0]!.sidecar, true);
    const d = pipelineDir({ dir });
    const sidecar = readFileSync(join(d!, 'runX.formula.toml'), 'utf8');
    assert.equal(sidecar, BYTES);
  });

  test('admit / maxInFlight / ctx pass through to RunOptions', async () => {
    const dir = tmp();
    const admit = () => true as const;
    const spy = runSpy();
    await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-2'],
      runOptions: { admit, maxInFlight: 4, ctx: { seed: 1 } },
      run: spy.run,
    });
    const opts = spy.calls[0]!.opts;
    assert.equal(opts.admit, admit);
    assert.equal(opts.maxInFlight, 4);
    assert.deepEqual(opts.ctx, { seed: 1 });
  });
});

describe('startRuns — dedup against live runs', () => {
  test('an item with a live journaled run is already-running — no second start', async () => {
    const dir = tmp();
    // a pending intent = live (crash window / in-flight)
    writeRun(dir, 'R1', [journalRow('R1', 'bro-live', { intent: 'judge' })]);
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-live', 'bro-free'],
      run: spy.run,
    });
    const byItem = new Map(res.items.map(i => [i.item, i.action]));
    assert.equal(byItem.get('bro-live'), 'already-running');
    assert.equal(byItem.get('bro-free'), 'started');
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0]!.item, 'bro-free');
  });

  test('a parked run still counts as live — the waker owns it', async () => {
    const dir = tmp();
    // alert row = fail-closed park → live
    writeRun(dir, 'R2', [
      journalRow('R2', 'bro-parked', { stage: 'accept', intent: 'emit', alert: 'stage-saturated' }),
    ]);
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-parked'],
      run: spy.run,
    });
    assert.equal(res.items[0]!.action, 'already-running');
    assert.equal(spy.calls.length, 0);
  });

  test('a terminal (end) run releases the item — it can start again', async () => {
    const dir = tmp();
    // capture → end is the terminal-done transition
    writeRun(dir, 'R3', [
      journalRow('R3', 'bro-done', { stage: 'capture', intent: 'learn', verdict: 'captured' }),
    ]);
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-done'],
      run: spy.run,
    });
    assert.equal(res.items[0]!.action, 'started');
    assert.equal(spy.calls.length, 1);
  });

  test('a close/abandon tail also releases; a stage-transition tail stays live', async () => {
    const dir = tmp();
    writeRun(dir, 'R4', [
      journalRow('R4', 'bro-closed', { stage: 'classify', intent: 'judge', verdict: 'duplicate' }),
    ]);
    writeRun(dir, 'R5', [
      journalRow('R5', 'bro-moving', { stage: 'route', intent: 'judge', verdict: 'spawn' }),
    ]);
    const live = liveRunItems(dir, FORMULA);
    assert.equal(live.has('bro-closed'), false); // duplicate → close = terminal
    assert.equal(live.has('bro-moving'), true); // spawn → intake = mid-transit = live
  });
});

describe('startRuns — failure isolation + dry-run', () => {
  test('a runPipeline throw is a failed row — the queue continues', async () => {
    const dir = tmp();
    const spy = runSpy([new Error('journal exploded'), { outcome: 'end', stage: 'capture' }]);
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bad', 'good'],
      run: spy.run,
    });
    const byItem = new Map(res.items.map(i => [i.item, i]));
    assert.equal(byItem.get('bad')!.action, 'failed');
    assert.match(byItem.get('bad')!.error!, /journal exploded/);
    assert.equal(byItem.get('good')!.action, 'started');
    assert.equal(res.started, 1);
  });

  test('dryRun reports would-start/already-running — runPipeline never invoked', async () => {
    const dir = tmp();
    writeRun(dir, 'R1', [journalRow('R1', 'bro-live', { intent: 'judge' })]);
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-live', 'bro-new'],
      dryRun: true,
      run: spy.run,
    });
    assert.equal(res.dryRun, true);
    assert.equal(res.started, 0);
    const byItem = new Map(res.items.map(i => [i.item, i.action]));
    assert.equal(byItem.get('bro-live'), 'already-running');
    assert.equal(byItem.get('bro-new'), 'would-start');
    assert.equal(spy.calls.length, 0);
  });

  test('duplicate + empty candidates collapse before scanning', async () => {
    const dir = tmp();
    const spy = runSpy();
    const res = await startRuns({
      dir,
      formula: { formula: FORMULA, sha: SHA },
      engines: {},
      items: ['bro-x', 'bro-x', '  ', ''],
      run: spy.run,
    });
    assert.equal(res.scanned, 1);
    assert.equal(spy.calls.length, 1);
  });
});

describe('liveRunItems / writeFormulaSidecar', () => {
  test('liveRunItems is empty outside a pipeline plane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-starter-nogit-'));
    // not a git repo → pipelineDir null → empty set, never throws
    assert.equal(liveRunItems(dir, FORMULA).size, 0);
  });

  test('writeFormulaSidecar writes bytes; returns false outside a repo', () => {
    const dir = tmp();
    assert.equal(writeFormulaSidecar(dir, 'runZ', BYTES), true);
    const d = pipelineDir({ dir });
    assert.equal(readFileSync(join(d!, 'runZ.formula.toml'), 'utf8'), BYTES);
    const plain = mkdtempSync(join(tmpdir(), 'pipeline-starter-nogit2-'));
    assert.equal(writeFormulaSidecar(plain, 'runZ', BYTES), false);
  });
});
