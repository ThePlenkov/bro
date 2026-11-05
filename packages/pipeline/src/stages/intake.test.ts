import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskSpec } from '@broject/core';
import { parse } from 'smol-toml';
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
import { row, type SpecStoreSpy, specStore } from '../testkit.ts';
import {
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

const deps = (spy: IntakeSpy, specs: SpecStoreSpy): IntakeDeps => ({
  taskSpec: specs,
  intake: spy.fn,
});

const invoke = async (
  spy: IntakeSpy,
  specs = specStore([row(ITEM, { description: SPEC_BODY })]),
  over: Partial<StageCall> = {}
) => intakeStage(deps(spy, specs)).invoke(call(over));

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
    // intake, and the judgment reads the spec the answers enriched
    const spy = intakeSpy([
      { verdict: 'questions', questions: ['who signs?'] },
      { verdict: 'accepted' },
    ]);
    const specs = specStore([row(ITEM, { description: SPEC_BODY })]);
    const jn = memoryJournal('r1'); // pinned run id — resume is the same run
    const parked = await runDag(spy, specs, { journal: jn });
    assert.equal(parked.outcome, 'park');
    assert.equal(spy.calls.length, 1);

    // the customer's answers land on the item (bro pipeline answer's
    // write path — same annotate seam)
    specs.annotate(ITEM, 'Answers', ['- the customer does']);
    const resumed = await resumePipeline(INTAKE_FORMULA, ITEM, jn, {
      formulaSha: SHA,
      admit: () => true,
      engines: {
        intake: intakeStage(deps(spy, specs)),
        fleet: () => ({ verdict: 'done' }),
      },
    });
    assert.equal(resumed.outcome, 'end');
    assert.equal(spy.calls.length, 2);
    const enriched = spy.calls[1].spec;
    assert.match(enriched.body ?? '', /## Questions\n- who signs\?/);
    assert.match(enriched.body ?? '', /## Answers\n- the customer does/);
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
