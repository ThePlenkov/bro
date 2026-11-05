/** `bro pipeline accept|answer` tests — the customer-channel write
 *  surface: verdict/answer records land on the resolved run's
 *  `<run>.customer.jsonl`, the identity/run gates refuse ambiguous or
 *  signer-less input, and `rejected` demands `--notes` at the CLI
 *  boundary already (the gate would park it the same way). */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { customerChannelPath, openPipelineJournal, readCustomerFile } from '@broject/pipeline';
import { runPipelineCommand } from './pipeline.ts';
import { initRepo, inside } from './testrepo.ts';

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Intercept process.exit + capture console output — the command
 *  exits(2) on usage errors and exits(1) on operational refusals. */
function exits(fn: () => unknown): { code: number; err: string[]; out: string[] } {
  const origExit = process.exit;
  const origErr = console.error;
  const origOut = console.log;
  const err: string[] = [];
  const out: string[] = [];
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0);
  }) as typeof process.exit;
  try {
    fn();
    return { code: -1, err, out };
  } catch (e) {
    return { code: e instanceof Exit ? e.code : -1, err, out };
  } finally {
    process.exit = origExit;
    console.error = origErr;
    console.log = origOut;
  }
}

const ITEM = 'bro-p1';
const SHA = 'cafebabe';
const TS = '2026-11-06T00:00:00Z';

const SESSION_VARS = ['BRO_AGENT_ID', 'BRO_SESSION_ID'];

/** Session env must not leak the dev's own badges into the signer
 *  chain — same isolation the other command tests apply. */
function cleanSessionEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of SESSION_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Seed a run suspended at accept — the pending emit intent is the
 *  journal tail, exactly what the runner leaves on an invoke→pending
 *  park. */
function parkAtAccept(dir: string, runId: string, item = ITEM): void {
  const j = openPipelineJournal({ dir, runId });
  if (j === null) throw new Error('no journal');
  j.append({
    run_id: runId,
    item,
    seq: 1,
    stage: 'accept',
    intent: 'emit',
    attempt: 1,
    formula_sha: SHA,
    ts: TS,
  });
}

const channel = (dir: string, runId: string): unknown[] => {
  const file = customerChannelPath({ dir, runId });
  if (file === null) throw new Error('no channel path');
  return readCustomerFile(file);
};

describe('bro pipeline accept', () => {
  test('records the verdict on the sole run parked at accept', () => {
    const { root, main } = initRepo('bro-pipeline-acc-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtAccept(main, 'run-1');
        const r = exits(() => runPipelineCommand(['accept', ITEM, 'accepted', '--by', 'cust-1']));
        assert.equal(r.code, -1); // completed, no exit
        const rows = channel(main, 'run-1');
        assert.equal(rows.length, 1);
        const rec = rows[0] as Record<string, unknown>;
        assert.equal(rec.kind, 'verdict');
        assert.equal(rec.verdict, 'accepted');
        assert.equal(rec.accepted_by, 'cust-1');
        assert.equal(rec.item, ITEM);
        assert.equal(typeof rec.ts, 'string');
        assert.match(r.out[0] ?? '', /recorded accepted for bro-p1 on run run-1/);
      })
    );
  });

  test('rejected without --notes is refused at the boundary — nothing lands', () => {
    const { root, main } = initRepo('bro-pipeline-rej-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtAccept(main, 'run-1');
        const r = exits(() => runPipelineCommand(['accept', ITEM, 'rejected', '--by', 'c']));
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /--notes is required on rejected/);
        assert.equal(channel(main, 'run-1').length, 0);
      })
    );
  });

  test('rejected with --notes lands the fix scope', () => {
    const { root, main } = initRepo('bro-pipeline-rejn-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtAccept(main, 'run-1');
        exits(() =>
          runPipelineCommand(['accept', ITEM, 'rejected', '--notes', 'ac-2 fails', '--by', 'c'])
        );
        const rec = channel(main, 'run-1')[0] as Record<string, unknown>;
        assert.equal(rec.verdict, 'rejected');
        assert.equal(rec.notes, 'ac-2 fails');
      })
    );
  });

  test('no awaiting run → refusal, and --run pins an explicit target', () => {
    const { root, main } = initRepo('bro-pipeline-none-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        const r = exits(() => runPipelineCommand(['accept', ITEM, 'accepted', '--by', 'c']));
        assert.equal(r.code, 1);
        assert.match(r.err.join('\n'), /no run parked at accept/);
        // --run bypasses resolution — the channel is per-run anyway
        const r2 = exits(() =>
          runPipelineCommand(['accept', ITEM, 'abandon', '--by', 'c', '--run', 'run-9'])
        );
        assert.equal(r2.code, -1);
        assert.equal((channel(main, 'run-9')[0] as Record<string, unknown>).verdict, 'abandon');
      })
    );
  });

  test('an invalid verdict word is a usage error', () => {
    const { root, main } = initRepo('bro-pipeline-badv-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtAccept(main, 'run-1');
        const r = exits(() => runPipelineCommand(['accept', ITEM, 'lgtm', '--by', 'c']));
        assert.equal(r.code, 2);
      })
    );
  });

  test('two awaiting runs is ambiguous — reports the candidates', () => {
    const { root, main } = initRepo('bro-pipeline-amb-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtAccept(main, 'run-1');
        parkAtAccept(main, 'run-2');
        const r = exits(() => runPipelineCommand(['accept', ITEM, 'accepted', '--by', 'c']));
        assert.equal(r.code, 1);
        assert.match(r.err.join('\n'), /--run.*run-1.*run-2|run-1.*run-2/s);
      })
    );
  });

  test('the signer chain: BRO_AGENT_ID badge wins when --by is absent', () => {
    const { root, main } = initRepo('bro-pipeline-badge-');
    inside(main, root, () => {
      parkAtAccept(main, 'run-1');
      const saved = process.env.BRO_AGENT_ID;
      process.env.BRO_AGENT_ID = 'agent-cust';
      try {
        exits(() => runPipelineCommand(['accept', ITEM, 'accepted']));
        assert.equal(
          (channel(main, 'run-1')[0] as Record<string, unknown>).accepted_by,
          'agent-cust'
        );
      } finally {
        if (saved === undefined) delete process.env.BRO_AGENT_ID;
        else process.env.BRO_AGENT_ID = saved;
      }
    });
  });
});

describe('bro pipeline answer', () => {
  /** A run parked on intake's `questions` verdict — the wait state
   *  `answer` resolves against. */
  const parkAtQuestions = (dir: string, runId: string): void => {
    const j = openPipelineJournal({ dir, runId });
    if (j === null) throw new Error('no journal');
    j.append({
      run_id: runId,
      item: ITEM,
      seq: 1,
      stage: 'intake',
      intent: 'spec',
      attempt: 1,
      verdict: 'questions',
      formula_sha: SHA,
      ts: TS,
    });
  };

  test('-m records the answer record on the intake-parked run', () => {
    const { root, main } = initRepo('bro-pipeline-anm-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtQuestions(main, 'run-2');
        const r = exits(() => runPipelineCommand(['answer', ITEM, '-m', 'q1: use sqlite']));
        assert.equal(r.code, -1);
        const rec = channel(main, 'run-2')[0] as Record<string, unknown>;
        assert.equal(rec.kind, 'answer');
        assert.equal(rec.answers, 'q1: use sqlite');
        assert.equal(rec.item, ITEM);
      })
    );
  });

  test('--answers-file parses JSON when it parses, raw text otherwise', () => {
    const { root, main } = initRepo('bro-pipeline-anf-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        parkAtQuestions(main, 'run-2');
        writeFileSync(join(main, 'answers.json'), JSON.stringify({ q1: 'a', q2: 'b' }));
        exits(() => runPipelineCommand(['answer', ITEM, '--answers-file', 'answers.json']));
        assert.deepEqual((channel(main, 'run-2')[0] as Record<string, unknown>).answers, {
          q1: 'a',
          q2: 'b',
        });
        writeFileSync(join(main, 'answers.txt'), 'free-form reply');
        exits(() => runPipelineCommand(['answer', ITEM, '--answers-file', 'answers.txt']));
        assert.equal(
          (channel(main, 'run-2')[1] as Record<string, unknown>).answers,
          'free-form reply'
        );
      })
    );
  });

  test('no answer source and unknown verbs are usage errors', () => {
    const { root, main } = initRepo('bro-pipeline-usage-');
    inside(main, root, () =>
      cleanSessionEnv(() => {
        const r = exits(() => runPipelineCommand(['answer', ITEM]));
        assert.equal(r.code, 2);
        const r2 = exits(() => runPipelineCommand(['bogus']));
        assert.equal(r2.code, 2);
      })
    );
  });
});
