/** The runner's occupancy suite — the journaled semaphore the
 *  `limits.in_flight` + stage `concurrency` caps read: sibling-run
 *  journal files ARE the plane, a pending accept `emit` is a customer
 *  wait not work, and a settled emit re-passes admission rather than
 *  walking in over another flow's seat. Split out of runner.test.ts —
 *  the seam needs its own file the same way the checks do. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { testRepoInit } from '@broject/core';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from './formula.ts';
import {
  appendJournalRow,
  fileJournal,
  type JournalRow,
  memoryJournal,
  pipelineDir,
} from './journal.ts';
import {
  type EngineFn,
  type EngineResult,
  type RunOptions,
  resumePipeline,
  runPipeline,
  SATURATION_ALERT,
  type StageCall,
} from './runner.ts';

const SHA = 'deadbeef';

interface Spy {
  calls: StageCall[];
  fn: EngineFn;
}

/** A scripted engine — answers each call with the next queued result;
 *  `calls` records every invocation for assertions. 'pending' is a
 *  valid EngineOutcome — the run parks leaving a verdict-less intent. */
const spy = (results: (EngineResult | Error | 'pending')[], calls: StageCall[] = []): Spy => ({
  calls,
  fn: async call => {
    calls.push(call);
    const next = results.shift();
    if (next === undefined) throw new Error(`scripted engine exhausted at ${call.stage.name}`);
    if (next instanceof Error) throw next;
    return next;
  },
});

/** accept → merge — the customer-wait → next-door shape the
 *  re-admission tests drive ('accepted' wants merge's door). */
const ACCEPT_MERGE = parsePipelineFormula(
  parse(`
version = 1
[[stages]]
name = "accept"
engine = "accept"
verdicts = ["accepted"]
[[stages]]
name = "merge"
engine = "judge"
verdicts = ["done"]
[transitions]
accept = { accepted = "merge" }
merge = { done = "end" }
`)
);

/** A two-stage flow — `a` admits into `b`, the capped stage. */
const capped = (limits: string, stageCap?: number) =>
  parsePipelineFormula(
    parse(`
version = 1
${limits}
[[stages]]
name = "a"
engine = "judge"
verdicts = ["go"]
[[stages]]
name = "b"
engine = "judge"
verdicts = ["done"]${stageCap === undefined ? '' : `\nconcurrency = ${stageCap}`}
[transitions]
a = { go = "b" }
b = { done = "end" }
`)
  );

/** One journaled seat — the row shape a foreign run's occupation
 *  carries: a verdict-less intent pends between invoke and its settled
 *  transition out ('judge' mid-stage, 'emit' the customer wait); a
 *  `verdict` settles it — `done` → `end` frees the slot. `item`
 *  defaults to the `${runId}-item` convention; a test that attributes
 *  the row explicitly overrides it. */
const seat = (r: {
  runId: string;
  stage: string;
  intent: 'judge' | 'emit';
  verdict?: string;
  item?: string;
  seq?: number;
  ts?: string;
}): JournalRow => ({
  run_id: r.runId,
  item: r.item ?? `${r.runId}-item`,
  seq: r.seq ?? 1,
  stage: r.stage,
  intent: r.intent,
  attempt: 1,
  ...(r.verdict !== undefined ? { verdict: r.verdict } : {}),
  formula_sha: SHA,
  ts: r.ts ?? '2026-01-01T00:00:00.000Z',
});

/** An accept engine whose `recheck` settles `verdict` — the wake
 *  never invokes (a pending intent is rechecked, never re-fired). */
const acceptRecheck = (verdict: string) => ({
  invoke: async () => 'pending' as const,
  recheck: () => ({ verdict }),
});

/** A wake on `item-A`'s journal — the accept engine settles the
 *  pending emit to `accepted` and the merge engine is the spy. */
const resumeA = (j: ReturnType<typeof memoryJournal>, judge: Spy) =>
  resumePipeline(ACCEPT_MERGE, 'item-A', j, {
    engines: { accept: acceptRecheck('accepted'), judge: judge.fn },
    runId: 'A',
    formulaSha: SHA,
  });

describe('declared concurrency — the journaled occupancy semaphore', () => {
  test('serial default — a second item cannot enter while one is moving', async () => {
    const j = memoryJournal();
    j.append(seat({ runId: 'A', stage: 'a', intent: 'judge' })); // A mid-stage at `a`
    const judge = spy([]); // B must never reach an engine
    const res = await runPipeline(capped(''), 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(res.stage, 'a'); // parked at the entry door — no in_flight slot
    assert.equal(judge.calls.length, 0);
  });

  test('explicit in_flight=2 admits two — B flows through the occupied stage', async () => {
    const j = memoryJournal();
    j.append(seat({ runId: 'A', stage: 'b', intent: 'judge' })); // A sits inside `b`
    const judge = spy([{ verdict: 'go' }, { verdict: 'done' }]);
    const res = await runPipeline(capped('[limits]\nin_flight = 2'), 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'end');
    assert.deepEqual(
      judge.calls.map(c => c.stage.name),
      ['a', 'b'] // B entered `b` alongside A — cap = min(in_flight) = 2
    );
  });

  test('a stage cap narrower than in_flight holds the second item at the door', async () => {
    const j = memoryJournal();
    j.append(seat({ runId: 'A', stage: 'b', intent: 'judge' }));
    const formula = capped('[limits]\nin_flight = 3', 1);
    const judge = spy([{ verdict: 'go' }]); // `b` must never be invoked for B
    const res = await runPipeline(formula, 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(res.stage, 'b'); // waited at b's door, not the pipeline's
    assert.deepEqual(
      judge.calls.map(c => c.stage.name),
      ['a']
    );

    // the occupant's verdict transitions it out — the slot-free wake
    j.append(seat({ runId: 'A', stage: 'b', intent: 'judge', verdict: 'done' }));
    const judge2 = spy([{ verdict: 'done' }]);
    const woken = await resumePipeline(formula, 'item-B', j, {
      engines: { judge: judge2.fn },
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(woken.outcome, 'end');
    assert.equal(judge2.calls[0].stage.name, 'b'); // re-entered at the door it parked at
  });

  test('a stage cap wider than in_flight never widens the pipeline', async () => {
    const j = memoryJournal();
    j.append(seat({ runId: 'A', stage: 'b', intent: 'judge' }));
    // B enters `b` alongside A (b cap = min(9, 2) = 2), then pends —
    // its verdict-less intent keeps it moving + occupying
    const judge = spy([{ verdict: 'go' }, 'pending']);
    const formula = capped('[limits]\nin_flight = 2', 9);
    const parked = await runPipeline(formula, 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(parked.outcome, 'park');
    // C is a third item — both slots are spent even though `b` could
    // hold 9: the pipeline cap is the contract, not the stage's
    const judgeC = spy([]);
    const res = await runPipeline(formula, 'item-C', {
      engines: { judge: judgeC.fn },
      journal: j,
      runId: 'C',
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(res.stage, 'a');
    assert.equal(judgeC.calls.length, 0);
  });

  test('the machine budget narrows the formula cap — min(contract, machine)', async () => {
    const j = memoryJournal();
    j.append(seat({ runId: 'A', stage: 'a', intent: 'judge' }));
    const judge = spy([]);
    const res = await runPipeline(capped('[limits]\nin_flight = 3'), 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
      maxInFlight: 1, // the box runs one, whatever the formula allows
    });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(judge.calls.length, 0);
  });

  test('occupancy counts survive a journal reload — the semaphore is the disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-occ-'));
    const file = join(dir, 'shared.journal.jsonl');
    fileJournal(file).append(seat({ runId: 'A', stage: 'b', intent: 'judge' }));
    // a fresh reader = a new process's view: A still occupies `b`
    const judge = spy([{ verdict: 'go' }]);
    const formula = capped('[limits]\nin_flight = 3', 1);
    const parked = await runPipeline(formula, 'item-B', {
      engines: { judge: judge.fn },
      journal: fileJournal(file),
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(parked.outcome, 'park');
    assert.equal(parked.alert, SATURATION_ALERT);
    assert.equal(parked.stage, 'b');
    // the occupant's verdict frees the slot — another reload, the
    // counts are recomputed from the journaled rows, not memory
    fileJournal(file).append(seat({ runId: 'A', stage: 'b', intent: 'judge', verdict: 'done' }));
    const judge2 = spy([{ verdict: 'done' }]);
    const woken = await resumePipeline(formula, 'item-B', fileJournal(file), {
      engines: { judge: judge2.fn },
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(woken.outcome, 'end');
    assert.equal(judge2.calls[0].stage.name, 'b');
  });

  test('the pipeline dir IS the occupancy view — sibling run files count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-occ-'));
    testRepoInit(dir);
    const d = pipelineDir({ dir });
    assert.ok(d !== null);
    const fileA = join(d, 'A.journal.jsonl');
    // run A sits mid-stage — a DIFFERENT journal file than B's. The
    // default binding opens only B.journal.jsonl; the dir scan is
    // what lets the semaphore see A at all
    const aRow = (r: { seq: number; stage: string; verdict?: string }) =>
      appendJournalRow(
        fileA,
        seat({
          runId: 'A',
          item: 'item-A',
          intent: 'judge',
          ts: `2026-01-01T00:00:0${r.seq}.000Z`,
          ...r,
        })
      );
    const runB = (engines: RunOptions['engines']) =>
      runPipeline(capped(''), 'item-B', { engines, dir, runId: 'B', formulaSha: SHA });
    // the resume re-opens B's own file AND still sees the sibling
    const resumeB = (engines: RunOptions['engines']) =>
      resumePipeline(capped(''), 'item-B', fileJournal(join(d, 'B.journal.jsonl')), {
        engines,
        dir,
        runId: 'B',
        formulaSha: SHA,
      });
    aRow({ seq: 1, stage: 'a' });
    const judge = spy([]); // B must never reach an engine
    const res = await runB({ judge: judge.fn });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(res.stage, 'a'); // parked at the entry door
    assert.equal(judge.calls.length, 0);
    // A's verdict moves it to `b` — still moving, the slot stays spent
    aRow({ seq: 1, stage: 'a', verdict: 'go' });
    const res2 = await resumeB({ judge: judge.fn });
    assert.equal(res2.outcome, 'park');
    assert.equal(res2.alert, SATURATION_ALERT);
    assert.equal(judge.calls.length, 0);
    // A settles `b → end`: the slot frees, B walks the refused stage
    aRow({ seq: 2, stage: 'b', verdict: 'done' });
    const judge2 = spy([{ verdict: 'go' }, { verdict: 'done' }]);
    const res3 = await resumeB({ judge: judge2.fn });
    assert.equal(res3.outcome, 'end');
    assert.deepEqual(
      judge2.calls.map(c => c.stage.name),
      ['a', 'b']
    );
  });

  test('an accept emit suspension frees the in_flight lane — a customer wait is not work', async () => {
    const j = memoryJournal();
    // a run suspended at the customer gate — the pending `emit`
    // intent parks for an unbounded wait the same way intake's
    // settled `questions` verdict does; it must not pin the only slot
    j.append(seat({ runId: 'A', stage: 'accept', intent: 'emit' }));
    const judge = spy([{ verdict: 'go' }, { verdict: 'done' }]);
    const res = await runPipeline(capped(''), 'item-B', {
      engines: { judge: judge.fn },
      journal: j,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(res.outcome, 'end'); // admitted — the waiting gate is not moving
    assert.deepEqual(
      judge.calls.map(c => c.stage.name),
      ['a', 'b']
    );
    // …but the stage seat still counts: an `a`-named stage capped at 1
    // and occupied by a suspended emit keeps its occupant
    const j2 = memoryJournal();
    j2.append(seat({ runId: 'A', stage: 'b', intent: 'emit' }));
    const judge2 = spy([{ verdict: 'go' }]); // `b` must never fire for B
    const res2 = await runPipeline(capped('[limits]\nin_flight = 3', 1), 'item-B', {
      engines: { judge: judge2.fn },
      journal: j2,
      runId: 'B',
      formulaSha: SHA,
    });
    assert.equal(res2.outcome, 'park');
    assert.equal(res2.alert, SATURATION_ALERT);
    assert.equal(res2.stage, 'b'); // the suspended gate still holds its seat
    assert.deepEqual(
      judge2.calls.map(c => c.stage.name),
      ['a']
    );
  });

  test('an unreadable pipeline dir fails CLOSED — the semaphore never admits blind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-occ-'));
    testRepoInit(dir);
    const d = pipelineDir({ dir });
    assert.ok(d !== null);
    // `bro` exists but is a FILE — the pipeline dir beneath it is a
    // path through a non-directory: readdirSync throws ENOTDIR, not
    // ENOENT ("no dir yet" is the only absence that means alone).
    // A memory journal keeps the bind clean so the dir scan itself is
    // the code under test — narrowing to the run's own rows here would
    // let the semaphore admit past cap on an empty view.
    writeFileSync(dirname(d), 'not a dir');
    const judge = spy([{ verdict: 'go' }, { verdict: 'done' }]);
    await assert.rejects(
      () =>
        runPipeline(capped(''), 'item-A', {
          engines: { judge: judge.fn },
          journal: memoryJournal(),
          dir,
          runId: 'A',
          formulaSha: SHA,
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOTDIR'
    );
    assert.equal(judge.calls.length, 0); // refused at the door, never reached an engine
  });

  test("an unreadable sibling journal fails closed — same contract as the run's own file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-occ-'));
    testRepoInit(dir);
    const d = pipelineDir({ dir });
    assert.ok(d !== null);
    // a directory wearing a journal's name — readFileSync throws
    // EISDIR, and the scan propagates it like the run's own unreadable
    // file would (only ENOENT is "absent"; a present-but-unreadable
    // plane is never an empty plane)
    mkdirSync(join(d, 'evil.journal.jsonl'), { recursive: true });
    const judge = spy([{ verdict: 'go' }, { verdict: 'done' }]);
    await assert.rejects(
      () =>
        runPipeline(capped(''), 'item-A', {
          engines: { judge: judge.fn },
          journal: memoryJournal(),
          dir,
          runId: 'A',
          formulaSha: SHA,
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === 'EISDIR'
    );
    assert.equal(judge.calls.length, 0);
  });

  test('a settled accept re-passes admission — the verdict ended the wait, not claimed a lane', async () => {
    const j = memoryJournal();
    // A suspended at the customer gate — the emit wait holds its
    // accept SEAT but never took an in_flight lane; B moved in while
    // A waited — the serial lane is spent
    j.append(seat({ runId: 'A', item: 'item-A', stage: 'accept', intent: 'emit' }));
    j.append(seat({ runId: 'B', item: 'item-B', stage: 'merge', intent: 'judge' }));
    // A's verdict lands — the recheck settles the emit and the wake
    // wants merge. A settled customer wait is NOT a held lane: B's
    // seat wins, A parks at the door instead of walking in over it
    const judge = spy([]); // merge must never fire for A
    const res = await resumeA(j, judge);
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, SATURATION_ALERT);
    assert.equal(res.stage, 'merge'); // refused at merge's door
    assert.equal(judge.calls.length, 0);
    // …and once B's lane frees, the SAME wake shape admits A into merge
    j.append(
      seat({ runId: 'B', item: 'item-B', stage: 'merge', intent: 'judge', verdict: 'done' })
    );
    const judge2 = spy([{ verdict: 'done' }]);
    const res2 = await resumeA(j, judge2);
    assert.equal(res2.outcome, 'end');
    assert.deepEqual(
      judge2.calls.map(c => c.stage.name),
      ['merge']
    );
  });
});
