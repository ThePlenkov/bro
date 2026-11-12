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

let taskFixtureN = 0;
/** Shared task:* fixture — an in-memory TaskStore whose actor is
 *  `actor` (default 'me'), behind a fresh claims facade on its own
 *  ledger db so release's session-cwd lookup has a file to seed. */
function taskClaimsFixture(actor = 'me') {
  taskFixtureN += 1;
  const beads = new Map<string, TaskRow>([
    ['bro-1', { id: 'bro-1', status: 'open' } as TaskRow],
    ['bro-2', { id: 'bro-2', status: 'in_progress', assignee: 'other-agent' } as TaskRow],
    ['bro-3', { id: 'bro-3', status: 'in_progress', assignee: 'me' } as TaskRow],
    ['bro-4', { id: 'bro-4', status: 'in_progress', assignee: 'me' } as TaskRow],
    ['bro-5', { id: 'bro-5', status: 'closed', assignee: 'me' } as TaskRow],
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
    actor: () => actor,
  } as unknown as TaskStore;
  const dbPath = join(root, `claims-task-${taskFixtureN}.db`);
  const dirs: string[] = [];
  const c = facade({ dbPath, tasksForDir: d => (dirs.push(d), ts) });
  return { c, dbPath, beads, claimed, reopened, ts, dirs };
}

test('task:* claim delegates to the tasks store — bd claim stays truth', async () => {
  const f = taskClaimsFixture();
  const dir = { dir: '/repo' };
  // unassigned → delegates claim()
  assert.equal((await f.c.claim('task:bro-1', A, dir)).ok, true);
  assert.deepEqual(f.claimed, ['bro-1']);
  // foreign-held → conflict naming the assignee, no write
  const refused = await f.c.claim('task:bro-2', A, dir);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict?.sid, 'other-agent');
  // ours → idempotent ok
  assert.equal((await f.c.claim('task:bro-3', A, dir)).ok, true);
  // missing → ok:false, no conflict
  assert.deepEqual(await f.c.claim('task:nope', A, dir), { ok: false, conflict: null });
});

test('task:* claim with an unverifiable actor still attempts the claim', async () => {
  // actor '' is "unverifiable, never a match" — empty assignee must
  // not short-circuit to ok without calling ts.claim
  const f = taskClaimsFixture('');
  const dir = { dir: '/repo' };
  assert.equal((await f.c.claim('task:bro-1', A, dir)).ok, true);
  assert.deepEqual(f.claimed, ['bro-1']);
  // a standing foreign assignee still conflicts — '' never matches
  const refused = await f.c.claim('task:bro-2', A, dir);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict?.sid, 'other-agent');
});

test('task:* release reopens only our claim, resolved via the session cwd', async () => {
  const f = taskClaimsFixture();
  // release resolves the project dir from the session row's cwd —
  // seed one through the store's append path on the same db file
  const h = await openLedgerStore(f.dbPath);
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
    await f.c.release('task:bro-3', A);
    assert.deepEqual(f.reopened, ['bro-3']);
    // a foreign-held bead is never cleared by our release
    await f.c.release('task:bro-2', A);
    assert.deepEqual(f.reopened, ['bro-3']);
  } finally {
    h.store.close();
  }
});

test('task:* release honors opts.dir without a session cwd', async () => {
  const f = taskClaimsFixture();
  // no session row at all — the dir opt alone resolves the store,
  // the same fallback claim() already had
  await f.c.release('task:bro-3', A, { dir: '/repo' });
  assert.deepEqual(f.reopened, ['bro-3']);
});

test('task:* prefers the session cwd over opts.dir', async () => {
  const f = taskClaimsFixture();
  const h = await openLedgerStore(f.dbPath);
  assert.equal(h.ok, true);
  if (!h.ok) return;
  try {
    await h.store.append([
      {
        kind: 'session',
        host: A.host,
        sid: A.sid,
        cwd: '/session-repo',
        mode: 'code',
        state: 'live',
        lastSeen: Date.now(),
      },
    ]);
    // the CLI always passes its cwd — the session's ledger cwd is the
    // authority, so a claim from another directory still lands in the
    // session's project
    await f.c.claim('task:bro-1', A, { dir: '/cli-dir' });
    assert.deepEqual(f.dirs, ['/session-repo']);
  } finally {
    h.store.close();
  }
});

test('task:* claim on a closed task does not report a fresh hold', async () => {
  const f = taskClaimsFixture();
  // bro-5 stays assigned to us but is closed — ok:true would claim a
  // hold that does not exist
  const res = await f.c.claim('task:bro-5', A, { dir: '/repo' });
  assert.equal(res.ok, false);
  assert.equal(f.claimed.includes('bro-5'), false);
});

test('task:* release propagates a failed reopen', async () => {
  const f = taskClaimsFixture();
  f.ts.reopen = () => {
    throw new Error('bd store down');
  };
  // a swallowed reopen would print `released` while the assignee stays
  await assert.rejects(() => f.c.release('task:bro-3', A, { dir: '/repo' }), /bd store down/);
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

test('resource prefix matching treats LIKE metachars literally', async () => {
  const c = facade();
  await c.claim('path:src/my_file', A);
  await c.claim('path:src/myXfile', B);
  // unescaped, the `_` in my_file would wildcard-match myXfile
  const rows = await c.list({ resource: 'path:src/my_file' });
  assert.deepEqual(
    rows.map(r => r.sid),
    ['sess-a']
  );
});

test('resource prefix matching is case-sensitive', async () => {
  const c = facade();
  await c.claim('path:src/Foo.ts', A);
  await c.claim('path:src/foo.ts', B);
  // LIKE would fold ASCII case and return both; claim identity is exact
  const rows = await c.list({ resource: 'path:src/Foo' });
  assert.deepEqual(
    rows.map(r => r.sid),
    ['sess-a']
  );
});
