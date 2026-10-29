import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  busSocketPath,
  busSubscribe,
  startBusBroker,
  type BusBroker,
  type BusRecord,
} from './bus.ts';
import { gitTry } from './git.ts';
import { emitLifecycle, type LifecycleEvent } from './lifecycle.ts';
import { emitWorkerSilent, lifecycleBusEvent } from './lifecycle-bus.ts';

/** A git repo in a tmpdir — the bus socket derives from its common
 *  dir, so a real broker bound there is what production publishes to. */
async function withRepoBroker(
  fn: (dir: string, broker: BusBroker, events: BusRecord[]) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-lifecycle-bus-'));
  gitTry(['-C', dir, 'init']);
  const broker = await startBusBroker(dir);
  const events: BusRecord[] = [];
  const sub = await busSubscribe(
    broker.socketPath,
    {},
    {
      onEvent: e => events.push(e as BusRecord),
    }
  );
  try {
    await fn(dir, broker, events);
  } finally {
    sub.close();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Wait for the fired-and-forgotten publish to round-trip — same
 *  poll-not-sleep convention as bus.test.ts's waitFor. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

const row = (over: Partial<LifecycleEvent>): LifecycleEvent => ({
  ts: '2026-10-29T00:00:00.000Z',
  kind: 'claim',
  actor: 'a',
  session: 's',
  ...over,
});

describe('lifecycleBusEvent', () => {
  test('spawn → worker.spawned with attempt fields in payload', () => {
    const ev = lifecycleBusEvent(
      row({
        kind: 'spawn',
        bead: 'bro-x1',
        to: 'spawned',
        detail: {
          via: 'agents',
          agent: 'native-ab12',
          backend: 'native',
          worktree: '/repo--bro-x1',
          log: '/home/native-ab12.log',
          runId: 'cd34',
          provider: 'devin',
          model: 'm1',
        },
      })
    );
    assert.deepEqual(ev, {
      topic: 'worker',
      kind: 'spawned',
      key: 'native-ab12',
      source: 'agents',
      ref: '/repo--bro-x1',
      payload: {
        agentId: 'native-ab12',
        bead: 'bro-x1',
        runId: 'cd34',
        worktree: '/repo--bro-x1',
        log: '/home/native-ab12.log',
        backend: 'native',
        provider: 'devin',
        model: 'm1',
      },
    });
  });

  test('agent-exit → worker.exited with code/cause; actor fills a missing detail.agent', () => {
    const ev = lifecycleBusEvent(
      row({
        kind: 'agent-exit',
        bead: 'bro-x1',
        actor: 'native-ab12',
        from: 'running',
        to: 'exited',
        detail: { via: 'agents', backend: 'native', code: 0, cause: 'ok', runId: 'cd34' },
      })
    );
    assert.equal(ev?.topic, 'worker');
    assert.equal(ev?.kind, 'exited');
    assert.equal(ev?.key, 'native-ab12');
    assert.deepEqual(ev?.payload, {
      agentId: 'native-ab12',
      bead: 'bro-x1',
      code: 0,
      runId: 'cd34',
      cause: 'ok',
      backend: 'native',
    });
  });

  test('worktree created/reused → added, removed → removed', () => {
    const made = lifecycleBusEvent(
      row({
        kind: 'worktree',
        bead: 'bro-x1',
        to: 'created',
        detail: { via: 'work', worktree: '/w', branch: 'work/bro-x1' },
      })
    );
    assert.equal(made?.topic, 'worktree');
    assert.equal(made?.kind, 'added');
    assert.equal(made?.key, '/w');
    assert.equal(made?.ref, '/w');
    assert.deepEqual(made?.payload, { path: '/w', branch: 'work/bro-x1', bead: 'bro-x1' });

    const reused = lifecycleBusEvent(
      row({ kind: 'worktree', to: 'reused', detail: { worktree: '/w' } })
    );
    assert.equal(reused?.kind, 'added');

    const gone = lifecycleBusEvent(
      row({
        kind: 'worktree',
        to: 'removed',
        detail: { via: 'cleanup', worktree: '/w', reason: 'merged' },
      })
    );
    assert.equal(gone?.kind, 'removed');
    assert.equal(gone?.source, 'cleanup');
  });

  test('uncovered kinds and agent-less rows stay journal-only', () => {
    assert.equal(lifecycleBusEvent(row({ kind: 'claim', bead: 'bro-x1' })), undefined);
    assert.equal(lifecycleBusEvent(row({ kind: 'gate', pr: 3 })), undefined);
    assert.equal(lifecycleBusEvent(row({ kind: 'spawn', detail: { via: 'agents' } })), undefined);
    assert.equal(
      lifecycleBusEvent(row({ kind: 'worktree', to: 'created', detail: {} })),
      undefined
    );
  });

  test('the lifecycle `to` (target state) never becomes the envelope `to` (recipient)', () => {
    const ev = lifecycleBusEvent(
      row({ kind: 'spawn', to: 'spawned', detail: { agent: 'a1', worktree: '/w' } })
    );
    assert.equal(ev?.to, undefined);
    const exit = lifecycleBusEvent(
      row({ kind: 'agent-exit', actor: 'a1', to: 'blocked', detail: { code: 1 } })
    );
    assert.equal(exit?.to, undefined);
  });
});

describe('lifecycle → bus mirror', () => {
  test('emitLifecycle rows arrive as envelopes; unmapped kinds do not', async () => {
    await withRepoBroker(async (dir, _broker, events) => {
      emitLifecycle(dir, { kind: 'claim', bead: 'bro-x1', to: 'in_progress' });
      emitLifecycle(dir, {
        kind: 'spawn',
        bead: 'bro-x1',
        to: 'spawned',
        detail: { via: 'agents', agent: 'native-ab12', worktree: '/w', log: '/l', runId: 'r1' },
      });
      emitLifecycle(dir, {
        kind: 'worktree',
        bead: 'bro-x1',
        to: 'removed',
        detail: { via: 'work', worktree: '/w' },
      });
      await waitFor('the mapped envelopes', () => events.length >= 2);
      // let any straggler land — an unmapped row sneaking into the feed
      // is a regression worth failing on, not a race worth hiding
      await new Promise(r => setTimeout(r, 100));
      assert.equal(events.length, 2);
      assert.equal(events[0]!.topic, 'worker');
      assert.equal(events[0]!.kind, 'spawned');
      assert.equal(events[0]!.key, 'native-ab12');
      assert.equal(events[1]!.topic, 'worktree');
      assert.equal(events[1]!.kind, 'removed');
      assert.equal(events[1]!.key, '/w');
    });
  });

  test('emitWorkerSilent lands worker.silent keyed on the agent', async () => {
    await withRepoBroker(async (dir, _broker, events) => {
      emitWorkerSilent(dir, { bead: 'bro-x1', silentMin: 42, agentId: 'native-ab12', log: '/l' });
      await waitFor('worker.silent', () => events.length === 1);
      assert.equal(events[0]!.topic, 'worker');
      assert.equal(events[0]!.kind, 'silent');
      assert.equal(events[0]!.key, 'native-ab12');
      assert.equal(events[0]!.ref, '/l');
      assert.deepEqual(events[0]!.payload, {
        agentId: 'native-ab12',
        bead: 'bro-x1',
        silentMin: 42,
      });
    });
  });

  test('no broker — emits resolve silently, never throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-lifecycle-nobus-'));
    gitTry(['-C', dir, 'init']);
    try {
      emitLifecycle(dir, {
        kind: 'spawn',
        to: 'spawned',
        detail: { agent: 'a1', worktree: '/w' },
      });
      emitWorkerSilent(dir, { bead: 'b1', silentMin: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
