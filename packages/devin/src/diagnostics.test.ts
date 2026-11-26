import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { diagnoseDevinRateLimit, inspectDevinAccount } from './diagnostics.ts';

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

async function createRateLimitFixture(root: string): Promise<{
  proc: string;
  locks: string;
  storePath: string;
  journal: string;
}> {
  const proc = join(root, 'proc');
  const locks = join(root, 'locks');
  const data = join(root, 'data', 'devin', 'cli');
  mkdirSync(join(proc, '201', 'fd'), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(proc, '201', 'cmdline'), 'devin\0-r\0');
  writeFileSync(join(proc, '201', 'environ'), 'PATH=/bin\0');
  writeFileSync(join(locks, 'last-lock.lock'), '201');
  const { DatabaseSync } = await import('node:sqlite');
  const storePath = join(data, 'sessions.db');
  const db = new DatabaseSync(storePath);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)');
  db.exec(
    'CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT)'
  );
  db.exec("INSERT INTO sessions VALUES ('s1', 'swe-2-max')");
  db.prepare('INSERT INTO message_nodes VALUES (?, ?, ?)').run(
    9,
    's1',
    JSON.stringify({ content: 'Reached free model rate limit. reset in 20 minutes' })
  );
  db.close();
  const journal = join(root, 'serve-turns.jsonl');
  writeFileSync(
    journal,
    '{"event":"conductor.turn"}\n{"event":"acp.spawn"}\n{"event":"conductor.deadloop"}\n{"event":"http.429"}\n'
  );
  return { proc, locks, storePath, journal };
}

describe('Devin account diagnostics', () => {
  test('counts unmanaged interactive and ACP consumers separately from bro workers', () => {
    const proc = temp('bro-diag-proc-');
    const locks = temp('bro-diag-locks-');
    try {
      for (const [pid, env, cmd, cwd] of [
        [101, 'BRO_AGENT_ID=worker-1\0', 'devin\0acp\0', '/repo/worker'],
        [102, 'PATH=/bin\0', 'devin\0-r\0', '/repo'],
        [103, 'PATH=/bin\0', 'devin\0acp\0--model\0swe-2-high\0', '/repo/other'],
      ] as const) {
        mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
        writeFileSync(join(proc, String(pid), 'cmdline'), cmd);
        writeFileSync(join(proc, String(pid), 'environ'), env);
        symlinkSync(cwd, join(proc, String(pid), 'cwd'));
      }
      writeFileSync(join(locks, 'managed.lock'), '101');
      writeFileSync(join(locks, 'interactive.lock'), '102');
      const result = inspectDevinAccount({ procDir: proc, locksDir: locks });
      assert.equal(result.ok, true);
      assert.equal(result.managed, 1);
      assert.equal(result.unmanaged, 2);
      assert.deepEqual(
        result.consumers.map(row => row.pid),
        [101, 102, 103]
      );
      assert.deepEqual(result.consumers[1]?.sessionLocks, ['interactive']);
    } finally {
      rmSync(proc, { recursive: true, force: true });
      rmSync(locks, { recursive: true, force: true });
    }
  });
});

describe('Devin rate-limit reconstruction', () => {
  test('joins the latest rate-limit message with live consumers and serve activity', async () => {
    const root = temp('bro-diag-store-');
    const fixture = await createRateLimitFixture(root);
    try {
      const result = await diagnoseDevinRateLimit({
        env: { HOME: root, XDG_DATA_HOME: join(root, 'data') },
        procDir: fixture.proc,
        locksDir: fixture.locks,
        storePath: fixture.storePath,
        serveTurnsPath: fixture.journal,
        limit: 20,
      });
      assert.equal(result.ok, true);
      assert.match(result.lastLock?.message ?? '', /Reached free model rate limit/);
      assert.equal(result.lastLock?.sessionId, 's1');
      assert.equal(result.lastLock?.model, 'swe-2-max');
      assert.equal(result.consumers.unmanaged, 1);
      assert.deepEqual(result.serveTurns, { turns: 1, spawns: 1, deadloops: 1, rateLimits: 1 });
      assert.equal(
        result.activeSessions.length,
        0,
        'lock listing may be unverifiable in the minimal proc fixture'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails open when forensic sources are unavailable', async () => {
    const result = await diagnoseDevinRateLimit({
      storePath: '/missing/sessions.db',
      procDir: '/missing/proc',
      locksDir: '/missing/locks',
      serveTurnsPath: '/missing/serve-turns.jsonl',
    });
    assert.equal(result.ok, false);
    assert.equal(result.lastLock, undefined);
    assert.ok(result.warnings.length >= 3);
  });
});
