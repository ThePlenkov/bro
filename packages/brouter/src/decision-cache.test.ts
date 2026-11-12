import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { BrouterRouter, DecideResult, JudgeAnswer, JudgeFacade } from '@broject/core';
import type { RouteTable } from '@broject/router-routes';
import {
  migrateStore,
  newDecisionId,
  openStore,
  recordDecision,
  recordLimit,
  recordOutcome,
  routerStorePath,
  type OutcomeReport,
  type StoreHandle,
} from '@broject/router-store';
import { decisionContextId } from './context.ts';
import { runRouteCommand } from './route-cmd.ts';
import {
  buildCacheKey,
  cacheConfig,
  decodeCacheValue,
  encodeCacheValue,
  judgeConfigHash,
  normalizeTask,
  normalizeTaskText,
} from './decision-cache.ts';
import { decideRoute } from './route-decide.ts';

/** The router's ledger is XDG state — isolate it for the whole file. */
const scratch = mkdtempSync(join(tmpdir(), 'brouter-cache-'));
process.env.XDG_STATE_HOME = join(scratch, 'state');
after(() => rmSync(scratch, { recursive: true, force: true }));

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch project dir — `bro.config.json` names the judge lane the
 *  cache key hashes (a cli entry: resolution is all the hash needs,
 *  the seam judge answers instead). */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brouter-cache-dir-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'bro.config.json'),
    JSON.stringify({ providers: { j: { type: 'cli', command: 'true' } } })
  );
  return dir;
}

/** A unique table path per test — the contextId namespaces by the
 *  canonical table PATH, so a fresh path isolates the shared XDG
 *  store exactly like separate projects. */
let tableSeq = 0;
function tablePath(): string {
  return join(scratch, `routes-${++tableSeq}.toml`);
}

/** The two-route table — route a's chain survives a wall on 'a'
 *  through its second entry, so health re-resolution stays observable
 *  on a cache hit. */
const TABLE: RouteTable = {
  kind: 'route',
  version: 1,
  routes: [
    {
      name: 'a',
      match: {},
      chain: [{ provider: 'a' }, { provider: 'a2' }],
      description: 'the a lane',
    },
    { name: 'b', match: {}, chain: [{ provider: 'b' }], description: 'the b lane' },
  ],
};

const PICK_FORMULA = [
  '---',
  'kind: formula',
  'shape: pick',
  '---',
  'Pick the route this task belongs to.',
].join('\n');

/** A pick formula on disk — the decideRoute input is a PATH. */
function formulaPath(dir: string, text: string = PICK_FORMULA): string {
  const path = join(dir, `formula-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, text);
  return path;
}

const choice = (pick: string, p = 0.9): JudgeAnswer => ({
  type: 'choice',
  choice: pick,
  probabilities: { [pick]: p },
  confidence: 0.9,
  decidedBy: 'fake',
});

/** The fake judge — fixed answers, every decide() counted. */
function fakeJudge(answers: Record<string, JudgeAnswer>): {
  judge: JudgeFacade;
  calls: () => number;
} {
  let n = 0;
  return {
    calls: () => n,
    judge: {
      decide: async () => {
        n += 1;
        const res: DecideResult = {
          answers,
          model: 'fake-judge',
          latencyMs: 1,
          lowConfidence: [],
        };
        return res;
      },
    },
  };
}

/** The router config the cache keys on — provider 'j' resolves the
 *  cli lane bro.config.json declares; mode enforce trusts the pick. */
function router(cache?: 'exact' | 'recall', extra: Partial<BrouterRouter> = {}): BrouterRouter {
  return {
    provider: 'j',
    mode: 'enforce',
    ...(cache === undefined ? {} : { cache }),
    ...extra,
  };
}

/** One decideRoute call with the test's standard inputs. */
function decide(
  dir: string,
  over: {
    tp?: string;
    formula?: string;
    text?: string;
    task?: Parameters<typeof decideRoute>[0]['task'];
    judge: JudgeFacade;
    router?: BrouterRouter;
    noCache?: boolean;
  }
) {
  return decideRoute({
    dir,
    table: TABLE,
    tablePath: over.tp ?? tablePath(),
    task: over.task ?? {},
    text: over.text ?? 'ship the feature',
    formula: over.formula ?? formulaPath(dir),
    judge: over.judge,
    ...(over.router === undefined ? {} : { router: over.router }),
    ...(over.noCache === undefined ? {} : { noCache: over.noCache }),
  });
}

/** A migrated store handle on the isolated XDG path. */
async function store(): Promise<Extract<StoreHandle, { ok: true }>> {
  const handle = openStore(routerStorePath());
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  migrateStore(handle.db);
  return handle as Extract<StoreHandle, { ok: true }>;
}

/** The cache rows in the store FOR ONE CONTEXT — the shared XDG ledger
 *  accumulates every test's entries, so an unscoped count lies. */
function cacheRows(s: Extract<StoreHandle, { ok: true }>, contextId: string): number {
  const row = s.db.$client
    .prepare('select count(*) as n from decision_cache where context_id = ?')
    .get(contextId) as { n: number };
  return row.n;
}

/** The journaled decision row's cache columns. */
function journalRow(
  s: Extract<StoreHandle, { ok: true }>,
  decisionId: string
): {
  picked: string | null;
  cache_key: string | null;
  cache_generation: number | null;
  success_predicate: string | null;
} {
  return s.db.$client
    .prepare(
      'select picked, cache_key, cache_generation, success_predicate from decisions where decision_id = ?'
    )
    .get(decisionId) as {
    picked: string | null;
    cache_key: string | null;
    cache_generation: number | null;
    success_predicate: string | null;
  };
}

function outcomeReport(decisionId: string, over: Partial<OutcomeReport> = {}): OutcomeReport {
  return {
    decisionId,
    result: 'merged',
    reporter: 'bro:act',
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sourceId: 'bro:merge-authority',
    sourceRevision: 1,
    rounds: 1,
    ...over,
  };
}

describe('the cache config', () => {
  test('off is the default — no mode, no consult, no write', () => {
    assert.equal(cacheConfig(undefined, undefined), undefined);
    assert.equal(cacheConfig(router(), undefined), undefined);
    assert.equal(cacheConfig(router('exact'), true), undefined, '--no-cache wins');
    const exact = cacheConfig(router('exact'), undefined);
    assert.equal(exact?.mode, 'exact');
    assert.equal(exact?.ttlMs, 24 * 3_600_000, 'the 24h default');
    const custom = cacheConfig(router('recall', { cacheTtlHours: 2 }), undefined);
    assert.equal(custom?.ttlMs, 2 * 3_600_000);
  });
});

describe('the key', () => {
  test('the task text normalizes — whitespace collapses, case stays', () => {
    assert.equal(normalizeTaskText('  ship   the\nfeature  '), 'ship the feature');
    assert.equal(normalizeTaskText('Fix the BUG'), 'Fix the BUG');
  });

  test('the carried fields normalize — sets sort, absent stays absent', () => {
    const task = normalizeTask({
      type: 'bug',
      labels: ['zeta', 'alpha'],
      paths: ['b.ts', 'a.ts'],
      features: { tier: 'pro' },
    });
    assert.deepEqual(task.labels, ['alpha', 'zeta']);
    assert.deepEqual(task.paths, ['a.ts', 'b.ts']);
    assert.equal(task.type, 'bug');
    assert.equal('complexity' in task, false);
    assert.equal('priority' in task, false);
  });

  test('judgeConfigHash covers the provider — a config edit misses', async () => {
    const dir = scratchDir();
    const before = await judgeConfigHash(dir, { provider: 'j', mode: 'enforce' });
    assert.ok(before !== undefined);
    // the same config hashes the same
    assert.equal(await judgeConfigHash(dir, { provider: 'j', mode: 'enforce' }), before);
    // a different mode is a different judge configuration
    assert.notEqual(await judgeConfigHash(dir, { provider: 'j', mode: 'shadow' }), before);
    // an unknown provider cannot hash — the cache stays off rather than
    // keying on a guess
    assert.equal(await judgeConfigHash(dir, { provider: 'missing', mode: 'enforce' }), undefined);
  });

  test('buildCacheKey — exact carries text+fields, recall needs a cluster', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const base = {
      dir,
      tablePath: tp,
      table: TABLE,
      text: 'ship the feature',
      task: {},
      router: { provider: 'j', mode: 'enforce' as const },
      shape: 'none' as const,
    };
    const exact = await buildCacheKey({ ...base, mode: 'exact' });
    assert.ok(exact !== undefined);
    const key = JSON.parse(exact.keyJson) as Record<string, unknown>;
    assert.equal(key.contextId, decisionContextId(dir, { tablePath: tp }));
    assert.equal(key.shape, 'none');
    assert.equal(key.mode, 'exact');
    assert.equal(key.formulaHash, null);
    assert.equal(typeof key.tableHash, 'string');
    assert.equal(typeof key.judge, 'string');
    const taskPart = key.task as { text?: string; fields?: unknown };
    assert.equal(taskPart.text, 'ship the feature');
    // recall mode with no cluster cannot build a key — the clean miss
    assert.equal(await buildCacheKey({ ...base, mode: 'recall' }), undefined);
    const recall = await buildCacheKey({ ...base, mode: 'recall', cluster: 'cluster-1' });
    assert.ok(recall !== undefined);
    const recallKey = JSON.parse(recall.keyJson) as Record<string, unknown>;
    assert.deepEqual(recallKey.task, { cluster: 'cluster-1' });
    // the two modes never share a key
    assert.notEqual(recall.keyHash, exact.keyHash);
  });

  test('the value codec round-trips and rejects garbage', () => {
    const pick = { kind: 'pick' as const, pick: 'a' };
    assert.deepEqual(decodeCacheValue(encodeCacheValue(pick)), pick);
    const answers = {
      kind: 'answers' as const,
      res: { answers: { route: choice('b') }, model: 'm', latencyMs: 1, lowConfidence: [] },
      t3: false,
    };
    assert.deepEqual(decodeCacheValue(encodeCacheValue(answers)), answers);
    assert.equal(decodeCacheValue('not json'), undefined);
    assert.equal(decodeCacheValue('{"kind":"bogus"}'), undefined);
    assert.equal(decodeCacheValue('{"kind":"pick","pick":42}'), undefined);
  });
});

describe('decideRoute — exact mode', () => {
  test('off by default — the judge runs every time, nothing journals', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const first = await decide(dir, { tp, formula: formulaPath(dir), judge, router: router() });
    const second = await decide(dir, {
      tp,
      formula: formulaPath(dir),
      judge,
      router: router(),
      text: 'ship the feature',
    });
    assert.equal(calls(), 2, 'no cache — the judge answered both times');
    assert.equal(first.decision.cache, undefined);
    assert.equal(second.decision.cache, undefined);
    const s = await store();
    assert.equal(cacheRows(s, decisionContextId(dir, { tablePath: tp })), 0);
    s.close();
  });

  test('miss then hit — the judge is asked once, the pick replays', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    assert.equal(first.decision.route?.name, 'a');
    assert.equal(first.decision.cache?.hit, false);
    assert.ok(first.decision.cache !== undefined && first.decision.cache.key.length === 64);
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1, 'the hit skipped T2 entirely');
    assert.equal(second.decision.route?.name, 'a');
    assert.equal(second.decision.cache?.hit, true);
    assert.ok((second.decision.cache?.ageMs ?? -1) >= 0);
    // the journal distinguishes the hit — picked 'cache', key +
    // generation + predicate recorded for BOTH decisions
    const s = await store();
    const row1 = journalRow(s, first.decisionId);
    const row2 = journalRow(s, second.decisionId);
    assert.equal(row1.picked, 'model');
    assert.equal(row2.picked, 'cache');
    assert.equal(row1.cache_key, second.decision.cache?.key);
    assert.equal(row1.cache_generation, first.decision.cache?.generation);
    assert.equal(row2.cache_key, first.decision.cache?.key);
    assert.equal(row2.cache_generation, first.decision.cache?.generation);
    assert.equal(row1.success_predicate, 'merged_first_round');
    assert.equal(cacheRows(s, decisionContextId(dir, { tablePath: tp })), 1);
    s.close();
  });

  test('a wall that appeared since the write still wins — health re-runs', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    // wall provider 'a' — the cached pick names route a, whose chain
    // survives through 'a2'; the hit must re-resolve the chain, not
    // replay the stored route
    const s = await store();
    await recordLimit(s.db, {
      provider: 'a',
      model: '',
      resetAt: Date.now() + 3_600_000,
      reason: 'rate-limited',
      source: 'test',
      seenAt: Date.now(),
    });
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1, 'still a hit — the judge stayed unasked');
    assert.equal(second.decision.cache?.hit, true);
    assert.equal(second.decision.route?.name, 'a', 'the pick replays');
    assert.deepEqual(
      second.decision.chain.map(e => e.provider),
      ['a2'],
      'the walled head dropped — current health won over the memo'
    );
    assert.equal(second.decision.dropped[0]?.entry.provider, 'a');
  });

  test('a formula edit misses — the formula hash is in the key', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    // same task, same table — a different formula file is a different
    // question, so the memo cannot answer it
    const edited = formulaPath(dir, `${PICK_FORMULA}\n<!-- edited -->`);
    const second = await decide(dir, { tp, formula: edited, judge, router: rt });
    assert.equal(calls(), 2, 'the edited formula missed');
    assert.equal(second.decision.cache?.hit, false);
    // and the ORIGINAL formula still hits its own entry
    const third = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the original formula hit');
    assert.equal(third.decision.cache?.hit, true);
  });

  test('a judge config edit misses — provider identity is in the key', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    // the provider entry changes — the judge that would answer is a
    // different configuration, so the memo cannot vouch for it
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({ providers: { j: { type: 'cli', command: 'false' } } })
    );
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the edited provider missed');
    assert.equal(second.decision.cache?.hit, false);
  });

  test('the TTL expires the entry — a stale answer stops serving', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    // ~3.6ms TTL — the entry is born expired for the next decision
    const rt = router('exact', { cacheTtlHours: 0.000001 });
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(first.decision.cache?.hit, false);
    assert.equal(calls(), 1);
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the expired entry missed');
    assert.equal(second.decision.cache?.hit, false);
  });

  test('--no-cache bypasses the consult and the write — entries stay', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    const bypass = await decide(dir, { tp, formula: f, judge, router: rt, noCache: true });
    assert.equal(calls(), 2, 'the bypass asked the judge again');
    assert.equal(bypass.decision.cache, undefined, 'no consult, no journal field');
    const s = await store();
    assert.equal(
      cacheRows(s, decisionContextId(dir, { tablePath: tp })),
      1,
      'the bypass neither wrote nor deleted'
    );
    s.close();
    const third = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the entry still answers afterwards');
    assert.equal(third.decision.cache?.hit, true);
  });
});

describe('decideRoute — outcome invalidation', () => {
  test('a verified failure drops the entry — the next ask misses', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    const s = await store();
    // the merge authority reports the routed work FAILED — verified
    // evidence, so the memoized answer is disproved
    await recordOutcome(s, outcomeReport(first.decisionId, { result: 'failed' }), {
      verify: () => true,
    });
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the invalidated entry missed');
    assert.equal(second.decision.cache?.hit, false);
    // the fresh answer re-memoized — a third ask hits again
    const third = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2);
    assert.equal(third.decision.cache?.hit, true);
  });

  test('merged_first_round — a second-round merge invalidates, first-round does not', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    const s = await store();
    // merged but NOT first round — under the default predicate that is
    // a failure, and the memoized answer is disproved
    await recordOutcome(s, outcomeReport(first.decisionId, { result: 'merged', rounds: 2 }), {
      verify: () => true,
    });
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 2, 'the second-round merge invalidated');
    assert.equal(second.decision.cache?.hit, false);
  });

  test('success: merged — the same second-round merge is a success, no invalidation', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const mergedFormula = [
      '---',
      'kind: formula',
      'shape: pick',
      'success: merged',
      '---',
      'Pick the route this task belongs to.',
    ].join('\n');
    const f = formulaPath(dir, mergedFormula);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1);
    const s = await store();
    const row = journalRow(s, first.decisionId);
    assert.equal(row.success_predicate, 'merged', 'the formula predicate journaled');
    await recordOutcome(s, outcomeReport(first.decisionId, { result: 'merged', rounds: 2 }), {
      verify: () => true,
    });
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1, 'a success under the declared predicate keeps the entry');
    assert.equal(second.decision.cache?.hit, true);
  });

  test('merged with unknown rounds is unlabelled — never a verdict', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    const s = await store();
    // merged, rounds unknown — under merged_first_round the shared
    // evaluator calls it unlabelled: excluded, never assumed
    await recordOutcome(
      s,
      outcomeReport(first.decisionId, { result: 'merged', rounds: undefined }),
      { verify: () => true }
    );
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1, 'an unlabelled outcome invalidates nothing');
    assert.equal(second.decision.cache?.hit, true);
  });

  test('a pending (unverified) report never invalidates', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('exact');
    const first = await decide(dir, { tp, formula: f, judge, router: rt });
    const s = await store();
    await recordOutcome(s, outcomeReport(first.decisionId, { result: 'failed' }), {});
    s.close();
    const second = await decide(dir, { tp, formula: f, judge, router: rt });
    assert.equal(calls(), 1, 'assertions are not evidence — the entry stands');
    assert.equal(second.decision.cache?.hit, true);
  });
});

describe('decideRoute — recall mode', () => {
  test('no eligible cluster misses cleanly — no error, no cache field', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const f = formulaPath(dir);
    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('recall');
    const first = await decide(dir, { tp, formula: f, judge, router: rt, text: 'anything' });
    assert.equal(calls(), 1, 'the judge ran — nothing cached');
    assert.equal(first.decision.cache, undefined, 'no cluster, no consult, no journal field');
    const s = await store();
    assert.equal(cacheRows(s, decisionContextId(dir, { tablePath: tp })), 0);
    s.close();
  });

  test('the cluster is the evidence — different texts share one entry', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const formulaText = PICK_FORMULA;
    const f = formulaPath(dir, formulaText);
    const contextId = decisionContextId(dir, { tablePath: tp });
    // one verified success in the recall scope — enough for a cluster
    // (T1 needs more rows to DECIDE; the cluster only needs evidence)
    const s = await store();
    const seedId = newDecisionId();
    assert.equal(
      await recordDecision(s, {
        kind: 'route',
        contextId,
        decisionId: seedId,
        taskText: 'shared alpha vocabulary',
        route: 'a',
        provider: 'a',
        model: 'm',
        table: TABLE,
        formulaText,
      }),
      true
    );
    await recordOutcome(s, outcomeReport(seedId, { result: 'merged', rounds: 1 }), {
      verify: () => true,
    });
    s.close();

    const { judge, calls } = fakeJudge({ route: choice('a') });
    const rt = router('recall');
    // two different texts retrieve the same evidence row — the cluster
    // hashes the ROWS, so both land on one cache key
    const first = await decide(dir, {
      tp,
      formula: f,
      judge,
      router: rt,
      text: 'shared beta words',
    });
    assert.equal(calls(), 1);
    assert.equal(first.decision.cache?.hit, false);
    const second = await decide(dir, {
      tp,
      formula: f,
      judge,
      router: rt,
      text: 'shared gamma terms',
    });
    assert.equal(calls(), 1, 'the second text hit the shared cluster entry');
    assert.equal(second.decision.cache?.hit, true);
    assert.equal(second.decision.route?.name, 'a');
  });
});

describe('decideRoute — the features shape', () => {
  test('the answers value replays — filters and match re-run on a hit', async () => {
    const dir = scratchDir();
    const tp = tablePath();
    const featuresFormula = [
      '---',
      'kind: formula',
      'shape: features',
      'questions:',
      '  tier: { type: choice, options: [free, pro] }',
      '---',
      'Pick the tier.',
    ].join('\n');
    const f = formulaPath(dir, featuresFormula);
    // unique provider names — the wall test's limit on 'a' lives in the
    // shared XDG ledger for the whole file
    const featuresTable: RouteTable = {
      kind: 'route',
      version: 1,
      routes: [
        { name: 'pro', match: { features: { tier: 'pro' } }, chain: [{ provider: 'fp' }] },
        { name: 'free', match: { features: { tier: 'free' } }, chain: [{ provider: 'fq' }] },
      ],
    };
    const fk = fakeJudge({
      tier: choice('pro'),
    });
    const rt = router('exact');
    const run = () =>
      decideRoute({
        dir,
        table: featuresTable,
        tablePath: tp,
        task: {},
        text: 'ship the feature',
        formula: f,
        judge: fk.judge,
        router: rt,
      });
    const first = await run();
    assert.equal(fk.calls(), 1);
    assert.equal(first.decision.route?.name, 'pro');
    assert.equal(first.decision.cache?.hit, false);
    const second = await run();
    assert.equal(fk.calls(), 1, 'the answers replayed — decide() stayed unasked');
    assert.equal(second.decision.cache?.hit, true);
    assert.equal(second.decision.route?.name, 'pro');
    // the replayed answers still land on the trace — the explanation
    // shows what the memo answered
    assert.equal(second.decision.formula?.answers[0]?.value, 'pro');
  });
});

describe('the CLI surface — brouter route --no-cache', () => {
  test('the flag bypasses the consult — miss, silence, then the replayed hit', async () => {
    const dir = scratchDir();
    const tableFile = join(dir, 'routes.toml');
    writeFileSync(
      tableFile,
      [
        'kind = "route"',
        'version = 1',
        '',
        '[routes.any]',
        'chain = [{ provider = "j" }]',
        '',
      ].join('\n')
    );
    // the router config opts the cache in; invoke=always makes the
    // single-candidate table still ask T2. The cli 'true' lane binds —
    // its empty answer fails the judge parse, so the memoized pick is
    // null: still a stage answer worth replaying.
    writeFileSync(
      join(dir, 'bro.config.json'),
      JSON.stringify({
        providers: { j: { type: 'cli', command: 'true' } },
        brouter: {
          router: { provider: 'j', mode: 'enforce', invoke: 'always', cache: 'exact' },
        },
      })
    );
    const prev = process.cwd();
    process.chdir(dir);
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = ((...args: unknown[]) => {
      out.push(args.map(String).join(' '));
    }) as typeof console.log;
    console.error = ((...args: unknown[]) => {
      out.push(`ERR ${args.map(String).join(' ')}`);
    }) as typeof console.error;
    const run = async (extra: string[] = []): Promise<string> => {
      out.length = 0;
      await runRouteCommand(['ship the feature', '--routes', tableFile, ...extra]);
      return out.join('\n');
    };
    try {
      const first = await run();
      assert.match(first, /cache: miss/, 'the consult ran and missed');
      const second = await run(['--no-cache']);
      assert.doesNotMatch(second, /cache:/, 'the bypass never consults');
      const third = await run();
      assert.match(third, /cache: hit/, 'the memoized answer replayed');
    } finally {
      console.log = log;
      console.error = err;
      process.chdir(prev);
    }
  });
});
