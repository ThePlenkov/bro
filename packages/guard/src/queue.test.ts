/** The queued verdict plane (spec: specs/bro-36sx7.4.md) — the hook
 *  facade consumes landed verdicts or files requests and abstains;
 *  the drain publishes verdicts back. Real git repos in tmp. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './testtmp.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gitTry, type DecideResult, type JudgeFacade } from '@broject/core';
import { drainJudgeRequests, judgeQueueDir, queuedJudge } from './queue.ts';

function repo(): string {
  const dir = tmpDir('bro-guard-queue-');
  assert.equal(gitTry(['-C', dir, 'init', '-q']).code, 0);
  return dir;
}

const root = (dir: string): string => judgeQueueDir(dir)!;
const reqFile = (dir: string, guard: string): string => join(root(dir), `${guard}.req.json`);
const verdictFile = (dir: string, guard: string): string =>
  join(root(dir), `${guard}.verdict.json`);

const QUESTIONS = {
  fire: {
    type: 'noul',
    instructions: 'fire?',
    criteria: { true: 'yes', false: 'no' },
  },
} as const;

const fireResult = (noul: number): DecideResult => ({
  answers: {
    fire: { type: 'noul', noul, confidence: 0.9, decidedBy: 'test' },
  },
  model: 'test-judge',
  latencyMs: 3,
  lowConfidence: [],
});

/** A facade that counts calls and answers what it's told. */
function scriptedFacade(fn: () => DecideResult = () => fireResult(0.95)): {
  facade: JudgeFacade;
  calls: () => number;
} {
  let n = 0;
  return {
    facade: {
      decide: async () => {
        n += 1;
        return fn();
      },
    },
    calls: () => n,
  };
}

describe('queuedJudge — the hook path (bro-36sx7.4)', () => {
  test('no verdict → files the request, stamps the spawn, abstains', async () => {
    const dir = repo();
    const res = await queuedJudge(dir).decide({ guard: 'g1', event: 'stop' }, QUESTIONS);
    assert.deepEqual(res.answers, {});
    const req = JSON.parse(readFileSync(reqFile(dir, 'g1'), 'utf8'));
    assert.equal(req.state.guard, 'g1');
    assert.ok(existsSync(join(root(dir), '.spawn')));
  });

  test('a landed verdict is claimed exactly once', async () => {
    const dir = repo();
    mkdirSync(root(dir), { recursive: true });
    writeFileSync(verdictFile(dir, 'g1'), JSON.stringify(fireResult(0.95)));
    const facade = queuedJudge(dir);
    const res = await facade.decide({ guard: 'g1', event: 'stop' }, QUESTIONS);
    assert.equal(res.model, 'test-judge');
    assert.equal(res.answers.fire?.type, 'noul');
    // consumed — the next decide falls back to queueing a request
    assert.equal(existsSync(verdictFile(dir, 'g1')), false);
    const again = await facade.decide({ guard: 'g1', event: 'stop' }, QUESTIONS);
    assert.deepEqual(again.answers, {});
    assert.ok(existsSync(reqFile(dir, 'g1')));
  });

  test('a corrupt verdict abstains and re-queues', async () => {
    const dir = repo();
    mkdirSync(root(dir), { recursive: true });
    writeFileSync(verdictFile(dir, 'g1'), '{torn');
    const res = await queuedJudge(dir).decide({ guard: 'g1', event: 'stop' }, QUESTIONS);
    assert.deepEqual(res.answers, {});
    assert.ok(existsSync(reqFile(dir, 'g1')));
  });

  test('a state without a guard name abstains outright', async () => {
    const dir = repo();
    const res = await queuedJudge(dir).decide({ event: 'stop' }, QUESTIONS);
    assert.deepEqual(res.answers, {});
    assert.equal(existsSync(reqFile(dir, 'g1')), false);
  });
});

describe('drainJudgeRequests — the `bro guard eval` worker', () => {
  test('a pending req becomes a verdict file; the req is consumed', async () => {
    const dir = repo();
    mkdirSync(root(dir), { recursive: true });
    writeFileSync(
      reqFile(dir, 'g1'),
      JSON.stringify({ state: { guard: 'g1', event: 'stop' }, questions: QUESTIONS })
    );
    const { facade, calls } = scriptedFacade(() => fireResult(0.1));
    assert.equal(await drainJudgeRequests(dir, facade), 1);
    assert.equal(calls(), 1);
    assert.equal(existsSync(reqFile(dir, 'g1')), false);
    const v = JSON.parse(readFileSync(verdictFile(dir, 'g1'), 'utf8')) as DecideResult;
    assert.equal(v.model, 'test-judge');
    assert.equal(v.answers.fire?.type, 'noul');
  });

  test('a throwing facade restores the req — its age is the backoff', async () => {
    const dir = repo();
    mkdirSync(root(dir), { recursive: true });
    writeFileSync(
      reqFile(dir, 'g1'),
      JSON.stringify({ state: { guard: 'g1' }, questions: QUESTIONS })
    );
    const { facade } = scriptedFacade(() => {
      throw new Error('judge down');
    });
    assert.equal(await drainJudgeRequests(dir, facade), 0);
    assert.ok(existsSync(reqFile(dir, 'g1')));
    assert.equal(existsSync(verdictFile(dir, 'g1')), false);
  });

  test('a corrupt or incomplete req is dropped', async () => {
    const dir = repo();
    mkdirSync(root(dir), { recursive: true });
    writeFileSync(reqFile(dir, 'torn'), '{not json');
    writeFileSync(reqFile(dir, 'nostate'), JSON.stringify({ questions: QUESTIONS }));
    assert.equal(await drainJudgeRequests(dir, scriptedFacade().facade), 0);
    assert.equal(existsSync(reqFile(dir, 'torn')), false);
    assert.equal(existsSync(reqFile(dir, 'nostate')), false);
  });

  test('an empty queue drains quietly', async () => {
    const dir = repo();
    assert.equal(await drainJudgeRequests(dir, scriptedFacade().facade), 0);
  });
});
