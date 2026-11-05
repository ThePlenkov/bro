import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  DecideResult,
  JudgeAnswer,
  JudgeQuestion,
  ProviderEntry,
  RoutingTable,
  TaskRow,
} from '@broject/core';
import { parse } from 'smol-toml';
import { parsePipelineFormula } from '../formula.ts';
import { type JournalRow, memoryJournal } from '../journal.ts';
import {
  DEFAULT_ADMIT_INTENTS,
  PARK_ALERTS,
  type RunOptions,
  runPipeline,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { backlog, type JudgeSpy, judge, noul, row } from '../testkit.ts';
import { stageDispatch } from './classify.ts';
import {
  DEFAULT_MAX_DIFF_FILES,
  type ReviewDeps,
  type ReviewDiff,
  type ReviewPayload,
  reviewStage,
  UNCATEGORIZED_FIX_NOTES,
} from './review.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
const REVIEW_STAGE = FORMULA.stages[3];
const ITEM = 'bro-bb2';
const SHA = 'cafebabe';
const DIFF_TEXT = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';

/** Test providers — acp and api both carry the `call` surface the
 *  review chain validates (an api entry that could never spawn still
 *  reviews). */
const PROVIDERS: Record<string, ProviderEntry> = {
  pa: { type: 'acp', command: 'pa' },
  pb: {
    type: 'api',
    baseUrl: 'https://api.test',
    models: { m9: 'openai-compat' },
    model: 'm9',
  },
};

/** The review-capable providers list — routing.review.chain. */
const ROUTING: RoutingTable = {
  review: { chain: [{ provider: 'pa' }, { provider: 'pb', model: 'm9' }] },
};

const reviewDiff = (over: Partial<ReviewDiff> = {}): ReviewDiff => ({
  diff: DIFF_TEXT,
  files: ['x.ts'],
  worktree: '/wt/x',
  base: 'main',
  head: 'abc123',
  ...over,
});

/** A diff seam that records the calls it served. */
const diffSeam = (d: ReviewDiff | undefined = reviewDiff()) => {
  const calls: StageCall[] = [];
  return {
    calls,
    fn: (c: StageCall) => {
      calls.push(c);
      return d;
    },
  };
};

/** A JudgeSpy whose answers come from a per-call sequence — the last
 *  entry sticks (a re-review after the scripted fixes can answer the
 *  same way forever). Same spy shape the testkit's judge() plays. */
const seqJudge = (seq: Record<string, JudgeAnswer>[]): JudgeSpy => {
  const calls: JudgeSpy['calls'] = [];
  let i = 0;
  return {
    calls,
    facade: {
      decide: async (state, questions) => {
        calls.push({ state, questions });
        const res: DecideResult = {
          answers: seq[Math.min(i++, seq.length - 1)],
          model: 'fake-judge',
          latencyMs: 1,
          lowConfidence: [],
        };
        return res;
      },
    },
  };
};

const call = (over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: REVIEW_STAGE,
    attempt: 1,
    ctx: {},
    journal: memoryJournal(),
    ...over,
  }) as StageCall;

const deps = (
  j: JudgeSpy,
  b = backlog([row(ITEM)]),
  extra: Partial<ReviewDeps> = {}
): ReviewDeps => ({
  judge: j.facade,
  backlog: b,
  routing: ROUTING,
  providers: PROVIDERS,
  diff: () => reviewDiff(),
  ...extra,
});

const invoke = async (
  j: JudgeSpy,
  extra: Partial<ReviewDeps> = {},
  over: Partial<StageCall> = {},
  b = backlog([row(ITEM)])
) => reviewStage(deps(j, b, extra)).invoke(call(over));

describe('review — the decide', () => {
  test('state carries item + work ctx + diff provenance; questions are typed nouls', async () => {
    const j = judge({ push: noul(0.9) });
    const work = { verdict: 'done', worktree: '/wt/x', head: 'abc123' };
    await invoke(j, {}, { ctx: { work } });
    const state = j.calls[0].state as {
      item: TaskRow;
      work: Record<string, unknown>;
      diff: { text: string; truncated: boolean; files: string[]; worktree: string; head: string };
    };
    assert.equal(state.item.id, ITEM);
    assert.deepEqual(state.work, work);
    assert.equal(state.diff.text, DIFF_TEXT);
    assert.equal(state.diff.truncated, false);
    assert.deepEqual(state.diff.files, ['x.ts']);
    assert.equal(state.diff.worktree, '/wt/x');
    assert.equal(state.diff.head, 'abc123');
    const kinds = Object.keys(j.calls[0].questions).sort();
    assert.deepEqual(kinds, [
      'abandon',
      'finding_correctness',
      'finding_quality',
      'finding_safety',
      'finding_scope',
      'finding_tests',
      'push',
    ]);
    for (const q of Object.values(j.calls[0].questions)) {
      assert.equal((q as JudgeQuestion).type, 'noul');
    }
  });

  test('no work record in ctx → the state simply omits it', async () => {
    const j = judge({ push: noul(0.9) });
    await invoke(j);
    assert.equal((j.calls[0].state as Record<string, unknown>).work, undefined);
  });

  test('the diff text is capped — the state marks a truncated read', async () => {
    const j = judge({ push: noul(0.9) });
    const big = 'x'.repeat(300);
    await invoke(j, { diff: () => ({ diff: big }), maxDiffChars: 100 });
    const state = j.calls[0].state as { diff: { text: string; truncated: boolean } };
    assert.equal(state.diff.text.length, 100);
    assert.equal(state.diff.truncated, true);
  });

  test('a truncated diff demotes an affirmed push — the tail was never judged', async () => {
    const j = judge({ push: noul(0.9) });
    const res = await invoke(j, { diff: () => ({ diff: 'x'.repeat(300) }), maxDiffChars: 100 });
    const p = res.payload as ReviewPayload;
    // unreviewed content must not sail to merge on a prefix read:
    // push degrades to fix with the truncation note; the re-entered
    // work stage can shrink the diff, exhaustion parks
    assert.equal(res.verdict, 'fix');
    assert.match(p.notes ?? '', /exceeded the 100 char window — the tail was never judged/);
    assert.match(p.notes ?? '', /narrow the change below the window/); // the note tells the round how to converge
    assert.equal(p.diff?.truncated, true);
  });

  test('a journaled scoped-fix round rides the state — round + the notes it ran under', async () => {
    const j = judge({ push: noul(0.9) });
    const jn = memoryJournal('r1');
    const base: Omit<JournalRow, 'seq' | 'stage' | 'intent'> = {
      run_id: 'r1',
      item: ITEM,
      attempt: 1,
      formula_sha: SHA,
      ts: '2026-11-05T00:00:00Z',
    };
    jn.append({ ...base, seq: 1, stage: 'work', intent: 'spawn', verdict: 'done' });
    jn.append({ ...base, seq: 2, stage: 'review', intent: 'judge', verdict: 'fix' });
    jn.append({
      ...base,
      seq: 3,
      stage: 'work',
      intent: 'spawn',
      verdict: 'done',
      fix_round: 1,
      notes: 'fix the tests',
    });
    await invoke(j, {}, { journal: jn });
    const state = j.calls[0].state as { fix: { round: number; notes: string } };
    assert.deepEqual(state.fix, { round: 1, notes: 'fix the tests' });
  });

  test('the files list is bounded — the rest reads as a count', async () => {
    const j = judge({ push: noul(0.9) });
    const files = Array.from({ length: DEFAULT_MAX_DIFF_FILES + 11 }, (_, i) => `f${i}.ts`);
    await invoke(j, { diff: () => ({ diff: DIFF_TEXT, files }) });
    const state = j.calls[0].state as { diff: { files: string[]; fileCount: number } };
    assert.equal(state.diff.files.length, DEFAULT_MAX_DIFF_FILES);
    assert.equal(state.diff.fileCount, files.length);
  });
});

describe('review — the chain', () => {
  test('missing routing.review throws — no reviewer list, no attribution', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(
      () => invoke(j, { routing: { default: { chain: [{ provider: 'pa' }] } } }),
      /routing\.review is missing/
    );
    assert.equal(j.calls.length, 0); // fails before any decide
  });

  test('an empty review chain throws the same', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(
      () => invoke(j, { routing: { review: { chain: [] } } }),
      /routing\.review is missing/
    );
  });

  test('a chain entry naming an unconfigured provider throws naming the entry', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(
      () => invoke(j, { routing: { review: { chain: [{ provider: 'ghost' }] } } }),
      /routing\.review\.chain\[0\].*providers\.ghost is not configured/
    );
  });

  test('a walled chain head falls through — the next entry is attributed', async () => {
    const j = judge({ push: noul(0.9) });
    const res = await invoke(j, {
      walls: () => [{ provider: 'pa', cause: 'rate_limited' }],
    });
    const p = res.payload as ReviewPayload;
    assert.equal(res.verdict, 'push');
    assert.deepEqual(p.reviewer, { provider: 'pb', model: 'm9' }); // the pair: the pin belongs to pb
  });

  test('every entry walled throws — the bounded re-fire waits the wall out', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(
      () =>
        invoke(j, {
          walls: () => [
            { provider: 'pa', cause: 'rate_limited' },
            { provider: 'pb', cause: 'quota' },
          ],
        }),
      /every routing\.review\.chain entry is walled/
    );
  });
});

describe('review — verdicts', () => {
  test('affirmed push with no findings → push, reviewer slot stamped', async () => {
    const j = judge({ push: noul(0.9) });
    const res = await invoke(j);
    assert.equal(res.verdict, 'push');
    const p = res.payload as ReviewPayload;
    assert.equal(p.verdict, 'push');
    assert.equal(p.notes, undefined); // notes belong to fix
    assert.deepEqual(p.reviewer, { provider: 'pa' }); // chain head — first un-walled entry
    assert.deepEqual(p.judge, { model: 'fake-judge', decidedBy: 'fake' }); // the decide's own attribution
    assert.deepEqual(p.diff, {
      files: 1,
      truncated: false,
      worktree: '/wt/x',
      base: 'main',
      head: 'abc123',
    });
  });

  test('a mixed-decidedBy decide stamps only the model — no single connector to name', async () => {
    const mixed = judge({ push: noul(0.9) });
    mixed.facade = {
      decide: async (state, questions) => {
        mixed.calls.push({ state, questions });
        return {
          answers: {
            push: { ...noul(0.9), decidedBy: 'a' },
            abandon: { ...noul(0.2), decidedBy: 'b' },
          },
          model: 'fake-judge',
          latencyMs: 1,
          lowConfidence: [],
        };
      },
    };
    const res = await invoke(mixed);
    assert.deepEqual((res.payload as ReviewPayload).judge, { model: 'fake-judge' });
  });

  test('an affirmed finding → fix whose notes compose the kind rubric', async () => {
    const j = judge({ finding_tests: noul(0.9) });
    const res = await invoke(j);
    const p = res.payload as ReviewPayload;
    assert.equal(res.verdict, 'fix');
    assert.deepEqual(p.findings, ['tests']);
    assert.ok(p.notes !== undefined && p.notes !== '');
    assert.match(p.notes, /tests: behavior changed without the coverage/);
  });

  test('several findings join in declared order into one notes scope', async () => {
    const j = judge({
      finding_scope: noul(0.9),
      finding_correctness: noul(0.8),
      finding_tests: noul(0.7),
    });
    const res = await invoke(j);
    const p = res.payload as ReviewPayload;
    assert.deepEqual(p.findings, ['correctness', 'scope', 'tests']);
    assert.match(p.notes as string, /correctness: .*; scope: .*; tests:/);
  });

  test('affirmed abandon is terminal and outranks findings + push', async () => {
    const j = judge({
      abandon: noul(0.9),
      push: noul(0.9),
      finding_quality: noul(0.9),
    });
    const res = await invoke(j);
    const p = res.payload as ReviewPayload;
    assert.equal(res.verdict, 'abandon');
    assert.deepEqual(p.findings, ['quality']); // the postmortem record
    assert.equal(p.notes, undefined);
  });

  test('an affirmed finding outranks an affirmed push — the blocking read wins', async () => {
    const j = judge({ push: noul(0.9), finding_safety: noul(0.9) });
    const res = await invoke(j);
    assert.equal(res.verdict, 'fix');
    assert.match((res.payload as ReviewPayload).notes as string, /safety:/);
  });

  test('push confidently denied with no finding categorized → fix, generic scope', async () => {
    const j = judge({ push: noul(0.2) }); // read and denied — no dimming
    const res = await invoke(j);
    const p = res.payload as ReviewPayload;
    assert.equal(res.verdict, 'fix');
    assert.equal(p.notes, UNCATEGORIZED_FIX_NOTES);
    assert.equal(p.findings, undefined);
  });

  test('a dimmed push with no findings still fixes — never merges on a dim read', async () => {
    // the judge is alive (confident denials on abandon + a finding)
    // but its push read stayed under-confidence
    const j = judge({ push: noul(0.9, 0.1), abandon: noul(0.2), finding_tests: noul(0.2) }, [
      'push',
    ]);
    const res = await invoke(j);
    assert.equal(res.verdict, 'fix');
    assert.deepEqual((res.payload as ReviewPayload).lowConfidence, ['push']);
  });

  test('a dimmed finding drops for that question — affirmed push still pushes', async () => {
    const j = judge({ push: noul(0.9), finding_tests: noul(0.9, 0.1) }, ['finding_tests']);
    const res = await invoke(j);
    const p = res.payload as ReviewPayload;
    assert.equal(res.verdict, 'push');
    assert.equal(p.findings, undefined);
    assert.deepEqual(p.lowConfidence, ['finding_tests']);
  });

  test('a decide with zero confident gating answers throws — the diff was never read', async () => {
    const j = judge({ push: noul(0.9, 0.1), finding_tests: noul(0.9, 0.1) }, [
      'push',
      'finding_tests',
      'abandon',
      'finding_correctness',
      'finding_scope',
      'finding_safety',
      'finding_quality',
    ]);
    await assert.rejects(() => invoke(j), /never read/);
  });
});

describe('review — seams', () => {
  test('missing item throws — a phantom is never reviewed', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(() => invoke(j, {}, {}, backlog([])), /not in the backlog/);
  });

  test('the diff seam returning nothing throws — no artifact, no verdict', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(() => invoke(j, { diff: () => undefined }), /no reviewable artifact/);
    assert.equal(j.calls.length, 0);
  });

  test('a maxDiffChars that cannot trip throws — NaN would silently unbound the window', async () => {
    const j = judge({ push: noul(0.9) });
    await assert.rejects(
      () => invoke(j, { maxDiffChars: Number.NaN }),
      /maxDiffChars must be a non-negative integer/
    );
    await assert.rejects(
      () => invoke(j, { maxDiffChars: -5 }),
      /maxDiffChars must be a non-negative integer/
    );
    assert.equal(j.calls.length, 0); // never reaches the judge
  });

  test('an empty diff is still a reviewable fact — the decide runs', async () => {
    const j = judge({ push: noul(0.9) });
    const res = await invoke(j, { diff: () => ({ diff: '' }) });
    assert.equal(res.verdict, 'push');
    assert.equal((j.calls[0].state as { diff: { text: string } }).diff.text, '');
  });

  test('the seam sees the call — ctx.work and the journal reach it', async () => {
    const j = judge({ push: noul(0.9) });
    const seam = diffSeam();
    const jn = memoryJournal('r1');
    const work = { verdict: 'done', worktree: '/wt/x' };
    await invoke(j, { diff: seam.fn }, { ctx: { work }, journal: jn });
    assert.equal(seam.calls.length, 1);
    assert.equal(seam.calls[0].item, ITEM);
    assert.deepEqual(seam.calls[0].ctx.work, work);
    assert.equal(seam.calls[0].journal, jn);
  });
});

describe('review inside runPipeline — the full DAG', () => {
  const solo = (complexity: 'cheap' | 'complex') => () => ({
    verdict: 'solo',
    payload: { group: 'solo', complexity, rank: 3 },
  });
  const spawned = () => ({
    verdict: 'spawn',
    // provider 'pb' ≠ the reviewer's chain head 'pa' — the flat merge
    // must not let review's attribution clobber route's spawn slot
    payload: { class: 'default', kind: 'k', orch: 'exec', timing: 'now', provider: 'pb' },
  });

  const runDag = (
    j: JudgeSpy,
    complexity: 'cheap' | 'complex',
    opts: Partial<RunOptions> = {},
    extraDeps: Partial<ReviewDeps> = {}
  ) =>
    runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      ...opts,
      engines: {
        judge: stageDispatch(
          {
            classify: solo(complexity),
            route: spawned,
            review: reviewStage(deps(j, backlog([row(ITEM)]), extraDeps)),
          },
          DEFAULT_ADMIT_INTENTS
        ),
        fleet: () => ({ verdict: 'done' }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });

  test('complex → review runs → push → merge → end', async () => {
    const j = judge({ push: noul(0.9) });
    const res = await runDag(j, 'complex');
    assert.equal(res.outcome, 'end');
    assert.equal(j.calls.length, 1);
    const p = res.ctx.review as ReviewPayload;
    assert.equal(p.verdict, 'push');
    assert.deepEqual(p.reviewer, { provider: 'pa' });
    assert.equal(res.ctx.provider, 'pb'); // route's spawn slot survives the flat merge
  });

  test('cheap → the gate synthesizes skip — the review engine never runs', async () => {
    const j = judge({});
    const seam = diffSeam();
    const res = await runDag(j, 'cheap', {}, { diff: seam.fn });
    assert.equal(res.outcome, 'end');
    assert.equal(j.calls.length, 0);
    assert.equal(seam.calls.length, 0);
    assert.equal(res.ctx.review, undefined);
  });

  test('fix → work re-enters with notes + fix_round → done → re-review → push → end', async () => {
    // first decide finds a blocking finding, the re-review pushes
    const j = seqJudge([{ finding_tests: noul(0.9) }, { push: noul(0.9) }]);
    const workCalls: StageCall[] = [];
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines: {
        judge: stageDispatch(
          {
            classify: solo('complex'),
            route: spawned,
            review: reviewStage(deps(j, backlog([row(ITEM)]))),
          },
          DEFAULT_ADMIT_INTENTS
        ),
        fleet: (c: StageCall) => {
          workCalls.push(c);
          return { verdict: 'done' };
        },
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });
    assert.equal(res.outcome, 'end');
    assert.equal(workCalls.length, 2); // the run + the scoped-fix round
    const fix = workCalls[1];
    assert.equal(fix.fixRound, 1);
    assert.match(fix.notes as string, /tests: behavior changed/);
    // the re-review saw the round it was judging under
    assert.deepEqual((j.calls[1].state as { fix: unknown }).fix, {
      round: 1,
      notes: fix.notes,
    });
  });

  test('abandon → terminal failure, merge never runs', async () => {
    const j = judge({ abandon: noul(0.9) });
    let gated = 0;
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines: {
        judge: stageDispatch(
          {
            classify: solo('complex'),
            route: spawned,
            review: reviewStage(deps(j, backlog([row(ITEM)]))),
          },
          DEFAULT_ADMIT_INTENTS
        ),
        fleet: () => ({ verdict: 'done' }),
        'act-gate': () => {
          gated += 1;
          return { verdict: 'landed' };
        },
        learn: () => ({ verdict: 'captured' }),
      },
    });
    assert.equal(res.outcome, 'abandon');
    assert.equal(res.verdict, 'abandon');
    assert.equal(gated, 0);
  });

  test('repeated fix verdicts are bounded — fixRounds exhaustion parks', async () => {
    const j = judge({ finding_quality: noul(0.9) }); // every review finds it
    const res = await runDag(j, 'complex', { fixRounds: 1 });
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.fixRoundsExhausted);
    assert.equal(j.calls.length, 2); // first review + the re-review after round 1
  });
});
