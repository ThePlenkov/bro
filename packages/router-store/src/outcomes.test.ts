import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { migrateStore } from './migrations.ts';
import {
  findDecisions,
  getDecision,
  linkDecision,
  newDecisionId,
  recordDecision,
  type DecisionInput,
} from './decisions.ts';
import {
  expireTaskText,
  outcomeStats,
  pendingOutcomeCount,
  recallDecisions,
  recordOutcome,
  type OutcomeReport,
} from './outcomes.ts';
import { openStore, type StoreHandle } from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'router-outcomes-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A migrated store handle — every case starts from a fresh file. */
async function store(name: string): Promise<Extract<StoreHandle, { ok: true }>> {
  const path = join(scratch, `${name}.db`);
  const handle = openStore(path);
  assert.ok(handle.ok, handle.ok ? '' : handle.reason);
  migrateStore(handle.db);
  return handle as Extract<StoreHandle, { ok: true }>;
}

/** Journal one route decision, returning its id. */
async function journal(
  s: Extract<StoreHandle, { ok: true }>,
  over: Partial<DecisionInput> = {}
): Promise<string> {
  const decisionId = newDecisionId();
  const ok = await recordDecision(s, {
    kind: 'route',
    contextId: 'repo:test',
    decisionId,
    taskText: 'fix the flaky test',
    task: { title: 'fix the flaky test' },
    features: { kind: 'bug', files: 2 },
    route: 'claude',
    provider: 'anthropic',
    model: 'sonnet',
    ...over,
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

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test('identical task text produces distinct decision ids', async () => {
  const s = await store('ids');
  const a = await journal(s, { taskText: 'same task' });
  const b = await journal(s, { taskText: 'same task' });
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});

test('recordDecision is idempotent on a duplicate id; getDecision reads the row', async () => {
  const s = await store('dedup');
  const id = newDecisionId();
  const input: DecisionInput = { kind: 'route', contextId: 'c', decisionId: id, taskText: 'x' };
  assert.equal(await recordDecision(s, input), true);
  assert.equal(await recordDecision(s, input), true); // no-op, not an error
  const row = await getDecision(s.db, id);
  assert.equal(row?.contextId, 'c');
  assert.equal(row?.taskText, 'x');
});

test('linkDecision repairs worker/run/bead links and findDecisions joins on them', async () => {
  const s = await store('links');
  const id = await journal(s, { taskText: 'route me' });
  await linkDecision(s, id, { beadId: 'bro-1', worker: 'w1', runId: 'r1', pr: '42' });
  const row = await getDecision(s.db, id);
  assert.equal(row?.beadId, 'bro-1');
  assert.equal(row?.worker, 'w1');
  assert.equal(row?.runId, 'r1');
  assert.equal(row?.pr, '42');
  assert.equal((await findDecisions(s.db, { beadId: 'bro-1' })).length, 1);
  assert.equal((await findDecisions(s.db, { pr: '42' })).length, 1);
});

// ---------------------------------------------------------------------------
// recordOutcome
// ---------------------------------------------------------------------------

test('unknown decision ids fail loudly', async () => {
  const s = await store('unknown');
  await assert.rejects(recordOutcome(s, report('no-such-id')), /unknown decision id/);
});

test('invalid results and measures are rejected before anything persists', async () => {
  const s = await store('invalid');
  const id = await journal(s);
  await assert.rejects(
    recordOutcome(s, report(id, { result: 'bogus' as never })),
    /outcome result must be/
  );
  await assert.rejects(recordOutcome(s, report(id, { rounds: -1 })), /rounds must be/);
  await assert.rejects(recordOutcome(s, report(id, { cost: Number.NaN })), /cost must be/);
  await assert.rejects(recordOutcome(s, report(id, { wallMs: 1.5 })), /wallMs must be/);
  // nothing landed — the decision still has no outcome
  assert.equal(await pendingOutcomeCount(s.db), 0);
});

test('an unverified report stays pending and never counts in stats', async () => {
  const s = await store('pending');
  const id = await journal(s, { taskText: 'pending task' });
  const res = await recordOutcome(s, report(id));
  assert.equal(res.applied, 'pending');
  assert.equal(res.verified, false);
  assert.equal(res.outcome?.verified, 0);
  assert.equal(await pendingOutcomeCount(s.db), 1);
  const stats = await outcomeStats(s.db, { contextId: 'repo:test' });
  assert.equal(stats.n, 0);
  assert.equal(stats.p, 0.5);
});

test('a verified report inserts; identical event redelivery is a no-op', async () => {
  const s = await store('verified');
  const id = await journal(s);
  const rep = report(id, { eventId: 'evt-1' });
  const first = await recordOutcome(s, rep, verified);
  assert.equal(first.applied, 'inserted');
  assert.equal(first.verified, true);
  const again = await recordOutcome(s, rep, verified);
  assert.equal(again.applied, 'duplicate-event');
  assert.equal(again.outcome?.eventId, 'evt-1');
});

test('unverified reports cannot replace a verified row', async () => {
  const s = await store('shield');
  const id = await journal(s);
  await recordOutcome(s, report(id, { eventId: 'v1', sourceRevision: 2 }), verified);
  const forged = await recordOutcome(
    s,
    report(id, { result: 'failed', eventId: 'u1', sourceId: 'attacker', sourceRevision: 9 })
  );
  assert.equal(forged.applied, 'unverified-vs-verified');
  assert.equal(forged.outcome?.result, 'merged');
});

test('stale revisions from the same source are ignored; newer ones apply', async () => {
  const s = await store('revisions');
  const id = await journal(s);
  await recordOutcome(
    s,
    report(id, { eventId: 'r5', sourceRevision: 5, result: 'failed', rounds: 3 }),
    verified
  );
  const stale = await recordOutcome(
    s,
    report(id, { eventId: 'r3', sourceRevision: 3, result: 'merged' }),
    verified
  );
  assert.equal(stale.applied, 'stale-revision');
  assert.equal(stale.outcome?.result, 'failed');
  const fresh = await recordOutcome(
    s,
    report(id, { eventId: 'r7', sourceRevision: 7, result: 'merged' }),
    verified
  );
  assert.equal(fresh.applied, 'updated');
  assert.equal(fresh.outcome?.result, 'merged');
});

test('a verified merge supersedes fleet failure; unrelated signals cannot undo it', async () => {
  const s = await store('precedence');
  const id = await journal(s);
  await recordOutcome(
    s,
    report(id, { result: 'failed', eventId: 'fleet-1', sourceId: 'bro:fleet', sourceRevision: 1 }),
    verified
  );
  const merged = await recordOutcome(
    s,
    report(id, { result: 'merged', eventId: 'merge-1', sourceId: 'bro:act', sourceRevision: 1 }),
    verified
  );
  assert.equal(merged.applied, 'updated');
  assert.equal(merged.outcome?.result, 'merged');
  const later = await recordOutcome(
    s,
    report(id, { result: 'failed', eventId: 'fleet-2', sourceId: 'bro:fleet', sourceRevision: 2 }),
    verified
  );
  assert.equal(later.applied, 'merged-stands');
  assert.equal(later.outcome?.result, 'merged');
});

test('conflicting verified terminal reports from unrelated sources are retained', async () => {
  const s = await store('conflict');
  const id = await journal(s);
  await recordOutcome(
    s,
    report(id, { result: 'failed', eventId: 'a1', sourceId: 'src-a', sourceRevision: 1 }),
    verified
  );
  const conflict = await recordOutcome(
    s,
    report(id, { result: 'parked', eventId: 'b1', sourceId: 'src-b', sourceRevision: 1 }),
    verified
  );
  assert.equal(conflict.applied, 'conflict-retained');
  assert.equal(conflict.outcome?.result, 'failed');
});

// ---------------------------------------------------------------------------
// stats read model
// ---------------------------------------------------------------------------

test('outcomeStats applies the Beta(1,1) prior under both predicates', async () => {
  const s = await store('stats');
  const id1 = await journal(s, { taskText: 'first' });
  const id2 = await journal(s, { taskText: 'second' });
  // merged first round → success under both predicates
  await recordOutcome(s, report(id1, { rounds: 1 }), verified);
  // merged after fixes → merged yes, merged_first_round no
  await recordOutcome(s, report(id2, { rounds: 4 }), verified);

  const first = await outcomeStats(s.db, {
    contextId: 'repo:test',
    route: 'claude',
    success: 'merged_first_round',
  });
  assert.equal(first.n, 2);
  assert.equal(first.successes, 1);
  assert.equal(first.failures, 1);
  assert.equal(first.p, (1 + 1) / (2 + 2));

  const any = await outcomeStats(s.db, {
    contextId: 'repo:test',
    route: 'claude',
    success: 'merged',
  });
  assert.equal(any.successes, 2);
  assert.equal(any.p, 0.75);
});

test('missing rounds are excluded under merged_first_round but count under merged', async () => {
  const s = await store('norounds');
  const id = await journal(s);
  await recordOutcome(s, report(id, { rounds: undefined }), verified);
  const first = await outcomeStats(s.db, { contextId: 'repo:test', success: 'merged_first_round' });
  assert.equal(first.n, 0);
  assert.equal(first.excluded, 1);
  const any = await outcomeStats(s.db, { contextId: 'repo:test', success: 'merged' });
  assert.equal(any.n, 1);
  assert.equal(any.successes, 1);
});

test('zero verified rows yield the prior 0.5 with n=0', async () => {
  const s = await store('empty');
  await journal(s);
  const stats = await outcomeStats(s.db, { contextId: 'repo:test' });
  assert.equal(stats.n, 0);
  assert.equal(stats.p, 0.5);
  assert.equal(stats.excluded, 0);
});

// ---------------------------------------------------------------------------
// retention + recall
// ---------------------------------------------------------------------------

test('recallDecisions finds retained task text through FTS (verified only)', async () => {
  const s = await store('recall');
  const id = await journal(s, { taskText: 'fix the flaky websocket reconnect test' });
  // pending reports never vote — recall stays empty until verified
  await recordOutcome(s, report(id, { rounds: 1 }));
  assert.equal(
    (await recallDecisions(s.db, { contextId: 'repo:test', text: 'websocket reconnect' })).length,
    0
  );
  await recordOutcome(s, report(id, { eventId: 'v1', rounds: 1 }), verified);
  const hits = await recallDecisions(s.db, { contextId: 'repo:test', text: 'websocket reconnect' });
  assert.deepEqual(hits, [id]);
});

test('expireTaskText strips text + FTS while numeric aggregates survive', async () => {
  const s = await store('expire');
  const id = await journal(s, { taskText: 'secret task text here' });
  await recordOutcome(s, report(id, { rounds: 2 }), verified);
  // age both rows beyond the retention window
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  s.db.$client.prepare('update outcomes set at = ? where decision_id = ?').run(old, id);
  s.db.$client.prepare('update decisions set created_at = ? where decision_id = ?').run(old, id);

  const res = await expireTaskText(s, { retentionDays: 30 });
  assert.ok(res.decisions >= 1);
  assert.ok(res.outcomes >= 1);
  assert.ok(res.fts >= 1);
  const stats = await outcomeStats(s.db, { contextId: 'repo:test', success: 'merged', since: 0 });
  assert.equal(stats.n, 1); // numeric outcome retained
  const row = await getDecision(s.db, id);
  assert.equal(row?.taskText, null);
  assert.equal(row?.route, 'claude'); // structured fields stay
  assert.equal(
    (await recallDecisions(s.db, { contextId: 'repo:test', text: 'secret task' })).length,
    0
  );
});
