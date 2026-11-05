import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type TaskSpec, testRepoInit } from '@broject/core';
import { parse } from 'smol-toml';
import {
  type AnswerFeed,
  appendCustomerRecord,
  type CustomerAnswer,
  customerChannelPath,
  fileAnswerFeed,
} from '../customer.ts';
import { parsePipelineFormula } from '../formula.ts';
import { journalRecords, memoryJournal } from '../journal.ts';
import {
  PARK_ALERTS,
  type RunOptions,
  resumePipeline,
  runPipeline,
  type StageCall,
} from '../runner.ts';
import { SPEC_FORMULA } from '../spec-formula.fixture.ts';
import { row, settled, type SpecStoreSpy, specStore } from '../testkit.ts';
import {
  ANSWERS_HEADING,
  DECLINED_HEADING,
  type IntakeDeps,
  type IntakeOutcome,
  type IntakePayload,
  intakeStage,
  QUESTIONS_HEADING,
} from './intake.ts';

const FORMULA = parsePipelineFormula(parse(SPEC_FORMULA));
// by name, never by index — a stage-order change in SPEC_FORMULA must
// not silently retarget the stage under test
const INTAKE_STAGE = FORMULA.stages.find(s => s.name === 'intake');
if (INTAKE_STAGE === undefined) {
  throw new Error('SPEC_FORMULA lost its intake stage');
}
const ITEM = 'bro-ii3';
const SHA = 'cafebabe';

/** A two-stage intake→work formula — enough graph to drive the
 *  verdicts through the runner ('spec' intent is not spawn-like, but
 *  work's 'spawn' is — `admit` is bound). */
const INTAKE_FORMULA = parsePipelineFormula(
  parse(`
version = 1
[[stages]]
name = "intake"
engine = "intake"
verdicts = ["accepted", "questions", "declined"]
[[stages]]
name = "work"
engine = "fleet"
verdicts = ["done"]
[transitions]
intake = { accepted = "work", questions = "park", declined = "close" }
work = { done = "end" }
`)
);

/** A spec-bearing item — the carrier convention (`## Acceptance` /
 *  `## DoR` / `## Scenarios` sections in the body). */
const SPEC_BODY = [
  'Implement the thing — context prose.',
  '',
  '## Acceptance',
  '- the thing works',
  '- the thing is tested',
  '',
  '## DoR',
  'spec carries AC the worker can verify',
  '',
  '## Scenarios',
  '- happy path',
].join('\n');

interface IntakeSpy {
  calls: { call: StageCall; spec: TaskSpec }[];
  fn: IntakeDeps['intake'];
}

/** A scripted judgment seam — outcomes come from a per-call sequence
 *  (the last entry sticks), every seen spec recorded for assertions.
 *  Same spy shape the testkit's judge() plays. */
const intakeSpy = (out: IntakeOutcome | IntakeOutcome[]): IntakeSpy => {
  const seq = Array.isArray(out) ? out : [out];
  const calls: IntakeSpy['calls'] = [];
  let i = 0;
  return {
    calls,
    fn: async (call, spec) => {
      calls.push({ call, spec });
      return seq[Math.min(i++, seq.length - 1)];
    },
  };
};

const call = (over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: 'r1',
    item: ITEM,
    stage: INTAKE_STAGE,
    attempt: 1,
    ctx: {},
    journal: memoryJournal(),
    ...over,
  }) as StageCall;

const deps = (spy: IntakeSpy, specs: SpecStoreSpy, feed?: AnswerFeedSpy): IntakeDeps => ({
  taskSpec: specs,
  intake: spy.fn,
  ...(feed !== undefined ? { answers: feed.fn } : {}),
});

/** A mutable answer feed — `records` is what the next invoke drains;
 *  `consumed` counts the drain-point stamps. */
interface AnswerFeedSpy {
  s: { records: unknown[]; consumed: number };
  fn: NonNullable<IntakeDeps['answers']>;
}

const feedSpy = (records: unknown[] = []): AnswerFeedSpy => {
  const s = { records, consumed: 0 };
  return {
    s,
    fn: async (_call: StageCall): Promise<AnswerFeed> => ({
      records: s.records,
      consume: () => {
        s.consumed += 1;
      },
    }),
  };
};

/** A channel answer record the way `bro pipeline answer` writes it.
 *  `extra` overrides fields — malformed shapes come out that way on
 *  purpose, so the return is a cast, not a lie the type proves. */
const answer = (answers: unknown, extra: Record<string, unknown> = {}): CustomerAnswer =>
  ({
    kind: 'answer',
    item: ITEM,
    answers,
    ts: '2026-11-06T00:00:00Z',
    ...extra,
  }) as CustomerAnswer;

const invoke = async (
  spy: IntakeSpy,
  specs = specStore([row(ITEM, { description: SPEC_BODY })]),
  over: Partial<StageCall> = {},
  feed?: AnswerFeedSpy
) => settled(await intakeStage(deps(spy, specs, feed)).invoke(call(over)));

describe('intake — the spec read', () => {
  test('the seam judges the spec the facade parsed — AC/DoR/scenarios/body', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    await invoke(spy);
    const spec = spy.calls[0].spec;
    assert.equal(spec.id, ITEM);
    assert.deepEqual(spec.acceptance, ['the thing works', 'the thing is tested']);
    assert.equal(spec.dor, 'spec carries AC the worker can verify');
    assert.deepEqual(spec.scenarios, ['happy path']);
    assert.equal(spec.body, 'Implement the thing — context prose.');
  });

  test('a missing item throws — a phantom is never judged', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    await assert.rejects(() => invoke(spy, specStore([])), /not in the task store/);
    assert.equal(spy.calls.length, 0);
  });

  test('a seam throw propagates — the pending intent is the crash marker', async () => {
    const spy: IntakeSpy = {
      calls: [],
      fn: () => {
        throw new Error('worker went away');
      },
    };
    await assert.rejects(() => invoke(spy), /worker went away/);
  });
});

describe('intake — accepted', () => {
  test('payload: verdict + spec fingerprint + the routed worker slot', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await invoke(spy, specs, {
      ctx: { provider: 'pa', model: 'm9', kind: 'devin', orch: 'acp' },
    });
    assert.equal(res.verdict, 'accepted');
    const p = res.payload as IntakePayload;
    assert.equal(p.verdict, 'accepted');
    assert.deepEqual(p.worker, { provider: 'pa', model: 'm9', kind: 'devin', orch: 'acp' });
    assert.match(p.spec.sha, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      { ...p.spec, sha: '<n/a>' },
      { sha: '<n/a>', acceptance: 2, scenarios: 1, dod: false, dor: true, body: true }
    );
    assert.equal(p.questions, undefined);
    assert.equal(p.feedback, undefined);
    assert.equal(specs.annotated.length, 0); // acceptance journals, it never annotates
  });

  test('the fingerprint tracks the spec — an edit is a new sha', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const a = specStore([row(ITEM, { description: SPEC_BODY })]);
    const b = specStore([
      row(ITEM, { description: `${SPEC_BODY}\n- another scenario` }), // inside ## Scenarios
    ]);
    const pa = (await invoke(spy, a)).payload as IntakePayload;
    const pb = (await invoke(spy, b)).payload as IntakePayload;
    assert.notEqual(pa.spec.sha, pb.spec.sha);
    assert.equal(pb.spec.scenarios, 2);
  });

  test('no ctx routing → no worker; the acceptance point still journals', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const p = (await invoke(spy)).payload as IntakePayload;
    assert.equal(p.worker, undefined);
    assert.equal(p.verdict, 'accepted');
  });

  test('non-string ctx fields never reach the worker slot', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const p = (await invoke(spy, specStore([row(ITEM)]), { ctx: { provider: 7, kind: 'devin' } }))
      .payload as IntakePayload;
    assert.deepEqual(p.worker, { kind: 'devin' });
  });

  test('a spec with no AC can still be accepted — journaled with acceptance: 0', async () => {
    // the DoR call is the worker's; intake never silently accepts —
    // the fingerprint records what the accepted spec carried, and
    // verify.unverifiable is the deterministic backstop downstream
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: 'just prose, no sections' })]);
    const p = (await invoke(spy, specs)).payload as IntakePayload;
    assert.equal(p.verdict, 'accepted');
    assert.equal(p.spec.acceptance, 0);
    assert.equal(spy.calls[0].spec.acceptance, undefined); // the seam saw the bare spec
  });
});

describe('intake — questions / declined artifacts', () => {
  test('questions lands the list on the item under ## Questions, bulleted', async () => {
    const spy = intakeSpy({ verdict: 'questions', questions: ['which api?', 'which region?'] });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await invoke(spy, specs);
    assert.equal(res.verdict, 'questions');
    const p = res.payload as IntakePayload;
    assert.deepEqual(p.questions, ['which api?', 'which region?']);
    assert.deepEqual(specs.annotated, [
      { id: ITEM, heading: QUESTIONS_HEADING, lines: ['- which api?', '- which region?'] },
    ]);
    assert.match(specs.bodies.get(ITEM) ?? '', /## Questions\n- which api\?\n- which region\?/);
  });

  test('declined lands the feedback under ## Declined', async () => {
    const spy = intakeSpy({
      verdict: 'declined',
      feedback: 'no verifiable spec — rewrite with AC',
    });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await invoke(spy, specs);
    assert.equal(res.verdict, 'declined');
    const p = res.payload as IntakePayload;
    assert.equal(p.feedback, 'no verifiable spec — rewrite with AC');
    assert.equal(p.questions, undefined);
    assert.deepEqual(specs.annotated, [
      { id: ITEM, heading: DECLINED_HEADING, lines: ['no verifiable spec — rewrite with AC'] },
    ]);
  });

  test('the enriched spec is what a re-intake reads — artifacts land in body', async () => {
    const spy = intakeSpy({ verdict: 'questions', questions: ['which api?'] });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    await invoke(spy, specs);
    const next = specs.spec(ITEM);
    // '## Questions' is not a managed section — it lands in body, so
    // the re-judgment sees its own unanswered questions
    assert.match(next?.body ?? '', /## Questions\n- which api\?/);
    assert.deepEqual(next?.acceptance, ['the thing works', 'the thing is tested']);
  });
});

describe('intake — malformed outcomes fail closed', () => {
  const malformed = (out: unknown) =>
    intakeStage({ taskSpec: specStore([row(ITEM)]), intake: () => out as IntakeOutcome });

  test('a questions verdict with no list throws', async () => {
    await assert.rejects(
      async () => malformed({ verdict: 'questions' }).invoke(call()),
      /"questions" verdict requires a non-empty question list/
    );
    await assert.rejects(
      async () => malformed({ verdict: 'questions', questions: [] }).invoke(call()),
      /"questions" verdict requires a non-empty question list/
    );
  });

  test('a questions verdict with a blank question throws', async () => {
    await assert.rejects(
      async () => malformed({ verdict: 'questions', questions: ['  ', 'real'] }).invoke(call()),
      /"questions" verdict requires a non-empty question list/
    );
  });

  test('a declined verdict with empty feedback throws', async () => {
    await assert.rejects(
      async () => malformed({ verdict: 'declined' }).invoke(call()),
      /"declined" verdict requires non-empty feedback/
    );
    await assert.rejects(
      async () => malformed({ verdict: 'declined', feedback: '   ' }).invoke(call()),
      /"declined" verdict requires non-empty feedback/
    );
  });

  test('an accepted verdict carrying questions or feedback is a contradiction', async () => {
    await assert.rejects(
      async () => malformed({ verdict: 'accepted', questions: ['q'] }).invoke(call()),
      /"accepted" verdict carries no questions/
    );
    await assert.rejects(
      async () => malformed({ verdict: 'accepted', feedback: 'f' }).invoke(call()),
      /"accepted" verdict carries no feedback/
    );
  });

  test('stray fields on the wrong arm throw — nothing annotates', async () => {
    const specs = specStore([row(ITEM)]);
    await assert.rejects(
      async () =>
        intakeStage({
          taskSpec: specs,
          intake: () =>
            ({ verdict: 'questions', questions: ['q'], feedback: 'f' }) as IntakeOutcome,
        }).invoke(call()),
      /"questions" verdict carries no feedback/
    );
    assert.equal(specs.annotated.length, 0); // validation precedes the artifact write
  });

  test('an off-enum verdict or a non-record outcome throws', async () => {
    await assert.rejects(
      async () => malformed({ verdict: 'park' }).invoke(call()),
      /accepted\|questions\|declined/
    );
    await assert.rejects(async () => malformed(null).invoke(call()), /expected a record/);
    await assert.rejects(async () => malformed('accepted').invoke(call()), /expected a record/);
  });

  test('a malformed outcome inside a run never settles — crash marker, bounded re-fire, exhaustion parks', async () => {
    // the throw propagates (the pending intent IS the crash marker);
    // each resume re-fires inside the attempt budget until it parks —
    // the fail-closed destination review's missing notes reaches
    // through its transition check, here through the crash path
    // the journal pins the run id — resume is the same run continuing,
    // never a fresh run re-minting over foreign rows
    const jn = memoryJournal('r1');
    const opts = (journal = jn): RunOptions => ({
      formulaSha: SHA,
      journal,
      admit: () => true,
      engines: {
        intake: intakeStage({
          taskSpec: specStore([row(ITEM)]),
          intake: () => ({ verdict: 'declined', feedback: '' }) as IntakeOutcome,
        }),
        fleet: () => ({ verdict: 'done' }),
      },
    });
    await assert.rejects(
      () => runPipeline(INTAKE_FORMULA, ITEM, opts()),
      /requires non-empty feedback/
    );
    // the crash marker: a verdict-less 'spec' intent — nothing settled
    const pending = journalRecords(jn.rows()).at(-1);
    assert.equal(pending?.intent, 'spec');
    assert.equal(pending?.verdict, undefined);
    // attempts 2 and 3 throw the same way, then the budget is spent
    await assert.rejects(() => resumePipeline(INTAKE_FORMULA, ITEM, jn, opts()), /feedback/);
    await assert.rejects(() => resumePipeline(INTAKE_FORMULA, ITEM, jn, opts()), /feedback/);
    const res = await resumePipeline(INTAKE_FORMULA, ITEM, jn, opts());
    assert.equal(res.outcome, 'park');
    assert.equal(res.alert, PARK_ALERTS.attemptsExhausted);
  });
});

describe('intake — the customer answer feed', () => {
  test('a string answer lands verbatim under ## Answers before the judgment', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([answer('the api is /v2, region eu-central')]);
    await invoke(spy, specs, {}, feed);
    assert.deepEqual(specs.annotated, [
      { id: ITEM, heading: ANSWERS_HEADING, lines: ['the api is /v2, region eu-central'] },
    ]);
    assert.equal(feed.s.consumed, 1);
    assert.match(spy.calls[0].spec.body ?? '', /## Answers/);
  });

  test('a qid→answer map lands one `qid: answer` line per entry', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([answer({ 'which api?': '/v2', 'which region?': 'eu-central' })]);
    await invoke(spy, specs, {}, feed);
    assert.deepEqual(specs.annotated[0]?.lines, ['which api?: /v2', 'which region?: eu-central']);
  });

  test('an array payload lands element-per-line; non-strings JSON-stamp', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([answer(['use the v2 api', { region: 'eu' }, 42])]);
    await invoke(spy, specs, {}, feed);
    assert.deepEqual(specs.annotated[0]?.lines, ['use the v2 api', '{"region":"eu"}', '42']);
  });

  test('a non-answer row on the channel is ignored — still covered by the marker', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([
      { kind: 'verdict', item: ITEM, verdict: 'accepted', accepted_by: 'c', ts: 'x' },
      answer('fine'),
    ]);
    await invoke(spy, specs, {}, feed);
    // only the answer record annotated; the verdict rides the same
    // file untouched (accept's own reader scans the whole channel)
    assert.deepEqual(specs.annotated, [{ id: ITEM, heading: ANSWERS_HEADING, lines: ['fine'] }]);
    assert.equal(feed.s.consumed, 1);
  });

  const BAD_ANSWERS: [string, unknown][] = [
    ['missing item', { kind: 'answer', answers: 'x', ts: 't' }],
    ['a foreign item', answer('x', { item: 'bro-other' })],
    ['empty answers', answer('   ')],
    ['missing answers', { kind: 'answer', item: ITEM, ts: 't' }],
    ['a null payload', answer(null)],
    ['an empty map', answer({})],
    ['a non-string ts', answer('x', { ts: 5 })],
    ['a non-string by', answer('x', { by: 7 })],
  ];
  for (const [what, rec] of BAD_ANSWERS) {
    test(`malformed answer — ${what} → answer-malformed, consumed, nothing annotated`, async () => {
      const spy = intakeSpy({ verdict: 'accepted' });
      const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
      const feed = feedSpy([rec]);
      const res = await intakeStage(deps(spy, specs, feed)).invoke(call());
      assert.equal((res as { alert?: string }).alert, PARK_ALERTS.answerMalformed);
      assert.match(
        (res as { detail?: string }).detail ?? '',
        /^1 malformed answer record\(s\): .+/
      );
      assert.equal(specs.annotated.length, 0);
      assert.equal(feed.s.consumed, 1); // drained anyway — it must not re-alert every wake
      assert.equal(spy.calls.length, 0); // the judgment never ran
    });
  }

  test('a poisoned artifact line is malformed input — good answers still land', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    // the spy's annotate skips the facade's structure guard — stand
    // it back up for this case so the throw path is exercised
    const orig = specs.annotate;
    specs.annotate = (id, heading, lines) => {
      if (lines.some(l => l.startsWith('#'))) {
        throw new Error(
          'taskSpec annotate: artifact line "## x" opens structure — ' +
            'artifact text never becomes a section or a fence'
        );
      }
      orig(id, heading, lines);
    };
    const feed = feedSpy([answer('## Acceptance\n- injected'), answer('clean answer')]);
    const res = await intakeStage(deps(spy, specs, feed)).invoke(call());
    assert.equal((res as { alert?: string }).alert, PARK_ALERTS.answerMalformed);
    assert.match((res as { detail?: string }).detail ?? '', /opens markdown structure/);
    // the clean answer still landed; only the poisoned one was refused
    assert.deepEqual(specs.annotated, [
      { id: ITEM, heading: ANSWERS_HEADING, lines: ['clean answer'] },
    ]);
    assert.equal(feed.s.consumed, 1);
    assert.equal(spy.calls.length, 0);
  });

  test('a mixed batch — good rows land, bad rows alert, all consumed', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([answer('valid one'), answer(null)]);
    const res = await intakeStage(deps(spy, specs, feed)).invoke(call());
    assert.equal((res as { alert?: string }).alert, PARK_ALERTS.answerMalformed);
    assert.deepEqual(specs.annotated, [
      { id: ITEM, heading: ANSWERS_HEADING, lines: ['valid one'] },
    ]);
    assert.equal(feed.s.consumed, 1);
  });

  test('the feed reads the REAL channel — consumed marker gives exactly-once across wakes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-intake-'));
    testRepoInit(dir);
    const file = customerChannelPath({ dir, runId: 'r1' });
    assert.ok(file !== null);
    const spy = intakeSpy([
      { verdict: 'questions', questions: ['who decides?'] },
      { verdict: 'questions', questions: ['still asking?'] },
      { verdict: 'accepted' },
    ]);
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const jn = memoryJournal('r1');
    const engines = (): RunOptions['engines'] => ({
      intake: intakeStage({
        taskSpec: specs,
        intake: spy.fn,
        answers: fileAnswerFeed(dir),
      }),
      fleet: () => ({ verdict: 'done' }),
    });
    const opts = (): RunOptions => ({
      formulaSha: SHA,
      journal: jn,
      admit: () => true,
      engines: engines(),
    });
    const parked = await runPipeline(INTAKE_FORMULA, ITEM, opts());
    assert.equal(parked.outcome, 'park');
    assert.equal(parked.verdict, 'questions');
    // `bro pipeline answer` writes while the run is parked — the
    // channel record sits pending until a wake's intake pass drains it
    appendCustomerRecord(file, answer('the customer decides'));
    // wake 1: the channel record lands on the item + marker stamped —
    // the re-judgment still has questions, so the run parks again
    const w1 = await resumePipeline(INTAKE_FORMULA, ITEM, jn, opts());
    assert.equal(w1.outcome, 'park');
    assert.equal(w1.verdict, 'questions');
    assert.equal(specs.annotated.filter(a => a.heading === ANSWERS_HEADING).length, 1);
    // wake 2: the marker means the SAME record is never re-fed — no
    // second ## Answers append, the enriched spec is simply judged
    const w2 = await resumePipeline(INTAKE_FORMULA, ITEM, jn, opts());
    assert.equal(w2.outcome, 'end');
    assert.equal(specs.annotated.filter(a => a.heading === ANSWERS_HEADING).length, 1);
    const enriched = spy.calls.at(-1)?.spec;
    assert.match(enriched?.body ?? '', /## Answers\nthe customer decides/);
  });

  test('a malformed channel record parks answer-malformed — a corrected append repairs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-intake-'));
    testRepoInit(dir);
    const file = customerChannelPath({ dir, runId: 'r1' });
    assert.ok(file !== null);
    const spy = intakeSpy([
      { verdict: 'questions', questions: ['who decides?'] },
      { verdict: 'accepted' },
      { verdict: 'accepted' },
    ]);
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const jn = memoryJournal('r1');
    const opts = (): RunOptions => ({
      formulaSha: SHA,
      journal: jn,
      admit: () => true,
      engines: {
        intake: intakeStage({
          taskSpec: specs,
          intake: spy.fn,
          answers: fileAnswerFeed(dir),
        }),
        fleet: () => ({ verdict: 'done' }),
      },
    });
    const parked = await runPipeline(INTAKE_FORMULA, ITEM, opts());
    assert.equal(parked.outcome, 'park');
    // a hand-edited row that lost its answers payload — fail closed,
    // never crash the resume (cast: the row is malformed on purpose)
    appendCustomerRecord(file, {
      kind: 'answer',
      item: ITEM,
      ts: 't',
    } as CustomerAnswer);
    const alerted = await resumePipeline(INTAKE_FORMULA, ITEM, jn, opts());
    assert.equal(alerted.outcome, 'park');
    assert.equal(alerted.alert, PARK_ALERTS.answerMalformed);
    const alertRow = journalRecords(jn.rows()).at(-1);
    assert.equal(alertRow?.alert, PARK_ALERTS.answerMalformed);
    assert.equal(alertRow?.resume, 'intake');
    // the bad row was consumed — a corrected append is the repair;
    // the wake drains only the new record and judges the enriched spec
    appendCustomerRecord(file, answer('now it is answered'));
    const repaired = await resumePipeline(INTAKE_FORMULA, ITEM, jn, opts());
    assert.equal(repaired.outcome, 'end');
    assert.deepEqual(
      specs.annotated.filter(a => a.heading === ANSWERS_HEADING),
      [{ id: ITEM, heading: ANSWERS_HEADING, lines: ['now it is answered'] }]
    );
  });
});

describe('intake inside runPipeline — the DAG', () => {
  const runDag = (spy: IntakeSpy, specs: SpecStoreSpy, opts: Partial<RunOptions> = {}) =>
    runPipeline(INTAKE_FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      ...opts,
      engines: {
        intake: intakeStage(deps(spy, specs)),
        fleet: () => ({ verdict: 'done' }),
      },
    });

  test('accepted → work runs → end; the spec sha is journaled', async () => {
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const jn = memoryJournal();
    const res = await runDag(spy, specs, { journal: jn });
    assert.equal(res.outcome, 'end');
    const p = res.ctx.intake as IntakePayload;
    assert.equal(p.verdict, 'accepted');
    assert.match(p.spec.sha, /^[0-9a-f]{64}$/);
    assert.equal(specs.annotated.length, 0);
    // the acceptance point IS the journaled record — run, item, stage,
    // verdict, and which spec revision it committed to
    const rec = journalRecords(jn.rows()).find(r => r.stage === 'intake');
    assert.ok(rec !== undefined);
    assert.equal(rec.verdict, 'accepted');
    assert.equal((rec.payload as IntakePayload).spec.sha, p.spec.sha);
  });

  test('questions → park at intake; the artifact is on the item', async () => {
    const spy = intakeSpy({ verdict: 'questions', questions: ['who signs?'] });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await runDag(spy, specs);
    assert.equal(res.outcome, 'park');
    assert.equal(res.stage, 'intake');
    assert.equal(res.verdict, 'questions');
    assert.equal(specs.annotated.length, 1);
    assert.match(specs.bodies.get(ITEM) ?? '', /## Questions/);
  });

  test('declined → close — the item returns to the customer, never abandoned', async () => {
    const spy = intakeSpy({ verdict: 'declined', feedback: 'spec is a vibe, not a spec' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await runDag(spy, specs);
    assert.equal(res.outcome, 'close');
    assert.equal(res.verdict, 'declined');
    assert.match(specs.bodies.get(ITEM) ?? '', /## Declined\nspec is a vibe, not a spec/);
  });

  test('questions → park → answers land → wake re-runs intake on the enriched spec → accepted → end', async () => {
    // the spec's wake contract: a parked questions run resumes INTO
    // intake, and the judgment reads the spec the answers enriched —
    // the feed IS the consumer: `bro pipeline answer`'s channel
    // records land on the item before the seam re-judges
    const spy = intakeSpy([
      { verdict: 'questions', questions: ['who signs?'] },
      { verdict: 'accepted' },
    ]);
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const feed = feedSpy([answer({ 'who signs?': 'the customer does' })]);
    const jn = memoryJournal('r1'); // pinned run id — resume is the same run
    const parked = await runDag(spy, specs, { journal: jn });
    assert.equal(parked.outcome, 'park');
    assert.equal(spy.calls.length, 1);
    assert.equal(feed.s.consumed, 0); // the park pass drained nothing — answers landed after

    const resumed = await resumePipeline(INTAKE_FORMULA, ITEM, jn, {
      formulaSha: SHA,
      admit: () => true,
      engines: {
        intake: intakeStage(deps(spy, specs, feed)),
        fleet: () => ({ verdict: 'done' }),
      },
    });
    assert.equal(resumed.outcome, 'end');
    assert.equal(spy.calls.length, 2);
    assert.equal(feed.s.consumed, 1); // drained + stamped exactly once
    const enriched = spy.calls[1].spec;
    assert.match(enriched.body ?? '', /## Questions\n- who signs\?/);
    assert.match(enriched.body ?? '', /## Answers\nwho signs\?: the customer does/);
    assert.deepEqual(
      specs.annotated.filter(a => a.heading === ANSWERS_HEADING),
      [{ id: ITEM, heading: ANSWERS_HEADING, lines: ['who signs?: the customer does'] }]
    );
    const p = resumed.ctx.intake as IntakePayload;
    assert.equal(p.verdict, 'accepted');
    // the accepted point journals the ENRICHED spec's sha — the
    // artifact the customer wrote changed the revision
    const first = spy.calls[0].spec;
    const resha = p.spec.sha;
    assert.notEqual(resha, undefined);
    assert.notEqual(resha, (parked.ctx.intake as IntakePayload).spec.sha);
    assert.equal(first.acceptance?.length, 2);
  });

  test('the spec formula wires intake between route and work — accepted flows to work', async () => {
    // full-DAG parity: route's routed slot becomes the worker stamp
    const spy = intakeSpy({ verdict: 'accepted' });
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const res = await runPipeline(FORMULA, ITEM, {
      formulaSha: SHA,
      journal: memoryJournal(),
      admit: () => true,
      engines: {
        judge: {
          invoke: call => {
            if (call.stage.name === 'classify') {
              return { verdict: 'solo', payload: { group: 'solo', complexity: 'cheap', rank: 3 } };
            }
            return {
              verdict: 'spawn',
              payload: {
                class: 'default',
                kind: 'devin',
                orch: 'exec',
                timing: 'now',
                provider: 'pa',
                model: 'm9',
              },
            };
          },
        },
        intake: intakeStage(deps(spy, specs)),
        fleet: () => ({ verdict: 'done' }),
        e2e: () => ({ verdict: 'verified' }),
        accept: () => ({ verdict: 'accepted' }),
        'act-gate': () => ({ verdict: 'landed' }),
        learn: () => ({ verdict: 'captured' }),
      },
    });
    assert.equal(res.outcome, 'end');
    const p = res.ctx.intake as IntakePayload;
    assert.equal(p.verdict, 'accepted');
    // who took the task: the routed slot, read off the flat ctx merge
    assert.deepEqual(p.worker, { provider: 'pa', model: 'm9', kind: 'devin', orch: 'exec' });
    assert.equal(spy.calls.length, 1);
    // the worker judged the facade's projection, not a TaskRow
    assert.deepEqual(spy.calls[0].spec.acceptance, ['the thing works', 'the thing is tested']);
  });
});
