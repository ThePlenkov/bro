import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { DecideResult, JudgeFacade, ProviderEntry } from '@broject/core';
import {
  migrateStore,
  newDecisionId,
  openStore,
  recordDecision,
  recordOutcome,
  type OutcomeReport,
  type StoreHandle,
} from '@broject/router-store';
import {
  classifyOutcome,
  formatBenchReport,
  parseJudgeId,
  parseReplayDecision,
  resolveContenders,
  runBenchReplay,
  type BenchReplayReport,
} from './bench-replay.ts';

/** Each test gets its own scratch dir + store — the engine's `dir`
 *  anchors config reads, the store carries the journal. */
const scratch = mkdtempSync(join(tmpdir(), 'brouter-bench-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;

/** The two-route table — declaration order ui then fallback, so
 *  static-table always picks 'ui'. */
const TABLE = {
  kind: 'route',
  version: 1,
  routes: [
    { name: 'ui', match: { labels: ['ui'] }, chain: [{ provider: 'kilo' }] },
    { name: 'fallback', match: {}, chain: [{ provider: 'omp' }] },
  ],
};

const CANDIDATES = [
  {
    reasons: ['label=ui'],
    route: { name: 'ui', match: { labels: ['ui'] }, chain: [{ provider: 'kilo' }] },
    score: 2,
  },
  {
    reasons: [],
    route: { name: 'fallback', match: {}, chain: [{ provider: 'omp' }] },
    score: 0,
  },
];

/** A cascade trace whose T0 stage pends nothing — before == after. */
const STAGES_CLEAN = {
  cascade: {
    decidedBy: 'rules',
    stages: [
      {
        stage: 'T0',
        before: ['ui', 'fallback'],
        after: ['ui', 'fallback'],
        latencyMs: 0,
        note: 'x',
      },
      {
        stage: 'T1',
        before: ['ui', 'fallback'],
        after: ['ui', 'fallback'],
        latencyMs: 1,
        note: 'x',
      },
      { stage: 'T2', before: [], after: [], latencyMs: 0, note: 'x' },
    ],
  },
};

type Store = Extract<StoreHandle, { ok: true }>;

async function store(name: string): Promise<{ s: Store; close: () => void; path: string }> {
  const path = join(scratch, `${name}.db`);
  const handle = openStore(path);
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  migrateStore(handle.db);
  return { s: handle as Store, close: () => handle.close(), path };
}

let seq = 0;
/** Journal one decision — `at` pins created_at for the recall freeze. */
async function journal(
  s: Store,
  over: {
    contextId?: string;
    at?: number;
    taskText?: string | null;
    candidates?: unknown;
    table?: unknown;
    stages?: unknown;
    route?: string | null;
    persistText?: boolean;
    successPredicate?: string;
  } = {}
): Promise<string> {
  const decisionId = newDecisionId();
  const ok = await recordDecision(s, {
    kind: 'route',
    contextId: over.contextId ?? 'ctx:bench',
    decisionId,
    at: over.at ?? T0,
    taskText: over.taskText === undefined ? 'ship the ui' : (over.taskText ?? undefined),
    task: { text: 'ship the ui' },
    features: { risk: false },
    // 'in' semantics — an explicitly-passed undefined writes a NULL
    // column (missing replay state), an absent key takes the fixture
    candidates: 'candidates' in over ? over.candidates : CANDIDATES,
    table: 'table' in over ? over.table : TABLE,
    stages: over.stages === undefined ? STAGES_CLEAN : over.stages,
    formulaText: undefined,
    route: over.route === undefined ? 'ui' : (over.route ?? undefined),
    provider: 'kilo',
    model: 'm',
    picked: 'static',
    successPredicate: over.successPredicate,
    persistText: over.persistText,
  });
  assert.equal(ok, true);
  return decisionId;
}

/** Land a verified (or pending) outcome on a decision. */
async function outcome(
  s: Store,
  decisionId: string,
  over: {
    result?: OutcomeReport['result'];
    rounds?: number;
    verified?: boolean;
    now?: number;
  } = {}
): Promise<void> {
  const report: OutcomeReport = {
    decisionId,
    result: over.result ?? 'merged',
    ...(over.rounds === undefined ? {} : { rounds: over.rounds }),
    reporter: 'test',
    eventId: `evt-${++seq}`,
    sourceId: 'test',
    sourceRevision: 1,
  };
  const res = await recordOutcome(s, report, {
    verify: () => over.verified ?? true,
    now: over.now ?? T0 + 60_000,
  });
  assert.equal(
    res.applied === 'inserted' || res.applied === 'pending' || res.applied === 'updated',
    true
  );
}

/** A scripted judge — records every decide() and answers from a queue
 *  (last entry repeats). */
function fakeJudge(
  script: Array<DecideResult | Error>,
  calls: Array<{ state: unknown; questions: Record<string, unknown> }>
): JudgeFacade {
  let i = 0;
  return {
    async decide(state, questions) {
      calls.push({ state, questions: questions as Record<string, unknown> });
      const next = script[Math.min(i, script.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const choice = (pick: string, over: Partial<DecideResult> = {}): DecideResult => ({
  answers: {
    route: {
      type: 'choice',
      choice: pick,
      probabilities: { [pick]: 0.9 },
      confidence: 0.9,
      decidedBy: 'test',
    },
  },
  model: 'fake-1',
  latencyMs: 5,
  lowConfidence: [],
  ...over,
});

const FAKE_PROVIDERS: Record<string, ProviderEntry> = {
  'fake-provider': {
    type: 'api',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'FAKE_KEY',
    models: { 'fake-1': 'openai-compat' },
  } as ProviderEntry,
};

const JUDGE_CFG = { confidence: 0.7, timeoutMs: 5_000 } as never;

/** Strip the wall-clock fields — picks and counts are the deterministic
 *  part; latency is measured, never asserted. */
function stable(report: BenchReplayReport): unknown {
  return {
    ...report,
    contenders: report.contenders.map(c => ({ ...c, latencyMs: null })),
  };
}

const contender = (report: BenchReplayReport, id: string) =>
  report.contenders.find(c => c.id === id);

describe('brouter bench replay', () => {
  test('static-table replays the journal and agrees only on verified successes', async () => {
    const { s, close } = await store('agree');
    try {
      const ctx = 'ctx:agree';
      const dUi = await journal(s, { contextId: ctx, route: 'ui' });
      const dFb = await journal(s, { contextId: ctx, route: 'fallback' });
      const dFailed = await journal(s, { contextId: ctx, route: 'ui' });
      const dUnlabelled = await journal(s, { contextId: ctx, route: 'ui' });
      const dNone = await journal(s, { contextId: ctx, route: 'ui' });
      const dPending = await journal(s, { contextId: ctx, route: 'ui' });
      await outcome(s, dUi, { result: 'merged', rounds: 1 });
      await outcome(s, dFb, { result: 'merged', rounds: 1 });
      await outcome(s, dFailed, { result: 'failed' });
      await outcome(s, dUnlabelled, { result: 'merged', rounds: undefined });
      await outcome(s, dPending, { verified: false });

      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        contextId: ctx,
        judges: ['static-table'],
        now: T0 + 120_000,
      });

      assert.equal(report.journal.decisions, 6);
      assert.equal(report.journal.replayable, 6);
      assert.deepEqual(report.journal.outcomeClasses, {
        success: 2,
        failure: 1,
        unlabelled: 1,
        unverified: 1,
        none: 1,
      });
      assert.deepEqual(report.journal.outcomeResults, { merged: 3, failed: 1 });

      const st = contender(report, 'static-table')!;
      assert.equal(st.answered, 6);
      assert.equal(st.abstained, 0);
      assert.equal(st.costUsdPer1k, 0);
      // labelled = the two verified successes; static picks 'ui' always —
      // agrees on dUi, misses dFb. Failed/unlabelled/unverified/none
      // outcomes carry no agreement target.
      assert.deepEqual(st.agreement, { labelled: 2, agreed: 1 });
      assert.deepEqual(st.picks, { ui: 6 });
      assert.equal(report.calibration.status, 'unavailable');
    } finally {
      close();
    }
  });

  test('a configured model contender answers the pick question and reports cost', async () => {
    const { s, close, path } = await store('model');
    const calls: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
    try {
      const ctx = 'ctx:model';
      await journal(s, { contextId: ctx, route: 'ui' });
      await journal(s, { contextId: ctx, route: 'fallback' });

      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        storePath: path,
        contextId: ctx,
        judges: ['fake-provider/fake-1'],
        providers: FAKE_PROVIDERS,
        judge: JUDGE_CFG,
        makeJudge: async () =>
          fakeJudge(
            [
              choice('fallback', {
                usage: { inputTokens: 100, costUsd: 0.125 },
              }),
            ],
            calls
          ),
        invoke: 'always',
        now: T0 + 120_000,
      });

      const m = contender(report, 'fake-provider/fake-1')!;
      assert.equal(m.kind, 'model');
      assert.equal(m.provider, 'fake-provider');
      assert.equal(m.model, 'fake-1');
      assert.equal(m.answered, 2);
      assert.equal(m.failed, 0);
      assert.equal(m.cost.knownCalls, 2);
      assert.equal(m.costUsdPer1k, 125); // $0.25 / 2 decisions * 1000
      assert.deepEqual(m.picks, { fallback: 2 });
      // the re-ask carried the journaled task + the candidate set as
      // the choice criteria — never a hard-wired route list
      assert.equal(calls.length, 2);
      const q = calls[0]!.questions['route'] as { type: string; criteria: Record<string, string> };
      assert.equal(q.type, 'choice');
      assert.deepEqual(Object.keys(q.criteria).sort(), ['fallback', 'ui']);
      assert.equal((calls[0]!.state as { task: string }).task, 'ship the ui');
    } finally {
      close();
    }
  });

  test('invoke gates model contenders — never skips all, ambiguous skips singletons', async () => {
    const { s, close, path } = await store('invoke');
    try {
      const ctx = 'ctx:invoke';
      await journal(s, { contextId: ctx, route: 'ui' }); // two candidates → ambiguous asks
      await journal(s, { contextId: ctx, route: 'ui', candidates: [CANDIDATES[0]] }); // one → skipped

      const mk = () =>
        runBenchReplay({
          dir: scratch,
          db: s.db,
          storePath: path,
          contextId: ctx,
          judges: ['fake-provider'],
          providers: FAKE_PROVIDERS,
          judge: JUDGE_CFG,
          makeJudge: async () => fakeJudge([choice('ui')], []),
          invoke: 'ambiguous',
          now: T0 + 120_000,
        });
      const report = await mk();
      const m = contender(report, 'fake-provider')!;
      assert.equal(m.answered, 1);
      assert.equal(m.skipped, 1);
      assert.equal(report.invoke.ambiguousSkips, 1);

      const never = await runBenchReplay({
        dir: scratch,
        db: s.db,
        storePath: path,
        contextId: ctx,
        judges: ['fake-provider'],
        providers: FAKE_PROVIDERS,
        judge: JUDGE_CFG,
        makeJudge: async () => fakeJudge([choice('ui')], []),
        invoke: 'never',
        now: T0 + 120_000,
      });
      const mn = contender(never, 'fake-provider')!;
      assert.equal(mn.answered, 0);
      assert.equal(mn.skipped, 2);
      assert.equal(mn.costUsdPer1k, 0); // nothing was ever spent
    } finally {
      close();
    }
  });

  test('a dead contender reports failed — never a 0% agreement', async () => {
    const { s, close, path } = await store('dead');
    try {
      const ctx = 'ctx:dead';
      for (let i = 0; i < 6; i += 1) {
        await journal(s, { contextId: ctx, route: 'ui' });
      }
      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        storePath: path,
        contextId: ctx,
        judges: ['fake-provider'],
        providers: FAKE_PROVIDERS,
        judge: JUDGE_CFG,
        makeJudge: async () => fakeJudge([new Error('provider down')], []),
        invoke: 'always',
        now: T0 + 120_000,
      });
      const m = contender(report, 'fake-provider')!;
      assert.equal(m.status, 'failed');
      assert.equal(m.answered, 0);
      assert.equal(m.failed, 6);
      assert.equal(m.agreement, null);
    } finally {
      close();
    }
  });

  test('incomplete replay state is skipped with distinct reasons', async () => {
    const { s, close } = await store('skips');
    try {
      const ctx = 'ctx:skips';
      await journal(s, { contextId: ctx }); // replayable
      await journal(s, { contextId: ctx, persistText: false }); // redacted — no text/snapshots
      await journal(s, { contextId: ctx, taskText: null }); // no task text
      await journal(s, { contextId: ctx, candidates: undefined }); // no candidate set
      await journal(s, { contextId: ctx, candidates: [] }); // empty set
      await journal(s, { contextId: ctx, candidates: 'garbage' }); // unparseable
      await journal(s, { contextId: ctx, table: undefined }); // no table snapshot
      await journal(s, { contextId: ctx, table: {} }); // unparseable table

      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        contextId: ctx,
        judges: ['static-table'],
        now: T0 + 120_000,
      });
      assert.equal(report.journal.decisions, 8);
      assert.equal(report.journal.replayable, 1);
      assert.deepEqual(report.journal.skipped, {
        'missing-task-text': 2, // persistText:false + explicit null
        'missing-candidates': 1,
        'empty-candidates': 1,
        'unparseable-candidates': 1,
        'missing-table': 1,
        'unparseable-table': 1,
      });
    } finally {
      close();
    }
  });

  test('t1-recall replays frozen evidence — post-decision outcomes never vote', async () => {
    const { s, close } = await store('recall');
    try {
      const ctx = 'ctx:recall';
      const T1 = T0 + 10_000;
      // pre-decision evidence: two verified fallback successes
      for (let i = 0; i < 2; i += 1) {
        const d = await journal(s, {
          contextId: ctx,
          at: T1 - 5_000 - i,
          taskText: 'fix the flaky test',
          route: 'fallback',
        });
        await outcome(s, d, { result: 'merged', rounds: 1, now: T1 - 4_000 - i });
      }
      // post-decision evidence: three verified ui successes accepted
      // AFTER the replayed decision — the freeze must exclude them
      for (let i = 0; i < 3; i += 1) {
        const d = await journal(s, {
          contextId: ctx,
          at: T1 + 4_000 + i,
          taskText: 'fix the flaky test',
          route: 'ui',
        });
        await outcome(s, d, { result: 'merged', rounds: 1, now: T1 + 5_000 + i });
      }
      // the replayed decision sits BETWEEN the two evidence windows
      const target = await journal(s, {
        contextId: ctx,
        at: T1,
        taskText: 'fix the flaky test',
        route: 'ui',
      });
      await outcome(s, target, { result: 'merged', rounds: 1, now: T1 + 9_000 });

      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        contextId: ctx,
        judges: ['static-table', 't1-recall'],
        recall: { k: 5, minAgreement: 0.5, minRows: 2 },
        now: T1 + 20_000,
      });

      const row = report.detail.find(d => d.decisionId === target)!;
      // frozen: only the two pre-T1 fallback successes vote → recall
      // decides 'fallback'; without the freeze the three post-T1 ui
      // successes would have decided 'ui'
      assert.equal(row.picks['t1-recall'], 'fallback');
      assert.equal(row.picks['static-table'], 'ui');
    } finally {
      close();
    }
  });

  test('replay is deterministic — identical input, identical report', async () => {
    const { s, close, path } = await store('det');
    const calls: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
    try {
      const ctx = 'ctx:det';
      const d1 = await journal(s, { contextId: ctx, route: 'ui' });
      const d2 = await journal(s, { contextId: ctx, route: 'fallback' });
      await outcome(s, d1, { result: 'merged', rounds: 1 });
      await outcome(s, d2, { result: 'failed' });
      const opts = {
        dir: scratch,
        db: s.db,
        storePath: path,
        contextId: ctx,
        judges: ['static-table', 'fake-provider'],
        providers: FAKE_PROVIDERS,
        judge: JUDGE_CFG,
        makeJudge: async () => fakeJudge([choice('ui', { usage: { costUsd: 0.002 } })], calls),
        invoke: 'always' as const,
        now: T0 + 120_000,
      };
      const r1 = await runBenchReplay(opts);
      const r2 = await runBenchReplay(opts);
      assert.deepEqual(stable(r1), stable(r2));
    } finally {
      close();
    }
  });

  test('--since windows the journal; unlabelled outcomes stay out of agreement', async () => {
    const { s, close } = await store('since');
    try {
      const ctx = 'ctx:since';
      const early = await journal(s, { contextId: ctx, at: T0, route: 'ui' });
      const late = await journal(s, { contextId: ctx, at: T0 + 50_000, route: 'ui' });
      await outcome(s, early, { result: 'merged', rounds: 1, now: T0 + 10_000 });
      await outcome(s, late, { result: 'merged', rounds: 2, now: T0 + 60_000 }); // mfr → failure

      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        contextId: ctx,
        judges: ['static-table'],
        since: T0 + 40_000,
        now: T0 + 120_000,
      });
      assert.equal(report.journal.decisions, 1);
      assert.equal(report.journal.replayable, 1);
      const st = contender(report, 'static-table')!;
      assert.equal(st.answered, 1);
      // the only in-window decision failed under merged_first_round —
      // no agreement target at all
      assert.equal(st.agreement, null);
    } finally {
      close();
    }
  });

  test('parseReplayDecision names the skip reason; classifyOutcome labels', () => {
    const row = {
      decisionId: 'd1',
      contextId: 'c',
      createdAt: T0,
      taskText: null,
      taskJson: null,
      featuresJson: null,
      candidatesJson: null,
      tableJson: null,
      tableHash: null,
      formulaText: null,
      formulaHash: null,
      formulaPath: null,
      judgeConfig: null,
      stageAnswers: null,
      route: null,
      provider: null,
      model: null,
      picked: null,
      cacheKey: null,
      cacheGeneration: null,
      successPredicate: null,
      beadId: null,
      worker: null,
      runId: null,
      pr: null,
    };
    assert.deepEqual(parseReplayDecision(row as never), {
      decisionId: 'd1',
      reason: 'missing-task-text',
    });
    // outcome classes — verified merged rounds=1 succeeds, rounds=2
    // fails under the default predicate, unverified never labels
    const base = {
      decisionId: 'x',
      contextId: 'c',
      tableHash: null,
      formulaHash: null,
      route: 'r',
      provider: null,
      model: null,
      taskText: null,
      featuresJson: null,
      reporter: null,
      eventId: null,
      sourceId: null,
      sourceRevision: null,
      threads: null,
      cost: null,
      tokens: null,
      wallMs: null,
      at: T0,
    };
    assert.equal(classifyOutcome(undefined, 'merged_first_round'), 'none');
    assert.equal(
      classifyOutcome(
        { ...base, result: 'merged', rounds: 1, verified: 1 } as never,
        'merged_first_round'
      ),
      'success'
    );
    assert.equal(
      classifyOutcome(
        { ...base, result: 'merged', rounds: 2, verified: 1 } as never,
        'merged_first_round'
      ),
      'failure'
    );
    assert.equal(
      classifyOutcome(
        { ...base, result: 'merged', rounds: null, verified: 1 } as never,
        'merged_first_round'
      ),
      'unlabelled'
    );
    assert.equal(
      classifyOutcome(
        { ...base, result: 'merged', rounds: 1, verified: 0 } as never,
        'merged_first_round'
      ),
      'unverified'
    );
  });

  test('judge ids parse; unknown contenders are usage errors', () => {
    assert.deepEqual(parseJudgeId('static-table'), { builtin: 'static-table' });
    assert.deepEqual(parseJudgeId('t1-recall'), { builtin: 't1-recall' });
    assert.deepEqual(parseJudgeId('jev'), { provider: 'jev' });
    assert.deepEqual(parseJudgeId('arch/ministral-3b'), {
      provider: 'arch',
      model: 'ministral-3b',
    });
    // an id naming no built-in and no configured provider throws before
    // any contender binds — the CLI surfaces it as a usage error
    assert.throws(
      () =>
        resolveContenders({
          judges: ['ghost'],
          providers: FAKE_PROVIDERS,
          judge: JUDGE_CFG,
          db: {} as never,
          recall: { k: 5, minAgreement: 0.6, minRows: 3 },
        }),
      /unknown contender "ghost"/
    );
  });

  test('the markdown report renders the metrics table', async () => {
    const { s, close } = await store('md');
    try {
      const ctx = 'ctx:md';
      const d = await journal(s, { contextId: ctx, route: 'ui' });
      await outcome(s, d, { result: 'merged', rounds: 1 });
      const report = await runBenchReplay({
        dir: scratch,
        db: s.db,
        contextId: ctx,
        judges: ['static-table'],
        now: T0 + 120_000,
      });
      const md = formatBenchReport(report);
      assert.match(md, /# brouter bench — classifier replay/);
      assert.match(md, /\| contender \| kind \| agreement \|/);
      assert.match(md, /\| static-table \| builtin \| 100\.0% \| 1 \|/);
      assert.match(md, /not routing accuracy/);
    } finally {
      close();
    }
  });
});
