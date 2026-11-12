import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import type { DecideResult, JudgeAnswer, JudgeFacade } from '@broject/core';
import {
  parseFormulaText,
  readRouteTable,
  type Formula,
  type Route,
  type RouteTable,
} from '@broject/router-routes';
import {
  migrateStore,
  newDecisionId,
  openStore,
  recordDecision,
  recordOutcome,
  routerStorePath,
  type OutcomeReport,
  type StoreHandle,
} from '@broject/router-store';
import { decisionContextId } from './context.ts';
import { routerOutcomeStats } from './outcome-stats.ts';
import { decideRoute } from './route-decide.ts';

/** The router's ledger is XDG state — isolate it for the whole file. */
const scratch = mkdtempSync(join(tmpdir(), 'brouter-outcome-stats-'));
process.env['XDG_STATE_HOME'] = join(scratch, 'state');
after(() => rmSync(scratch, { recursive: true, force: true }));

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A scratch working dir — no .git, so contextId falls to the table
 *  namespace exactly like a standalone caller's. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brouter-stats-dir-'));
  dirs.push(dir);
  return dir;
}

/** The score formula — two declared questions so the bucket's key set
 *  is observable, zero weights so p alone ranks. */
const FORMULA_MD = [
  '---',
  'kind: formula',
  'version: 1',
  'shape: score',
  'questions:',
  '  risk: { type: bool }',
  '  tier: { type: choice, options: [free, pro] }',
  'score: { lambda: 0, mu: 0 }',
  'success: merged_first_round',
  '---',
  'The rubric the decision model reads.',
].join('\n');

const FORMULA_PATH = join(scratch, 'score.md');
writeFileSync(FORMULA_PATH, FORMULA_MD);
const FORMULA: Formula = parseFormulaText(FORMULA_MD, 'score.md');

/** The two-route table — declaration order a then b. */
const TABLE: RouteTable = {
  kind: 'route',
  version: 1,
  routes: [
    { name: 'a', match: {}, chain: [{ provider: 'a' }] },
    { name: 'b', match: {}, chain: [{ provider: 'b' }] },
  ],
};

/** A unique table path per test — the contextId namespaces by the
 *  canonical table PATH (`table:<digest>`), so a fresh path per test
 *  isolates the shared XDG store exactly like separate projects. The
 *  file need not exist: canonicalPath falls back to the path itself. */
let tableSeq = 0;
function tablePath(): string {
  return join(scratch, `routes-${++tableSeq}.toml`);
}

function route(name: string): Route {
  return { name, match: {}, chain: [{ provider: name }] };
}

/** A migrated store handle on the isolated XDG path. */
async function store(): Promise<Extract<StoreHandle, { ok: true }>> {
  const handle = openStore(routerStorePath());
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  migrateStore(handle.db);
  return handle as Extract<StoreHandle, { ok: true }>;
}

/** Journal one decision the way decideRoute does — the hashes and the
 *  feature bucket the outcome will copy at report time. */
async function journal(
  s: Extract<StoreHandle, { ok: true }>,
  over: {
    contextId?: string;
    route?: string;
    features?: Record<string, string | number | boolean>;
    table?: RouteTable;
    formulaText?: string;
  } = {}
): Promise<string> {
  const decisionId = newDecisionId();
  const ok = await recordDecision(s, {
    kind: 'route',
    contextId: over.contextId ?? 'ctx:test',
    decisionId,
    taskText: 'a routed task',
    features: over.features ?? { risk: false, tier: 'pro' },
    route: over.route ?? 'a',
    provider: 'a',
    model: 'm',
    table: over.table ?? TABLE,
    formulaText: over.formulaText ?? FORMULA_MD,
  });
  assert.equal(ok, true);
  return decisionId;
}

function report(decisionId: string, over: Partial<OutcomeReport> = {}): OutcomeReport {
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

const verified = { verify: () => true };

/** Build the live source for a scratch dir — the same inputs
 *  decideRoute passes. */
function statsSource(dir: string, over: { tablePath: string; now?: number; formulaText?: string }) {
  return routerOutcomeStats({
    dir,
    tablePath: over.tablePath,
    table: TABLE,
    formulaText: over.formulaText ?? FORMULA_MD,
    ...(over.now === undefined ? {} : { now: over.now }),
  });
}

describe('routerOutcomeStats — the live OutcomeStatsSource', () => {
  test('statsFor maps verified rows to p/n/costUsd/wallSec per route', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    // route a: one first-round merge, one failure — both measured
    const a1 = await journal(s, { contextId, route: 'a' });
    await recordOutcome(
      s,
      report(a1, { result: 'merged', rounds: 1, cost: 0.5, wallMs: 2000 }),
      verified
    );
    const a2 = await journal(s, { contextId, route: 'a' });
    await recordOutcome(
      s,
      report(a2, {
        result: 'failed',
        rounds: 3,
        eventId: 'evt-a2',
        cost: 1.5,
        wallMs: 6000,
      }),
      verified
    );
    // route b: one first-round merge, measures NULL — unknown, not zero
    const b1 = await journal(s, { contextId, route: 'b' });
    await recordOutcome(s, report(b1, { rounds: 1 }), verified);

    const source = await statsSource(dir, { tablePath: tp });
    const a = source.statsFor(route('a'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(a.n, 2);
    assert.equal(a.p, 0.5); // (1 success + 1) / (2 + 2)
    assert.equal(a.costUsd, 1.0); // mean of 0.5 and 1.5
    assert.equal(a.wallSec, 4.0); // mean of 2s and 6s
    const b = source.statsFor(route('b'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(b.n, 1);
    assert.equal(b.p, (1 + 1) / (1 + 2));
    assert.equal(b.costUsd, undefined);
    assert.equal(b.wallSec, undefined);
    s.close();
  });

  test('the feature bucket is the formula’s declared question keys', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    const id = await journal(s, {
      contextId,
      route: 'a',
      // an extra non-question key rides along — the bucket ignores it
      features: { risk: false, tier: 'pro', extra: 'ignored' },
    });
    await recordOutcome(s, report(id, { rounds: 1 }), verified);

    const source = await statsSource(dir, { tablePath: tp });
    // same question-key values → the row counts, whatever else differs
    const hit = source.statsFor(
      route('a'),
      { risk: false, tier: 'pro', other: 'different' },
      FORMULA,
      TABLE
    );
    assert.equal(hit.n, 1);
    // a different answer on a declared key → a different bucket → prior
    const miss = source.statsFor(route('a'), { risk: true, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(miss.n, 0);
    assert.equal(miss.p, 0.5);
    s.close();
  });

  test('context, table, formula, route and window all scope the stats', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    const inScope = await journal(s, { contextId, route: 'a' });
    await recordOutcome(s, report(inScope, { rounds: 1 }), verified);
    // a different context
    const otherCtx = await journal(s, { contextId: 'ctx:other', route: 'a' });
    await recordOutcome(s, report(otherCtx, { rounds: 1 }), verified);
    // a different table hash
    const otherTable = await journal(s, {
      contextId,
      route: 'a',
      table: { kind: 'route', version: 1, routes: [] },
    });
    await recordOutcome(s, report(otherTable, { rounds: 1 }), verified);
    // a different formula hash
    const otherFormula = await journal(s, {
      contextId,
      route: 'a',
      formulaText: '---\nkind: formula\nshape: pick\n---\nother\n',
    });
    await recordOutcome(s, report(otherFormula, { rounds: 1 }), verified);
    // expired — outside the 30-day window
    const old = await journal(s, { contextId, route: 'a' });
    await recordOutcome(s, report(old, { rounds: 1, eventId: 'evt-old' }), {
      ...verified,
      now: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });

    const source = await statsSource(dir, { tablePath: tp });
    const a = source.statsFor(route('a'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(a.n, 1); // only the in-scope row
    assert.equal(a.p, (1 + 1) / (1 + 2));
    // route b has no rows at all
    const b = source.statsFor(route('b'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(b.n, 0);
    assert.equal(b.p, 0.5);
    s.close();
  });

  test('unverified and pending rows never reach statsFor', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    const pending = await journal(s, { contextId, route: 'a' });
    await recordOutcome(s, report(pending, { rounds: 1 })); // no verify → pending
    const source = await statsSource(dir, { tablePath: tp });
    const a = source.statsFor(route('a'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(a.n, 0);
    assert.equal(a.p, 0.5);
    s.close();
  });

  test('zero-retention rows bucket empty — a featured query reads the prior', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    const id = await journal(s, { contextId, route: 'a' });
    // persistText: false — the outcome row keeps NULL features_json
    await recordOutcome(s, report(id, { rounds: 1 }), { ...verified, persistText: false });
    const source = await statsSource(dir, { tablePath: tp });
    const featured = source.statsFor(route('a'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(featured.n, 0);
    assert.equal(featured.p, 0.5);
    // the empty bucket still sees the row — aggregates survive retention
    const empty = source.statsFor(route('a'), {}, FORMULA, TABLE);
    assert.equal(empty.n, 1);
    s.close();
  });

  test('the formula’s success predicate labels the rows', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    // merged after three rounds — a failure under merged_first_round
    const id = await journal(s, { contextId, route: 'a' });
    await recordOutcome(s, report(id, { result: 'merged', rounds: 3 }), verified);
    const source = await statsSource(dir, { tablePath: tp });
    const first = source.statsFor(route('a'), { risk: false, tier: 'pro' }, FORMULA, TABLE);
    assert.equal(first.n, 1);
    assert.equal(first.p, 1 / 3); // a failure under merged_first_round: (0 + 1) / (1 + 2)
    const any = parseFormulaText(FORMULA_MD.replace('merged_first_round', 'merged'), 'm.md');
    const merged = source.statsFor(route('a'), { risk: false, tier: 'pro' }, any, TABLE);
    assert.equal(merged.n, 1);
    assert.equal(merged.p, (1 + 1) / (1 + 2));
    s.close();
  });

  test('every failure mode degrades to the prior, never throws', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    // a live verified row sits in this namespace — the no-text source
    // must still answer the prior because no hash can join it
    const id = await journal(s, { contextId, route: 'a', features: {} });
    await recordOutcome(s, report(id, { rounds: 1 }), verified);
    // no formula text — the hash cannot be computed, no row can join
    // (inline: the helper's default would fill the text back in)
    const noText = await routerOutcomeStats({ dir, tablePath: tp, table: TABLE });
    const prior = noText.statsFor(route('a'), {}, FORMULA, TABLE);
    assert.deepEqual(prior, { p: 0.5, n: 0 });
    // an empty bucket in the same namespace reads the row — the prior
    // above is the missing-hash path, not an empty store
    const live = await statsSource(dir, { tablePath: tp });
    const stats = live.statsFor(route('a'), {}, FORMULA, TABLE);
    assert.equal(stats.n, 1);
    s.close();
  });
});

/** The fake judge — fixed answers, the decideRoute seam. */
function fakeJudge(answers: Record<string, JudgeAnswer>): JudgeFacade {
  return {
    decide: async () => {
      const res: DecideResult = {
        answers,
        model: 'fake-judge',
        latencyMs: 1,
        lowConfidence: [],
      };
      return res;
    },
  };
}

describe('decideRoute — the score shape ranks on live stats', () => {
  test('verified outcomes pick the better route over table order', async () => {
    const s = await store();
    const dir = scratchDir();
    const tp = tablePath();
    const contextId = decisionContextId(dir, { tablePath: tp });
    // route a failed after fixes, route b merged first round — both in
    // the {risk:false, tier:pro} bucket the judge's answers will form
    const a = await journal(s, { contextId, route: 'a', features: { risk: false, tier: 'pro' } });
    await recordOutcome(
      s,
      report(a, { result: 'failed', rounds: 2, cost: 0.4, wallMs: 5000 }),
      verified
    );
    const b = await journal(s, { contextId, route: 'b', features: { risk: false, tier: 'pro' } });
    await recordOutcome(
      s,
      report(b, { result: 'merged', rounds: 1, cost: 0.1, wallMs: 1000 }),
      verified
    );

    const judge = fakeJudge({
      risk: { type: 'noul', noul: 0.2, confidence: 0.9, decidedBy: 'fake' },
      tier: {
        type: 'choice',
        choice: 'pro',
        probabilities: { pro: 0.9 },
        confidence: 0.9,
        decidedBy: 'fake',
      },
    });
    const { decision, decisionId } = await decideRoute({
      dir,
      table: TABLE,
      tablePath: tp,
      task: {},
      text: 'ship the feature',
      formula: FORMULA_PATH,
      judge,
    });
    // b's verified p beats a's — the formula picks it over table order
    assert.equal(decision.route?.name, 'b');
    assert.equal(decision.picked, 'formula');
    const scores = decision.formula?.scores ?? [];
    const sa = scores.find(sc => sc.route === 'a');
    const sb = scores.find(sc => sc.route === 'b');
    assert.equal(sa?.n, 1);
    assert.equal(sb?.n, 1);
    assert.ok(sa !== undefined && sb !== undefined && sb.p > sa.p);
    // the journal stored the effective features — the bucket statsFor read
    const row = s.db.$client
      .prepare('select features_json from decisions where decision_id = ?')
      .get(decisionId) as { features_json: string | null };
    assert.equal(row.features_json, '{"risk":false,"tier":"pro"}');
    s.close();
  });
});

/** The built CLI — the live smoke a user actually touches. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

describe('live smoke — seeded outcomes rank a real route decision', () => {
  test('brouter route --formula score.md picks the verified winner', async t => {
    if (!existsSync(CLI)) return t.skip();
    const s = await store();
    try {
      // the CLI's cwd — no .git, no config: contextId is the table's
      const plain = scratchDir();
      const tablePath = join(scratch, 'smoke-routes.toml');
      writeFileSync(
        tablePath,
        [
          'kind = "route"',
          'version = 1',
          '',
          '[routes.a]',
          'chain = [{ provider = "a" }]',
          '',
          '[routes.b]',
          'chain = [{ provider = "b" }]',
          '',
        ].join('\n')
      );
      // seed against the EXACT objects the CLI will hash: the parsed
      // table and the formula file's bytes
      const cliTable = readRouteTable(tablePath);
      const contextId = decisionContextId(plain, { tablePath });
      const seed = async (routeName: string, over: Partial<OutcomeReport>) => {
        const decisionId = newDecisionId();
        assert.equal(
          await recordDecision(s, {
            kind: 'route',
            contextId,
            decisionId,
            taskText: 'smoke task',
            features: {},
            route: routeName,
            provider: routeName,
            model: 'm',
            table: cliTable,
            formulaText: FORMULA_MD,
          }),
          true
        );
        await recordOutcome(s, report(decisionId, over), verified);
      };
      await seed('a', { result: 'failed', rounds: 2 });
      await seed('b', { result: 'merged', rounds: 1 });

      const xdg = join(scratch, 'xdg-empty');
      const proc = spawnSync(
        process.execPath,
        [
          CLI,
          'route',
          'ship',
          'the',
          'feature',
          '--routes',
          tablePath,
          '--formula',
          FORMULA_PATH,
          '--json',
        ],
        {
          encoding: 'utf8',
          cwd: plain,
          env: { ...process.env, XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: xdg },
        }
      );
      assert.equal(proc.status, 0, proc.stderr);
      const decision = JSON.parse(proc.stdout);
      // b's verified p (2/3) beats a's (1/3) — table order would pick a
      assert.equal(decision.route.name, 'b');
      assert.equal(decision.picked, 'formula');
      const scores = decision.formula?.scores ?? [];
      const sb = scores.find((sc: { route: string }) => sc.route === 'b');
      assert.equal(sb?.n, 1);
      assert.ok(sb.p > 0.5);
    } finally {
      s.close();
    }
  });
});
