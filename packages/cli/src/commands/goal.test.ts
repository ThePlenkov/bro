/** `bro goal` + hook-side evaluation (spec: specs/goal/bro-6vcll.md). */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { tmpDir } from './testrepo.ts';
import {
  goalContextLines,
  goalStatusLine,
  goalStopLines,
  readGoal,
  sessionGoal,
  runGoalCommand,
  type GoalRecord,
} from './goal.ts';
import { registerConnector, scrubEnv, testGit, type JudgeFacade } from '@broject/core';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file
after(scrubEnv());

/** A bare `git init` worktree — goal state lands in its .git dir. */
function repo(): string {
  const dir = tmpDir('bro-goal-');
  testGit(['init', '-q'], { cwd: dir });
  return dir;
}

function goalFile(dir: string, session: string): string {
  return join(dir, '.git', 'bro', 'hooks', 'goal', `${session}.json`);
}

const reqFile = (dir: string, session: string): string =>
  join(dir, '.git', 'bro', 'hooks', 'goal', `${session}.req.json`);

const noticeFile = (dir: string, session: string): string =>
  join(dir, '.git', 'bro', 'hooks', 'goal', `${session}.notice`);

function writeRaw(dir: string, session: string, rec: unknown): void {
  mkdirSync(join(dir, '.git', 'bro', 'hooks', 'goal'), { recursive: true });
  writeFileSync(goalFile(dir, session), JSON.stringify(rec));
}

function writeReq(dir: string, session: string, body: unknown): void {
  mkdirSync(join(dir, '.git', 'bro', 'hooks', 'goal'), { recursive: true });
  writeFileSync(reqFile(dir, session), JSON.stringify(body));
}

/** The scripted judge — opt-in, reachable only through the
 *  connectors.judge pin a test writes into bro.config.json. `scripted`
 *  carries the verdict the next decide() answers. */
const FAKE_JUDGE = 'goal-test-judge';
let scripted: 'met' | 'not_met' | 'impossible' | 'throw' = 'not_met';
/** Side effect run inside decide() — lets a test land a write mid-eval. */
let decideEffect: (() => void) | undefined;
registerConnector({
  name: FAKE_JUDGE,
  optIn: true,
  judge: () =>
    ({
      decide: async () => {
        decideEffect?.();
        if (scripted === 'throw') {
          throw new Error('judge down');
        }
        return {
          answers: {
            verdict: {
              type: 'choice',
              choice: scripted,
              probabilities: { [scripted]: 0.9 },
              confidence: 0.9,
              decidedBy: FAKE_JUDGE,
            },
          },
          model: FAKE_JUDGE,
          latencyMs: 1,
          lowConfidence: [],
        };
      },
    }) as unknown as JudgeFacade,
});

/** judge.mode shadow + the scripted judge — the eval path's config. */
function judgeCfg(dir: string): void {
  writeFileSync(
    join(dir, 'bro.config.json'),
    JSON.stringify({ judge: { mode: 'shadow' }, connectors: { judge: FAKE_JUDGE } })
  );
}

const ACTIVE: GoalRecord = {
  condition: 'tests pass',
  status: 'active',
  createdAt: Date.now(),
  evals: 0,
  maxTurns: 5,
};

describe('readGoal/sessionGoal', () => {
  test('round-trip: written record reads back', () => {
    const dir = repo();
    writeRaw(dir, 's1', ACTIVE);
    const g = readGoal(dir, 's1');
    assert.equal(g?.condition, 'tests pass');
    assert.equal(g?.status, 'active');
    assert.equal(g?.maxTurns, 5);
  });

  test('no record → null; garbage record → null', () => {
    const dir = repo();
    assert.equal(readGoal(dir, 's1'), null);
    mkdirSync(join(dir, '.git', 'bro', 'hooks', 'goal'), { recursive: true });
    writeFileSync(goalFile(dir, 's1'), '{"condition":""}');
    assert.equal(readGoal(dir, 's1'), null);
  });

  test('seed materializes into the first session that evaluates it', () => {
    const dir = repo();
    writeRaw(dir, '_default', { ...ACTIVE, condition: 'empty bd ready' });
    const g = sessionGoal(dir, 'sess-A');
    assert.equal(g?.condition, 'empty bd ready');
    // materialized as the session's own copy — the seed is consumed
    assert.ok(existsSync(goalFile(dir, 'sess-A')));
    assert.equal(existsSync(goalFile(dir, '_default')), false);
    // a second session does NOT inherit it
    assert.equal(sessionGoal(dir, 'sess-B'), null);
  });

  test('session record wins over the seed', () => {
    const dir = repo();
    writeRaw(dir, 's1', { ...ACTIVE, condition: 'mine' });
    writeRaw(dir, '_default', { ...ACTIVE, condition: 'seed' });
    assert.equal(sessionGoal(dir, 's1')?.condition, 'mine');
  });
});

describe('goalStopLines', () => {
  test('no goal → no lines', async () => {
    const dir = repo();
    assert.deepEqual(await goalStopLines(dir, 's1', { trace: 'trace' }), []);
  });

  test('active goal without judge → plain reminder', async () => {
    const dir = repo();
    writeRaw(dir, 's1', ACTIVE);
    const lines = await goalStopLines(dir, 's1', { trace: 'trace' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /goal: "tests pass"/);
    assert.match(lines[0]!, /bro goal clear/);
  });

  test('paused goal → silence (a per-stop reminder re-wakes the host in a loop); resolved goal → silence', async () => {
    const dir = repo();
    writeRaw(dir, 's1', { ...ACTIVE, status: 'paused' });
    assert.deepEqual(await goalStopLines(dir, 's1', { trace: 't' }), []);
    writeRaw(dir, 's1', { ...ACTIVE, status: 'achieved' });
    assert.deepEqual(await goalStopLines(dir, 's1', { trace: 't' }), []);
  });

  test('no session id → reminder only, never a judge call or a write', async () => {
    const dir = repo();
    writeRaw(dir, '_default', ACTIVE);
    const lines = await goalStopLines(dir, '', { trace: 'trace' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /goal: "tests pass"/);
  });

  test('a pause landing mid-eval stays silent — the fail-open reminder re-reads first', async () => {
    const dir = repo();
    // judge.mode: shadow enters the judged path; decide() throws without
    // a provider, so the eval lands in the fail-open recheck
    writeFileSync(join(dir, 'bro.config.json'), JSON.stringify({ judge: { mode: 'shadow' } }));
    writeRaw(dir, 's1', ACTIVE);
    const pause = Promise.resolve().then(() => {
      writeRaw(dir, 's1', { ...ACTIVE, status: 'paused' });
      return 'ctx';
    });
    assert.deepEqual(await goalStopLines(dir, 's1', { trace: 't', context: pause }), []);
  });
});

describe('goal eval — the queued judge path (bro-36sx7.4)', () => {
  /** `bro goal eval --session s1` inside the fixture repo — the verb
   *  binds process.cwd() like the real CLI does. */
  const evalGoal = async (dir: string): Promise<void> => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      await runGoalCommand(['eval', '--session', 's1']);
    } finally {
      process.chdir(prev);
    }
  };

  test('judged mode queues a req and never decides inline', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    const lines = await goalStopLines(dir, 's1', { trace: 'first' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /goal: "tests pass"/);
    const body = JSON.parse(readFileSync(reqFile(dir, 's1'), 'utf8'));
    assert.equal(body.trace, 'first');
    assert.equal(body.condition, 'tests pass');
    assert.equal(body.evals, 0);
    // no verdict ran — the record is untouched
    assert.equal(readGoal(dir, 's1')?.evals, 0);
  });

  test('a fresh req marks the eval pending — the hook does not rewrite it', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    await goalStopLines(dir, 's1', { trace: 'first' });
    await goalStopLines(dir, 's1', { trace: 'second' });
    assert.equal(JSON.parse(readFileSync(reqFile(dir, 's1'), 'utf8')).trace, 'first');
  });

  test('a fresh work claim marks the eval pending — no duplicate spawn mid-decide', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    // an eval holding the claim rides as <req>.work-<pid> — the req
    // file is absent for the whole decide span
    writeFileSync(`${reqFile(dir, 's1')}.work-99999`, '{}');
    await goalStopLines(dir, 's1', { trace: 'second' });
    assert.equal(existsSync(reqFile(dir, 's1')), false);
  });

  test('a stale work claim is a wedged worker — the stop re-queues', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    const work = `${reqFile(dir, 's1')}.work-99999`;
    writeFileSync(work, '{}');
    const stale = new Date(Date.now() - 200_000);
    utimesSync(work, stale, stale);
    await goalStopLines(dir, 's1', { trace: 'second' });
    assert.ok(existsSync(reqFile(dir, 's1')));
  });

  test('bro goal eval: met transitions + announces once', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'met';
    await goalStopLines(dir, 's1', { trace: 't' });
    await evalGoal(dir);
    assert.equal(readGoal(dir, 's1')?.status, 'achieved');
    assert.equal(existsSync(reqFile(dir, 's1')), false);
    const lines = await goalStopLines(dir, 's1', { trace: 't' });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /goal met/);
    assert.deepEqual(await goalStopLines(dir, 's1', { trace: 't' }), []);
  });

  test('bro goal eval: impossible transitions + announces once', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'impossible';
    writeReq(dir, 's1', {
      createdAt: ACTIVE.createdAt,
      evals: 0,
      condition: 'tests pass',
      trace: 't',
    });
    await evalGoal(dir);
    assert.equal(readGoal(dir, 's1')?.status, 'impossible');
    const lines = await goalStopLines(dir, 's1', { trace: 't' });
    assert.match(lines[0]!, /goal judged impossible/);
  });

  test('bro goal eval: not_met spends a turn and the stop renders it', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'not_met';
    writeReq(dir, 's1', {
      createdAt: ACTIVE.createdAt,
      evals: 0,
      condition: 'tests pass',
      trace: 't',
    });
    await evalGoal(dir);
    const g = readGoal(dir, 's1');
    assert.equal(g?.evals, 1);
    assert.equal(g?.lastVerdict, 'not_met');
    assert.equal(existsSync(noticeFile(dir, 's1')), false);
    const lines = await goalStopLines(dir, 's1', { trace: 't' });
    assert.match(lines[0]!, /goal turn 1\/5 — not yet met/);
  });

  test('budget exhaustion transitions + announces via notice', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', { ...ACTIVE, evals: 4 });
    scripted = 'not_met';
    writeReq(dir, 's1', {
      createdAt: ACTIVE.createdAt,
      evals: 4,
      condition: 'tests pass',
      trace: 't',
    });
    await evalGoal(dir);
    assert.equal(readGoal(dir, 's1')?.status, 'budget');
    const lines = await goalStopLines(dir, 's1', { trace: 't' });
    assert.match(lines[0]!, /turn budget reached/);
  });

  test('a throwing judge restores the req for the next drain', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'throw';
    writeReq(dir, 's1', {
      createdAt: ACTIVE.createdAt,
      evals: 0,
      condition: 'tests pass',
      trace: 't',
    });
    await evalGoal(dir);
    assert.ok(existsSync(reqFile(dir, 's1')));
    assert.equal(readGoal(dir, 's1')?.evals, 0);
  });

  test('a stale-generation verdict drops instead of merging', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'met';
    writeReq(dir, 's1', { createdAt: 1, evals: 0, condition: 'tests pass', trace: 't' });
    await evalGoal(dir);
    const g = readGoal(dir, 's1');
    assert.equal(g?.status, 'active');
    assert.equal(g?.evals, 0);
    assert.equal(existsSync(reqFile(dir, 's1')), false);
  });

  test('a pause+resume mid-eval is a new generation — the in-flight verdict drops', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', { ...ACTIVE, createdAt: 1 });
    scripted = 'met';
    writeReq(dir, 's1', { createdAt: 1, evals: 0, condition: 'tests pass', trace: 't' });
    const prev = process.cwd();
    process.chdir(dir);
    try {
      runGoalCommand(['pause', '--session', 's1']);
      runGoalCommand(['resume', '--session', 's1']);
    } finally {
      process.chdir(prev);
    }
    // resume restarted the clock — the snapshot the req pinned is stale
    assert.notEqual(readGoal(dir, 's1')?.createdAt, 1);
    await evalGoal(dir);
    const g = readGoal(dir, 's1');
    assert.equal(g?.status, 'active');
    assert.equal(g?.evals, 0);
  });

  test('a newer req queued mid-decide survives a failed worker restore', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    scripted = 'throw';
    writeReq(dir, 's1', {
      createdAt: ACTIVE.createdAt,
      evals: 0,
      condition: 'tests pass',
      trace: 'old',
    });
    decideEffect = () =>
      writeReq(dir, 's1', {
        createdAt: ACTIVE.createdAt,
        evals: 0,
        condition: 'tests pass',
        trace: 'newer',
      });
    try {
      await evalGoal(dir);
    } finally {
      decideEffect = undefined;
    }
    // restore must not rename over the newer req — fresher evidence wins
    assert.match(readFileSync(reqFile(dir, 's1'), 'utf8'), /newer/);
  });

  test('no req → quiet no-op; a corrupt req is dropped', async () => {
    const dir = repo();
    judgeCfg(dir);
    writeRaw(dir, 's1', ACTIVE);
    await evalGoal(dir);
    writeFileSync(reqFile(dir, 's1'), '{not json');
    await evalGoal(dir);
    assert.equal(existsSync(reqFile(dir, 's1')), false);
    assert.equal(readGoal(dir, 's1')?.evals, 0);
  });
});

describe('goalContextLines', () => {
  test('active goal rehydrates; cleared does not', () => {
    const dir = repo();
    writeRaw(dir, 's1', ACTIVE);
    assert.match(goalContextLines(dir, 's1')[0]!, /goal \[active/);
    writeRaw(dir, 's1', { ...ACTIVE, status: 'cleared' });
    assert.deepEqual(goalContextLines(dir, 's1'), []);
  });

  test('no session → the repo seed still surfaces', () => {
    const dir = repo();
    writeRaw(dir, '_default', ACTIVE);
    assert.match(goalContextLines(dir, '')[0]!, /tests pass/);
  });
});

describe('runGoalCommand', () => {
  function inRepo(fn: () => void): void {
    const dir = repo();
    const prev = process.cwd();
    process.chdir(dir);
    try {
      fn();
    } finally {
      process.chdir(prev);
    }
  }

  function capture(fn: () => void): string {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.join(' '));
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return out.join('\n');
  }

  test('set → status → clear lifecycle on the repo seed', () => {
    inRepo(() => {
      const env = { ...process.env };
      for (const k of [
        'BRO_SESSION_ID',
        'DEVIN_SESSION_ID',
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_SESSION_ID',
        'CODEX_SESSION_ID',
        'OPENCODE_SESSION_ID',
      ]) {
        delete env[k];
      }
      process.env = env;
      capture(() => runGoalCommand(['make', 'it', 'green', '--turns', '10']));
      const g = readGoal(process.cwd(), '_default');
      assert.equal(g?.condition, 'make it green');
      assert.equal(g?.maxTurns, 10);
      const st = capture(() => runGoalCommand([]));
      assert.match(st, /make it green/);
      capture(() => runGoalCommand(['clear']));
      assert.equal(readGoal(process.cwd(), '_default')?.status, 'cleared');
    });
  });

  test('--session pins the record to that session', () => {
    inRepo(() => {
      capture(() => runGoalCommand(['ship', 'it', '--session', 'abc123']));
      assert.equal(readGoal(process.cwd(), 'abc123')?.condition, 'ship it');
      assert.equal(readGoal(process.cwd(), '_default'), null);
    });
  });

  test('CLAUDE_CODE_SESSION_ID resolves the Claude Code session, not the repo seed', () => {
    inRepo(() => {
      const prev = process.env;
      process.env = { ...prev, CLAUDE_CODE_SESSION_ID: 'cc-1' };
      delete process.env.BRO_SESSION_ID;
      delete process.env.DEVIN_SESSION_ID;
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.OPENCODE_SESSION_ID;
      try {
        capture(() => runGoalCommand(['ship', 'it']));
        assert.equal(readGoal(process.cwd(), 'cc-1')?.condition, 'ship it');
        capture(() => runGoalCommand(['clear']));
        assert.equal(readGoal(process.cwd(), 'cc-1')?.status, 'cleared');
        assert.equal(readGoal(process.cwd(), '_default'), null);
      } finally {
        process.env = prev;
      }
    });
  });

  test('pause then resume resets evals', () => {
    inRepo(() => {
      capture(() => runGoalCommand(['work', '--session', 's9']));
      writeRaw(process.cwd(), 's9', { ...readGoal(process.cwd(), 's9'), evals: 7 });
      capture(() => runGoalCommand(['pause', '--session', 's9']));
      assert.equal(readGoal(process.cwd(), 's9')?.status, 'paused');
      capture(() => runGoalCommand(['resume', '--session', 's9']));
      const g = readGoal(process.cwd(), 's9');
      assert.equal(g?.status, 'active');
      assert.equal(g?.evals, 0);
    });
  });

  test('status on empty repo reports no goal', () => {
    inRepo(() => {
      assert.match(
        capture(() => runGoalCommand([])),
        /no goal set/
      );
    });
  });
});

describe('goalStatusLine', () => {
  test('renders status, budget, and last verdict', () => {
    const line = goalStatusLine({
      ...ACTIVE,
      evals: 3,
      lastVerdict: 'not_met',
      lastReason: 'keep going',
    });
    assert.match(line, /\[active/);
    assert.match(line, /turns 3\/5/);
    assert.match(line, /last: not_met — keep going/);
  });
});
