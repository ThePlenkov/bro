import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claimsFacade } from './claims-store.ts';
import { openLedgerStore } from './ledger-store.ts';
import type { TaskRow, TaskStore } from './tasks.ts';
import type { SessionKey } from './ledger.ts';

const root = mkdtempSync(join(tmpdir(), 'bro-claims-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function facade(over: Parameters<typeof claimsFacade>[0] = {}) {
  n += 1;
  return claimsFacade({
    dbPath: join(root, `claims-${n}.db`),
    env: { BRO_HOOK_SPOOL: '0', HOME: root, XDG_STATE_HOME: join(root, 'xdg') },
    bootTimeMs: () => 0,
    ...over,
  });
}

const A: SessionKey = { host: 'claude', sid: 'sess-a' };
const B: SessionKey = { host: 'claude', sid: 'sess-b' };

test('shared claims coexist; exclusive refuses a second live holder', async () => {
  const c = facade();
  assert.equal((await c.claim('worktree:/repo', A)).ok, true);
  assert.equal((await c.claim('worktree:/repo', B)).ok, true);
  const rows = await c.list({ resource: 'worktree:/repo' });
  assert.equal(rows.length, 2);

  assert.equal((await c.claim('role:orchestrator@p1', A)).ok, true);
  const refused = await c.claim('role:orchestrator@p1', B);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict?.sid, 'sess-a');
  // same-session re-claim renews instead of conflicting
  assert.equal((await c.claim('role:orchestrator@p1', A)).ok, true);
});

test('release drops only the caller’s row', async () => {
  const c = facade();
  await c.claim('branch:main', A);
  await c.claim('branch:main', B);
  await c.release('branch:main', A);
  const rows = await c.list({ resource: 'branch:main' });
  assert.deepEqual(
    rows.map(r => r.sid),
    ['sess-b']
  );
});

test('TTL expiry + dead pid sweeps the row; live pid keeps it', async () => {
  let clock = 1_000_000;
  const alive = new Set<number>([22]);
  const c = facade({
    pidAliveFn: pid => alive.has(pid),
    now: () => clock,
  });
  await c.claim('pr:1', A, { ttlMs: 60_000, pid: 11 }); // dead pid
  await c.claim('pr:2', A, { ttlMs: 60_000, pid: 22 }); // live pid
  clock += 120_000; // both TTLs expired
  const rows = await c.list({ resource: 'pr:' });
  // dead pid → swept even though its lease merely expired; live pid
  // survives (provable holder death is the release rule)
  assert.deepEqual(
    rows.map(r => r.resource),
    ['pr:2']
  );
});

test('pid-less TTL-expired claim dies with a silent session', async () => {
  let clock = 5_000_000;
  const c = facade({ now: () => clock, pidAliveFn: () => true });
  await c.claim('path:src/**', A, { ttlMs: 60_000 });
  assert.equal((await c.list({ resource: 'path:src/**' })).length, 1);
  clock += 120_000; // past ttl; no session row → dead
  assert.equal((await c.list({ resource: 'path:src/**' })).length, 0);
});

test('task:* delegates to the tasks store — bd claim stays truth', async () => {
  const beads = new Map<string, TaskRow>([
    ['bro-1', { id: 'bro-1', status: 'open' } as TaskRow],
    ['bro-2', { id: 'bro-2', status: 'in_progress', assignee: 'other-agent' } as TaskRow],
    ['bro-3', { id: 'bro-3', status: 'in_progress', assignee: 'me' } as TaskRow],
    ['bro-4', { id: 'bro-4', status: 'in_progress', assignee: 'me' } as TaskRow],
  ]);
  const claimed: string[] = [];
  const reopened: string[] = [];
  const ts = {
    list: () => [],
    ready: () => [],
    get: (id: string) => beads.get(id),
    create: () => ({ id: 'x' }) as TaskRow,
    update: () => {},
    claim: (id: string) => {
      claimed.push(id);
      beads.set(id, { ...beads.get(id)!, status: 'in_progress', assignee: 'me' });
    },
    reopen: (id: string) => {
      reopened.push(id);
      beads.set(id, { ...beads.get(id)!, status: 'open', assignee: '' });
    },
    close: () => {},
    remove: () => {},
    note: () => {},
    children: () => [],
    deps: () => [],
    neighbors: () => [],
    link: () => {},
    actor: () => 'me',
  } as unknown as TaskStore;

  const dbPath = join(root, 'claims-task.db');
  const c = facade({ dbPath, tasksForDir: () => ts });
  const dir = { dir: '/repo' };
  // unassigned → delegates claim()
  assert.equal((await c.claim('task:bro-1', A, dir)).ok, true);
  assert.deepEqual(claimed, ['bro-1']);
  // foreign-held → conflict naming the assignee, no write
  const refused = await c.claim('task:bro-2', A, dir);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict?.sid, 'other-agent');
  // ours → idempotent ok
  assert.equal((await c.claim('task:bro-3', A, dir)).ok, true);
  // missing → ok:false, no conflict
  assert.deepEqual(await c.claim('task:nope', A, dir), { ok: false, conflict: null });

  // release resolves the project dir from the session row's cwd —
  // seed one through the store's append path on the same db file
  const h = await openLedgerStore(dbPath);
  assert.equal(h.ok, true);
  if (!h.ok) return;
  try {
    await h.store.append([
      {
        kind: 'session',
        host: A.host,
        sid: A.sid,
        cwd: '/repo',
        mode: 'code',
        state: 'live',
        lastSeen: Date.now(),
      },
    ]);
    // ours → reopen clears the assignee
    await c.release('task:bro-3', A);
    assert.deepEqual(reopened, ['bro-3']);
    // a foreign-held bead is never cleared by our release
    await c.release('task:bro-2', A);
    assert.deepEqual(reopened, ['bro-3']);
  } finally {
    h.store.close();
  }
});

test('claims list filters by session and resource prefix', async () => {
  const c = facade();
  await c.claim('worktree:/w1', A);
  await c.claim('worktree:/w2', B);
  await c.claim('branch:x', A);
  const mine = await c.list({ session: A });
  assert.equal(mine.length, 2);
  const wt = await c.list({ resource: 'worktree:' });
  assert.equal(wt.length, 2);
});
